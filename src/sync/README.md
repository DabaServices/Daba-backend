# Cross network synchronization

Two isolated networks, each with its own database, both accepting writes. A change is sent to the
peer **before** the local transaction commits: the peer accepting it is a precondition of the
commit, so a change either exists on both networks or on neither.

Both networks run **this same image**. Only the environment variables differ.

```
Network A backend  ──►  Network B backend
Network A backend  ◄──  Network B backend
```

## How it works

1. **Capture.** Global Sequelize hooks describe every change as a row level operation. Nothing is
   written to disk and no repository or service calls anything — a write that happens is captured.
2. **Batch.** Every operation produced inside one transaction is collected into a single batch and
   is replayed on the peer inside a single transaction: all of it lands, or none of it.
3. **Send before commit.** The transaction's `commit` is the send point. The batch goes to the
   peer, and only a `200` lets the local commit proceed. Anything else throws, the caller rolls
   back, and neither side keeps the change.
4. **Order.** Each batch carries a gapless `sequence` reserved under a row lock inside the same
   transaction. The receiver keeps a cursor per source node and refuses anything that is not the
   next number with a `409`.
5. **No loops.** Statements produced by a replay carry a suppression flag, so the hooks ignore
   them. Data created locally on either side still flows normally.

## Payload

`POST /sync/batches`, header `x-sync-token`.

### Structure

```json
{
  "sync_metadata": {
    "batch_id": "<uuid>",
    "source_node": "<string, 1-64>",
    "sequence": "<integer >= 1>",
    "generated_at": "<ISO-8601>"
  },
  "operations": [
    {
      "table": "<table name, 1-128>",
      "action": "UPSERT | UPDATE | DELETE",
      "data": { "<column_name>": "<value>" },
      "update_fields": ["<column_name>"],
      "conflict_fields": ["<column_name>"]
    }
  ]
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `batch_id` | yes | UUID of one source transaction. Resending it is acknowledged as a duplicate. |
| `source_node` | yes | Who produced the batch. A node rejects a batch bearing its own id. |
| `sequence` | yes | Gapless counter per source node, starting at 1. Out of order is refused with `409`. |
| `generated_at` | yes | When the batch was sent. |
| `table` | yes | Physical table name. Unknown or non replicated tables are refused with `400`. |
| `action` | yes | `UPSERT`, `UPDATE` or `DELETE`. |
| `data` | yes | Flat `column -> value` dictionary. Unknown columns are refused with `400`. |
| `update_fields` | no | `UPSERT` only: which columns to overwrite on conflict. Omitted means every column in `data`. |
| `conflict_fields` | no | `UPSERT` only: the conflict target. Omitted means the primary key. |

`data` carries no type wrappers — the ORM casts each value using the model definition, which is why
the payload stays readable next to the DDL. What each action carries:

- **UPSERT** — every column that was written, identifiers included.
- **UPDATE** — the primary key columns plus only the columns that changed. Nothing else is touched.
- **DELETE** — the primary key columns only.

`operations` needs at least one entry and is applied in array order, inside a single transaction:
all of it lands, or none of it.

### Example

One transaction that closed a report, corrected a line on it, and removed a comment:

```json
{
  "sync_metadata": {
    "batch_id": "6f1c2a4e-9b3d-4c7a-8f21-0d5e7b9a1c33",
    "source_node": "network_a",
    "sequence": 42,
    "generated_at": "2026-08-23T09:14:07.512Z"
  },
  "operations": [
    {
      "table": "reports",
      "action": "UPSERT",
      "data": {
        "id": 7,
        "unit_id": 12,
        "report_date": "2026-08-23",
        "status": "CLOSED",
        "closed_by": "1234567"
      },
      "update_fields": ["status", "closed_by"],
      "conflict_fields": ["id"]
    },
    {
      "table": "report_items",
      "action": "UPDATE",
      "data": {
        "report_id": 7,
        "material_id": 88,
        "quantity": 15
      }
    },
    {
      "table": "comments",
      "action": "DELETE",
      "data": { "id": 301 }
    }
  ]
}
```

The `UPDATE` names `report_id` and `material_id` because they are the composite primary key, and
`quantity` because that is the only column that changed — `unit_price`, `notes` and everything else
on that row are left exactly as the receiver already had them.

### Response

The status is the whole answer; the body carries nothing the sender reads.

| Status | Meaning |
| --- | --- |
| `200` | applied, or already known. The sender commits. |
| `400` | unknown table or column, or the batch came back to its own producer. |
| `401` | bad or missing `x-sync-token`. |
| `409` | out of order: the batch is not the next sequence for that node. |

Anything other than `200` makes the sender roll back, so the change is saved on neither side.

## Setup

### 1. Database — run once per network

```
psql -f sql/daba-sync-ddl.sql
```

### 2. Identity ranges — run once per network, before the first sync

Both networks create rows, so every serial primary key needs its own range of values. Give each
network a stride and a distinct offset, for every replicated table with a serial key:

```sql
-- Network A
ALTER SEQUENCE shoval.reports_id_seq INCREMENT BY 2 RESTART WITH 1;
-- Network B
ALTER SEQUENCE shoval.reports_id_seq INCREMENT BY 2 RESTART WITH 2;
```

A row then keeps the same id on both sides, so foreign keys stay valid after replication.
Never `setval` a sequence to the peer's `MAX(id)` — that walks a node into the other one's range.

### 3. Environment

Pick one shared secret and use it on both sides.

**Network A backend**

```env
SYNC_ENABLED=true
SYNC_NODE_ID=network_a
SYNC_PEER_URL=https://network-b-backend.internal:3000
SYNC_TOKEN=<shared secret>
```

**Network B backend**

```env
SYNC_ENABLED=true
SYNC_NODE_ID=network_b
SYNC_PEER_URL=https://network-a-backend.internal:3000
SYNC_TOKEN=<shared secret>
```

`SYNC_NODE_ID` is permanent. Reusing or renaming one resets the receiver's cursor and will make
batches look like duplicates or gaps.

### 4. Optional

| Variable | Default | Purpose |
| --- | --- | --- |
| `SYNC_TABLES` | all mapped tables | comma separated allowlist of physical tables. Must match on both nodes. |
| `SYNC_HTTP_TIMEOUT_MS` | `10000` | how long a local transaction may wait for the peer |

Leave `SYNC_ENABLED` unset to run the backend exactly as before — the module stays inert.

## What this costs

The guarantee is bought with availability and throughput, and the trade is not subtle:

- **The peer being down makes this node read-only.** No write commits without a `200`.
- **Writes serialize.** The outbound sequence is reserved under a lock on a single row that is held
  for the whole round trip, so a node commits roughly one write per round trip.
- **Locks are held across the network.** A slow peer holds row locks for up to
  `SYNC_HTTP_TIMEOUT_MS`, which is why that timeout should stay small.
- **It is not truly atomic.** If the peer commits and its answer is lost, the sender rolls back and
  the peer keeps a change the sender does not have. The duplicate test is on `batch_id` rather than
  on the sequence number so the sender's next batch is not silently swallowed — it surfaces as a
  `409` instead of vanishing.
- **Simultaneous edits to the same row on both networks still diverge.** There is no conflict
  resolution; each side ends up holding the other's value.

## Writes that bypass the guarantee

Capture is built on Sequelize model hooks, so a change made with `sequelize.query(...)`, a stored
procedure or `psql` is never seen and never replicated.

A write to a replicated table **must run inside a transaction** — outside one there is no commit to
hold back, so the statement is refused before it runs rather than saved on one network only.
