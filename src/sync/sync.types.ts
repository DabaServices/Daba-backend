import { SYNC_ACTIONS } from "./sync.constants";

export type SyncAction = (typeof SYNC_ACTIONS)[keyof typeof SYNC_ACTIONS];

/**
 * A single row level change expressed in physical database terms, so the payload stays readable
 * next to the DDL and stays generic: `data` is a flat dictionary of column name -> value.
 *
 * UPSERT - `data` holds every column that was written (identifiers included).
 * UPDATE - `data` holds the primary key columns plus only the columns that changed.
 * DELETE - `data` holds the primary key columns only.
 */
export type SyncOperation = {
    table: string;
    action: SyncAction;
    data: Record<string, unknown>;
    /** UPSERT only: columns to overwrite when the row already exists. Absent means "every column in `data`". */
    update_fields?: string[];
    /** UPSERT only: columns forming the conflict target. Absent means the primary key. */
    conflict_fields?: string[];
};

export type SyncMetadata = {
    /** Identity of the source transaction. Replays of the same batch are ignored by the receiver. */
    batch_id: string;
    source_node: string;
    /** Gapless counter per source node. The receiver refuses to apply batch N + 2 before N + 1. */
    sequence: number;
    generated_at: string;
};

/** The unit of transfer: one source transaction, applied by the receiver as all-or-nothing. */
export type SyncBatch = {
    sync_metadata: SyncMetadata;
    operations: SyncOperation[];
};
