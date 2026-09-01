export const SYNC_ACTIONS = {
    UPSERT: "UPSERT",
    UPDATE: "UPDATE",
    DELETE: "DELETE"
} as const;

export const SYNC_ROUTE = "sync";
export const SYNC_BATCHES_PATH = "batches";
export const SYNC_TOKEN_HEADER = "x-sync-token";

/** Tables owned by the sync machinery itself: never captured, never replicated. */
export const SYNC_INTERNAL_TABLES = ["sync_sequences"];

/** Set on every Sequelize call made while replaying an inbound batch so the capture hooks ignore it (loop breaker). */
export const SYNC_SUPPRESS = "syncSuppress" as const;

/** Lazily attached to a Sequelize transaction: collects every operation captured inside it. */
export const SYNC_BATCH = Symbol.for("daba.sync.batch");
