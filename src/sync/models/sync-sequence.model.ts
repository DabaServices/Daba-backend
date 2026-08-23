import { Column, DataType, Model, PrimaryKey, Table } from "sequelize-typescript";

export type ISyncSequence = {
    nodeId: string;
    lastSequence: number;
    lastBatchId?: string | null;
    updatedAt?: Date;
};

/**
 * The highest batch sequence known for a node.
 * For a remote node it is the last batch applied from it; for this node it is the last batch emitted.
 * Both readings are transactional, which is what makes delivery exactly-once and strictly ordered.
 */
@Table({ tableName: "sync_sequences", timestamps: false })
export class SyncSequence extends Model<ISyncSequence> {
    @PrimaryKey
    @Column({ field: "node_id", type: DataType.STRING(64) })
    declare nodeId: string;

    @Column({ field: "last_sequence", type: DataType.BIGINT })
    declare lastSequence: number;

    @Column({ field: "last_batch_id", type: DataType.UUID })
    declare lastBatchId: string | null;

    @Column({ field: "updated_at", type: DataType.DATE })
    declare updatedAt: Date;
}
