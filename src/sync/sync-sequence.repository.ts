import { ConflictException, Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/sequelize";
import { Transaction } from "sequelize";
import { ISyncSequence, SyncSequence } from "./models/sync-sequence.model";

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
     */
    async reserveInbound(nodeId: string, sequence: number, batchId: string, transaction: Transaction): Promise<SequenceDecision> {
        const cursor = await this.lock(nodeId, transaction);

        if (sequence <= cursor.lastSequence) return SEQUENCE_DECISION.DUPLICATE;
        if (sequence > cursor.lastSequence + 1) {
            throw new ConflictException(
                `Batch ${sequence} from "${nodeId}" arrived before ${cursor.lastSequence + 1}; deliver the missing batches first`
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

    async list(): Promise<ISyncSequence[]> {
        const rows = await this.sequenceModel.findAll({ order: [["nodeId", "ASC"]] });

        return rows.map((row) => ({
            nodeId: row.nodeId,
            lastSequence: Number(row.lastSequence),
            lastBatchId: row.lastBatchId
        }));
    }

    private async lock(nodeId: string, transaction: Transaction): Promise<{ lastSequence: number }> {
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

        return { lastSequence: Number(cursor!.lastSequence) };
    }

    private advance(nodeId: string, sequence: number, batchId: string, transaction: Transaction): Promise<unknown> {
        return this.sequenceModel.update(
            { lastSequence: sequence, lastBatchId: batchId, updatedAt: new Date() },
            { where: { nodeId }, transaction }
        );
    }
}
