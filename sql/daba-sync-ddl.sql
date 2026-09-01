-- Cross network synchronization.
-- Deployed identically on both networks; only the environment differs.

-- Highest batch sequence known for a node: for the remote node the last batch applied from it,
-- for this node the last batch emitted. Updated in the same transaction as the batch itself,
-- which is what makes delivery exactly-once and strictly ordered.
CREATE TABLE IF NOT EXISTS shoval.sync_sequences (
    node_id varchar(64) NOT NULL,
    last_sequence bigint DEFAULT 0 NOT NULL,
    last_batch_id uuid,
    updated_at timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT sync_sequences_pkey PRIMARY KEY (node_id)
);

-- Generated identifiers.
-- Both networks accept new rows, so every serial primary key must own a disjoint range of values,
-- otherwise two independently created rows end up with the same id and overwrite each other.
-- Give each node a stride and a distinct offset once, before the first sync, and run it for every
-- replicated table that has a serial primary key. A row then keeps the same id on both sides,
-- which is what keeps foreign keys valid after replication.
--
-- On network A:
--   ALTER SEQUENCE shoval.reports_id_seq INCREMENT BY 2 RESTART WITH 1;
-- On network B:
--   ALTER SEQUENCE shoval.reports_id_seq INCREMENT BY 2 RESTART WITH 2;
--
-- Never setval a sequence to the peer's MAX(id): that walks the node into the other node's range.
