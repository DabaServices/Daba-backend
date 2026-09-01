import { ConflictException, Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/sequelize";
import { Transaction } from "sequelize";
import { SyncSequence } from "./models/sync-sequence.model";

export const SEQUENCE_DECISION = {
    ACCEPT: "ACCEPT",
    DUPLICATE: "DUPLICATE"
} as const;

export type SequenceDecision = (typeof SEQUENCE_DECISION)[keyof typeof SEQUENCE_DECISION];

@Injectable()
export class SyncSequenceRepository {
    constructor(@InjectModel(SyncSequence) private readonly sequenceModel: typeof SyncSequence) { }

    /**
     * Decides what to do with an inbound batch and, when it is the expected one, advances the cursor.
     * Runs inside the caller's transaction under a row lock, so a batch is applied exactly once
     * and never before its predecessor.
     *
     * The duplicate test is on the batch id rather than the number: a sender that rolled back after
     * the peer had already committed reuses the number, and that batch must not be mistaken for a replay.
     */
    async reserveInbound(nodeId: string, sequence: number, batchId: string, transaction: Transaction): Promise<SequenceDecision> {
        const cursor = await this.lock(nodeId, transaction);

        if (batchId === cursor.lastBatchId) return SEQUENCE_DECISION.DUPLICATE;
        if (sequence !== cursor.lastSequence + 1) {
            throw new ConflictException(
                `Batch ${sequence} from "${nodeId}" is out of order; expected ${cursor.lastSequence + 1}`
            );
        }

        await this.advance(nodeId, sequence, batchId, transaction);
        return SEQUENCE_DECISION.ACCEPT;
    }

    /** Hands out the next outbound number for this node. Transactional, so the series never has holes. */
    async nextOutbound(nodeId: string, batchId: string, transaction: Transaction): Promise<number> {
        const cursor = await this.lock(nodeId, transaction);
        const sequence = cursor.lastSequence + 1;

        await this.advance(nodeId, sequence, batchId, transaction);
        return sequence;
    }

    private async lock(nodeId: string, transaction: Transaction): Promise<{ lastSequence: number; lastBatchId: string | null }> {
        await this.sequenceModel.findOrCreate({
            where: { nodeId },
            defaults: { nodeId, lastSequence: 0, lastBatchId: null, updatedAt: new Date() },
            transaction
        });

        const cursor = await this.sequenceModel.findOne({
            where: { nodeId },
            lock: Transaction.LOCK.UPDATE,
            transaction
        });

        return { lastSequence: Number(cursor!.lastSequence), lastBatchId: cursor!.lastBatchId };
    }

    private advance(nodeId: string, sequence: number, batchId: string, transaction: Transaction): Promise<unknown> {
        return this.sequenceModel.update(
            { lastSequence: sequence, lastBatchId: batchId, updatedAt: new Date() },
            { where: { nodeId }, transaction }
        );
    }
}
