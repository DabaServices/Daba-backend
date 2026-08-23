-- Cross network synchronization.
-- Deployed identically on both networks and on the bridge server; only the environment differs.

CREATE SEQUENCE IF NOT EXISTS shoval.sync_outbox_id_seq AS bigint START WITH 1;

-- One row per captured change. Rows sharing batch_id belong to a single source transaction,
-- become visible together and are delivered together.
CREATE TABLE IF NOT EXISTS shoval.sync_outbox (
    id bigint DEFAULT nextval('shoval.sync_outbox_id_seq'::regclass) NOT NULL,
    batch_id uuid NOT NULL,
    source_node varchar(64) NOT NULL,
    table_name varchar(128) NOT NULL,
    action varchar(16) NOT NULL,
    data jsonb NOT NULL,
    update_fields jsonb,
    conflict_fields jsonb,
    status varchar(16) DEFAULT 'PENDING' NOT NULL,
    sequence bigint,
    attempts integer DEFAULT 0 NOT NULL,
    next_attempt_at timestamptz DEFAULT now() NOT NULL,
    last_error text,
    created_at timestamptz DEFAULT now() NOT NULL,
    sent_at timestamptz,
    CONSTRAINT sync_outbox_pkey PRIMARY KEY (id),
    CONSTRAINT sync_outbox_action_check CHECK (action IN ('UPSERT', 'UPDATE', 'DELETE')),
    CONSTRAINT sync_outbox_status_check CHECK (status IN ('PENDING', 'SENT'))
);

-- The relay always reads the oldest undelivered row, then the rest of its batch.
CREATE INDEX IF NOT EXISTS sync_outbox_pending_idx ON shoval.sync_outbox USING btree (id) WHERE status = 'PENDING';
CREATE INDEX IF NOT EXISTS sync_outbox_batch_idx ON shoval.sync_outbox USING btree (batch_id);
CREATE INDEX IF NOT EXISTS sync_outbox_sent_idx ON shoval.sync_outbox USING btree (sent_at) WHERE status = 'SENT';

-- Highest batch sequence known for a node: for a remote node the last batch applied from it,
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
