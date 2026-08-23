import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from "@nestjs/common";
import { SyncConfig } from "./sync.config";
import { SYNC_TOKEN_HEADER } from "./sync.constants";
import { ClaimedBatch, SyncOutboxRepository } from "./sync-outbox.repository";
import { SyncBatch } from "./sync.types";

const HOUR_IN_MS = 60 * 60 * 1_000;

/**
 * Drains the outbox towards the next hop, one batch at a time and strictly in order.
 *
 * A failed batch is retried with exponential backoff and is never overtaken by a younger one:
 * a later batch may depend on it, so head-of-line blocking is the correct behaviour here.
 * Delivery is at-least-once; the receiver's sequence cursor turns it into exactly-once.
 */
@Injectable()
export class SyncRelayService implements OnApplicationBootstrap, OnModuleDestroy {
    private readonly logger = new Logger(SyncRelayService.name);
    private timer: NodeJS.Timeout | null = null;
    private draining = false;
    private nextPurgeAt = 0;

    constructor(
        private readonly config: SyncConfig,
        private readonly outbox: SyncOutboxRepository
    ) { }

    onApplicationBootstrap(): void {
        if (!this.config.relayEnabled) return;

        this.timer = setInterval(() => void this.drain(), this.config.pollIntervalMs);
        this.timer.unref();

        if (this.config.sendEnabled) {
            this.logger.log(`Relaying "${this.config.nodeId}" to ${this.config.batchesUrl} every ${this.config.pollIntervalMs}ms`);
        } else {
            this.logger.warn(`Outbound delivery is paused by SYNC_SEND_ENABLED; changes keep queueing in the outbox`);
        }
    }

    onModuleDestroy(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }

    async drain(): Promise<void> {
        if (this.draining) return;
        this.draining = true;

        try {
            // While sending is paused nothing is lost, only delayed: the outbox keeps its order.
            if (this.config.sendEnabled) while (await this.deliverNext()) continue;

            await this.purge();
        } catch (error) {
            this.logger.error("Relay cycle failed", error instanceof Error ? error.stack : String(error));
        } finally {
            this.draining = false;
        }
    }

    /** Returns true when a batch was delivered and the next one may be attempted. */
    private async deliverNext(): Promise<boolean> {
        const claimed = await this.outbox.claimNextBatch();
        if (!claimed) return false;

        try {
            await this.send(claimed.batch);
            await this.outbox.markDelivered(claimed.batch.sync_metadata.batch_id);
            return true;
        } catch (error) {
            await this.reschedule(claimed, error);
            return false;
        }
    }

    private async send(batch: SyncBatch): Promise<void> {
        const response = await fetch(this.config.batchesUrl, {
            method: "POST",
            headers: { "content-type": "application/json", [SYNC_TOKEN_HEADER]: this.config.token },
            body: JSON.stringify(batch),
            signal: AbortSignal.timeout(this.config.httpTimeoutMs)
        });

        if (!response.ok) {
            throw new Error(`Peer answered ${response.status}: ${(await response.text()).slice(0, 500)}`);
        }
    }

    private async reschedule({ batch, attempts }: ClaimedBatch, error: unknown): Promise<void> {
        const attempt = attempts + 1;
        const retryIn = Math.min(this.config.retryBaseMs * 2 ** attempts, this.config.retryMaxMs);
        const reason = error instanceof Error ? error.message : String(error);
        const description = `batch ${batch.sync_metadata.batch_id} (#${batch.sync_metadata.sequence}), attempt ${attempt}, retrying in ${retryIn}ms: ${reason}`;

        await this.outbox.markFailed(batch.sync_metadata.batch_id, attempt, reason, retryIn);

        if (attempt >= this.config.alertAfterAttempts) this.logger.error(`Synchronization is stalled on ${description}`);
        else this.logger.warn(`Failed to deliver ${description}`);
    }

    private async purge(): Promise<void> {
        if (Date.now() < this.nextPurgeAt) return;
        this.nextPurgeAt = Date.now() + HOUR_IN_MS;

        const removed = await this.outbox.purgeDelivered();
        if (removed > 0) this.logger.log(`Purged ${removed} delivered outbox rows`);
    }
}
