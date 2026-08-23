import { Column, DataType, Model, PrimaryKey, Table } from "sequelize-typescript";
import type { SyncAction, SyncOutboxStatus } from "../sync.types";

export type ISyncOutbox = {
    id?: number;
    batchId: string;
    sourceNode: string;
    tableName: string;
    action: SyncAction;
    data: Record<string, unknown>;
    updateFields?: string[] | null;
    conflictFields?: string[] | null;
    status: SyncOutboxStatus;
    sequence?: number | null;
    attempts?: number;
    nextAttemptAt?: Date;
    lastError?: string | null;
    createdAt?: Date;
    sentAt?: Date | null;
};

/**
 * One row per captured change. Rows sharing a `batchId` were produced by a single source
 * transaction, so they become visible together and are delivered together.
 */
@Table({ tableName: "sync_outbox", timestamps: false })
export class SyncOutbox extends Model<ISyncOutbox> {
    @PrimaryKey
    @Column({ type: DataType.BIGINT, autoIncrement: true })
    declare id: number;

    @Column({ field: "batch_id", type: DataType.UUID })
    declare batchId: string;

    @Column({ field: "source_node", type: DataType.STRING(64) })
    declare sourceNode: string;

    @Column({ field: "table_name", type: DataType.STRING(128) })
    declare tableName: string;

    @Column(DataType.STRING(16))
    declare action: SyncAction;

    @Column(DataType.JSONB)
    declare data: Record<string, unknown>;

    @Column({ field: "update_fields", type: DataType.JSONB })
    declare updateFields: string[] | null;

    @Column({ field: "conflict_fields", type: DataType.JSONB })
    declare conflictFields: string[] | null;

    @Column(DataType.STRING(16))
    declare status: SyncOutboxStatus;

    /** Assigned by the relay when the batch is first claimed, so retries reuse the same number. */
    @Column(DataType.BIGINT)
    declare sequence: number | null;

    @Column(DataType.INTEGER)
    declare attempts: number;

    @Column({ field: "next_attempt_at", type: DataType.DATE })
    declare nextAttemptAt: Date;

    @Column({ field: "last_error", type: DataType.TEXT })
    declare lastError: string | null;

    @Column({ field: "created_at", type: DataType.DATE })
    declare createdAt: Date;

    @Column({ field: "sent_at", type: DataType.DATE })
    declare sentAt: Date | null;
}
