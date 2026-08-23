import { Injectable } from "@nestjs/common";
import { InjectConnection, InjectModel } from "@nestjs/sequelize";
import { Op, Transaction } from "sequelize";
import { Sequelize } from "sequelize-typescript";
import { ISyncOutbox, SyncOutbox } from "./models/sync-outbox.model";
import { SyncConfig } from "./sync.config";
import { OUTBOX_STATUSES } from "./sync.constants";
import { SyncSequenceRepository } from "./sync-sequence.repository";
import { SyncBatch } from "./sync.types";

export type ClaimedBatch = {
    batch: SyncBatch;
    attempts: number;
};

export type OutboxBacklog = {
    batches: number;
    operations: number;
    oldestPendingAt: Date | null;
    headAttempts: number;
    headLastError: string | null;
};

@Injectable()
export class SyncOutboxRepository {
    constructor(
        @InjectModel(SyncOutbox) private readonly outboxModel: typeof SyncOutbox,
        @InjectConnection() private readonly sequelize: Sequelize,
        private readonly sequences: SyncSequenceRepository,
        private readonly config: SyncConfig
    ) { }

    /** Appends captured changes. Always called with the business transaction so the outbox commits with the data. */
    async append(rows: ISyncOutbox[], transaction?: Transaction): Promise<void> {
        await this.outboxModel.bulkCreate(rows, { transaction });
    }

    /** Stores a batch received by a bridge node untouched, so its origin, identity and order survive the extra hop. */
    async appendForwarded(batch: SyncBatch, transaction: Transaction): Promise<void> {
        const { batch_id, source_node, sequence } = batch.sync_metadata;

        await this.append(
            batch.operations.map((operation) => ({
                batchId: batch_id,
                sourceNode: source_node,
                sequence,
                tableName: operation.table,
                action: operation.action,
                data: operation.data,
                updateFields: operation.update_fields ?? null,
                conflictFields: operation.conflict_fields ?? null,
                status: OUTBOX_STATUSES.PENDING,
                attempts: 0,
                nextAttemptAt: new Date(),
                createdAt: new Date()
            })),
            transaction
        );
    }

    /**
     * Takes the oldest undelivered batch. Returns null when the queue is empty or when the head is
     * still backing off - the head is never skipped, because a later batch may depend on it.
     */
    claimNextBatch(): Promise<ClaimedBatch | null> {
        return this.sequelize.transaction(async (transaction) => {
            const head = await this.outboxModel.findOne({
                where: { status: OUTBOX_STATUSES.PENDING },
                order: [["id", "ASC"]],
                lock: Transaction.LOCK.UPDATE,
                transaction
            });

            if (!head || head.nextAttemptAt.getTime() > Date.now()) return null;

            const rows = await this.outboxModel.findAll({
                where: { batchId: head.batchId, status: OUTBOX_STATUSES.PENDING },
                order: [["id", "ASC"]],
                transaction
            });

            const sequence = head.sequence
                ? Number(head.sequence)
                : await this.assignSequence(head.batchId, head.sourceNode, transaction);

            return {
                attempts: head.attempts,
                batch: {
                    sync_metadata: {
                        batch_id: head.batchId,
                        source_node: head.sourceNode,
                        sequence,
                        generated_at: head.createdAt.toISOString()
                    },
                    operations: rows.map((row) => ({
                        table: row.tableName,
                        action: row.action,
                        data: row.data,
                        ...(row.updateFields ? { update_fields: row.updateFields } : {}),
                        ...(row.conflictFields ? { conflict_fields: row.conflictFields } : {})
                    }))
                }
            };
        });
    }

    async markDelivered(batchId: string): Promise<void> {
        await this.outboxModel.update(
            { status: OUTBOX_STATUSES.SENT, sentAt: new Date(), lastError: null },
            { where: { batchId, status: OUTBOX_STATUSES.PENDING } }
        );
    }

    async markFailed(batchId: string, attempts: number, reason: string, retryIn: number): Promise<void> {
        await this.outboxModel.update(
            { attempts, lastError: reason.slice(0, 2_000), nextAttemptAt: new Date(Date.now() + retryIn) },
            { where: { batchId, status: OUTBOX_STATUSES.PENDING } }
        );
    }

    async purgeDelivered(): Promise<number> {
        const cutoff = new Date(Date.now() - this.config.retentionDays * 24 * 60 * 60 * 1_000);

        return this.outboxModel.destroy({
            where: { status: OUTBOX_STATUSES.SENT, sentAt: { [Op.lt]: cutoff } }
        });
    }

    async backlog(): Promise<OutboxBacklog> {
        const pending = { status: OUTBOX_STATUSES.PENDING };
        const [operations, batches, head] = await Promise.all([
            this.outboxModel.count({ where: pending }),
            this.outboxModel.count({ where: pending, distinct: true, col: "batch_id" }),
            this.outboxModel.findOne({ where: pending, order: [["id", "ASC"]] })
        ]);

        return {
            batches,
            operations,
            oldestPendingAt: head?.createdAt ?? null,
            headAttempts: head?.attempts ?? 0,
            headLastError: head?.lastError ?? null
        };
    }

    private async assignSequence(batchId: string, sourceNode: string, transaction: Transaction): Promise<number> {
        const sequence = await this.sequences.nextOutbound(sourceNode, batchId, transaction);
        await this.outboxModel.update({ sequence }, { where: { batchId }, transaction });

        return sequence;
    }
}
