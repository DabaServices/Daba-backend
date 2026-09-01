import { BadRequestException, Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";
import { InjectConnection } from "@nestjs/sequelize";
import { Sequelize } from "sequelize-typescript";
import { SyncConfig } from "./sync.config";
import { SyncExecutorService } from "./sync-executor.service";
import { SEQUENCE_DECISION, SyncSequenceRepository } from "./sync-sequence.repository";
import { SyncBatch } from "./sync.types";

/**
 * Entry point for batches arriving from the other network. The cursor reservation and the writes
 * share one transaction, so a batch is applied at most once and never out of order. The sender is
 * holding its own transaction open waiting for the answer, so returning is the commit signal.
 */
@Injectable()
export class SyncInboundService {
    private readonly logger = new Logger(SyncInboundService.name);

    constructor(
        @InjectConnection() private readonly sequelize: Sequelize,
        private readonly config: SyncConfig,
        private readonly sequences: SyncSequenceRepository,
        private readonly executor: SyncExecutorService
    ) { }

    async receive(batch: SyncBatch): Promise<void> {
        if (!this.config.enabled) throw new ServiceUnavailableException("Synchronization is disabled on this node");

        const { batch_id, source_node, sequence } = batch.sync_metadata;
        if (source_node === this.config.nodeId) {
            throw new BadRequestException("A batch cannot be delivered back to the node that produced it");
        }

        const applied = await this.sequelize.transaction(async (transaction) => {
            const decision = await this.sequences.reserveInbound(source_node, sequence, batch_id, transaction);
            if (decision === SEQUENCE_DECISION.DUPLICATE) return false;

            await this.executor.run(batch.operations, transaction);
            return true;
        });

        this.logger.log(
            `${applied ? "APPLIED" : "DUPLICATE"} batch ${batch_id} (#${sequence} from ${source_node}, ${batch.operations.length} operations)`
        );
    }
}
