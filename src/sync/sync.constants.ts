export const SYNC_ACTIONS = {
    UPSERT: "UPSERT",
    UPDATE: "UPDATE",
    DELETE: "DELETE"
} as const;

export const SYNC_INBOUND_MODES = {
    /** Backend node: inbound batches are written into the business tables. */
    APPLY: "APPLY",
    /** Bridge server: inbound batches are queued and relayed to the next hop untouched. */
    FORWARD: "FORWARD"
} as const;

export const SYNC_RESULTS = {
    APPLIED: "APPLIED",
    FORWARDED: "FORWARDED",
    DUPLICATE: "DUPLICATE"
} as const;

export const OUTBOX_STATUSES = {
    PENDING: "PENDING",
    SENT: "SENT"
} as const;

export const SYNC_ROUTE = "sync";
export const SYNC_BATCHES_PATH = "batches";
export const SYNC_TOKEN_HEADER = "x-sync-token";

/** Tables owned by the sync machinery itself: never captured, never replicated. */
export const SYNC_INTERNAL_TABLES = ["sync_outbox", "sync_sequences"];

/** Set on every Sequelize call made while replaying an inbound batch so the capture hooks ignore it (loop breaker). */
export const SYNC_SUPPRESS = "syncSuppress" as const;

/** Lazily attached to a Sequelize transaction so every write it contains lands in a single outbox batch. */
export const SYNC_BATCH_ID = Symbol.for("daba.sync.batchId");
