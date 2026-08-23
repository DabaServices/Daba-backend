import { BadRequestException, Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";
import { InjectConnection } from "@nestjs/sequelize";
import { Sequelize } from "sequelize-typescript";
import { SyncConfig } from "./sync.config";
import { SYNC_INBOUND_MODES, SYNC_RESULTS } from "./sync.constants";
import { SyncExecutorService } from "./sync-executor.service";
import { SyncOutboxRepository } from "./sync-outbox.repository";
import { SEQUENCE_DECISION, SyncSequenceRepository } from "./sync-sequence.repository";
import { SyncBatch, SyncReceipt, SyncStatus } from "./sync.types";

/**
 * Entry point for batches arriving from the other network.
 *
 * A backend node applies them to its tables; the bridge node queues them for the next hop. Both
 * paths share the same guarantees, because both run inside one transaction together with the
 * sequence reservation: a batch is applied at most once, and never out of order.
 */
@Injectable()
export class SyncInboundService {
    private readonly logger = new Logger(SyncInboundService.name);

    constructor(
        @InjectConnection() private readonly sequelize: Sequelize,
        private readonly config: SyncConfig,
        private readonly sequences: SyncSequenceRepository,
        private readonly executor: SyncExecutorService,
        private readonly outbox: SyncOutboxRepository
    ) { }

    async receive(batch: SyncBatch): Promise<SyncReceipt> {
        if (!this.config.enabled) throw new ServiceUnavailableException("Synchronization is disabled on this node");

        const { batch_id, source_node, sequence } = batch.sync_metadata;
        if (source_node === this.config.nodeId) {
            throw new BadRequestException("A batch cannot be delivered back to the node that produced it");
        }

        const receipt = await this.sequelize.transaction(async (transaction) => {
            const decision = await this.sequences.reserveInbound(source_node, sequence, batch_id, transaction);
            if (decision === SEQUENCE_DECISION.DUPLICATE) {
                return { status: SYNC_RESULTS.DUPLICATE, batch_id, operations: 0 };
            }

            if (this.config.inboundMode === SYNC_INBOUND_MODES.FORWARD) {
                await this.outbox.appendForwarded(batch, transaction);
                return { status: SYNC_RESULTS.FORWARDED, batch_id, operations: batch.operations.length };
            }

            await this.executor.run(batch.operations, transaction);
            return { status: SYNC_RESULTS.APPLIED, batch_id, operations: batch.operations.length };
        });

        this.logger.log(`${receipt.status} batch ${batch_id} (#${sequence} from ${source_node}, ${receipt.operations} operations)`);
        return receipt;
    }

    async status(): Promise<SyncStatus> {
        const [backlog, sequences] = await Promise.all([this.outbox.backlog(), this.sequences.list()]);

        return {
            node_id: this.config.nodeId,
            inbound_mode: this.config.inboundMode,
            relay_enabled: this.config.relayEnabled,
            send_enabled: this.config.sendEnabled,
            peer_url: this.config.peerUrl,
            pending_batches: backlog.batches,
            pending_operations: backlog.operations,
            oldest_pending_at: backlog.oldestPendingAt?.toISOString() ?? null,
            head_attempts: backlog.headAttempts,
            head_last_error: backlog.headLastError,
            sequences: sequences.map((entry) => ({
                node_id: entry.nodeId,
                last_sequence: entry.lastSequence,
                last_batch_id: entry.lastBatchId ?? null
            }))
        };
    }
}
