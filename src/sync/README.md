# Cross network synchronization

Two isolated networks, each with its own database, both accepting writes. This module keeps them
converged without anyone having to remember to call it.

Every participant runs **this same image**. Only the environment variables differ.

```
Network A backend  ──►  Bridge A→B  ──►  Network B backend
Network A backend  ◄──  Bridge B→A  ◄──  Network B backend
```

## How it works

1. **Capture.** Global Sequelize hooks write one `sync_outbox` row per change, inside the same
   transaction as the change itself. No repository or service calls anything — a write that
   commits is captured, a write that rolls back leaves nothing behind.
2. **Batch.** Every row produced by one source transaction shares a `batch_id`. They become
   visible together, travel together, and are replayed on the peer inside a single transaction:
   all of it lands, or none of it.
3. **Order.** The relay stamps each batch with a gapless `sequence`. The receiver keeps a
   row-locked cursor per source node: a batch it already saw is acknowledged as a duplicate, a
   batch that arrives too early is refused with `409` until its predecessor lands.
4. **No loops.** Statements produced by a replay carry a suppression flag, so the hooks ignore
   them. Data created locally on either side still flows normally.
5. **Delivery.** A background relay polls the outbox, sends the oldest batch first, retries with
   exponential backoff, and never lets a later batch overtake a failing one. Delivered rows are
   kept for audit, then purged.

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
| `batch_id` | yes | UUID of one source transaction. Replaying it is acknowledged as a duplicate. |
| `source_node` | yes | Who produced the batch. A node rejects a batch bearing its own id. |
| `sequence` | yes | Gapless counter per source node, starting at 1. Arriving early is refused with `409`. |
| `generated_at` | yes | When the source transaction committed. Survives a bridge hop unchanged. |
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

`200` with the usual envelope:

```json
{
  "success": true,
  "statusCode": 200,
  "body": {
    "data": {
      "status": "APPLIED",
      "batch_id": "6f1c2a4e-9b3d-4c7a-8f21-0d5e7b9a1c33",
      "operations": 3
    }
  }
}
```

| Status | Meaning |
| --- | --- |
| `APPLIED` | written into the local tables |
| `FORWARDED` | a bridge queued it for the next hop |
| `DUPLICATE` | already seen; nothing was written |

`409` means a predecessor is still missing. The sender keeps the batch and retries until the gap
closes, so this is a normal part of operation rather than an error to chase.

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

Pick one shared secret and use it on every hop.

**Network A backend**

```env
SYNC_ENABLED=true
SYNC_NODE_ID=network_a
SYNC_INBOUND_MODE=APPLY
SYNC_RELAY_ENABLED=true
SYNC_PEER_URL=https://bridge-a-to-b.internal:3000
SYNC_TOKEN=<shared secret>
```

**Network B backend**

```env
SYNC_ENABLED=true
SYNC_NODE_ID=network_b
SYNC_INBOUND_MODE=APPLY
SYNC_RELAY_ENABLED=true
SYNC_PEER_URL=https://bridge-b-to-a.internal:3000
SYNC_TOKEN=<shared secret>
```

**Bridge, A → B**

```env
SYNC_ENABLED=true
SYNC_NODE_ID=bridge_a_to_b
SYNC_INBOUND_MODE=FORWARD
SYNC_RELAY_ENABLED=true
SYNC_PEER_URL=https://network-b-backend.internal:3000
SYNC_TOKEN=<shared secret>
```

**Bridge, B → A** — same, with `SYNC_NODE_ID=bridge_b_to_a` and `SYNC_PEER_URL` pointing at
network A.

A bridge relays to exactly one peer, so each direction is its own process with its own database
(the two `sync_outbox` tables must not be shared). A bridge only needs the two `sync_` tables; it
never touches business data.

`SYNC_NODE_ID` is permanent. Reusing or renaming one resets the receiver's cursor and will make
batches look like duplicates or gaps.

### 4. Optional tuning

| Variable | Default | Purpose |
| --- | --- | --- |
| `SYNC_SEND_ENABLED` | `true` | set to `false` to stop shipping without losing anything |
| `SYNC_TABLES` | all mapped tables | comma separated allowlist of physical tables |
| `SYNC_POLL_INTERVAL_MS` | `1000` | relay poll period |
| `SYNC_HTTP_TIMEOUT_MS` | `10000` | timeout of one delivery attempt |
| `SYNC_RETRY_BASE_MS` | `1000` | first retry delay, doubled on each failure |
| `SYNC_RETRY_MAX_MS` | `60000` | retry delay ceiling |
| `SYNC_ALERT_AFTER_ATTEMPTS` | `10` | log an error once the head batch has failed this often |
| `SYNC_RETENTION_DAYS` | `14` | how long delivered rows are kept |

Leave `SYNC_ENABLED` unset to run the backend exactly as before — the module stays inert.

### 5. The two outbound switches

`SYNC_PEER_URL` is the **destination**. Point it somewhere else and the next batch goes there —
swap a bridge, fail over to a standby, or aim a node at a staging peer. Only the relay reads it,
so changing it never affects inbound traffic.

`SYNC_SEND_ENABLED=false` **pauses delivery**. Capture keeps running, the outbox keeps growing, and
nothing is dropped; the moment it is turned back on the queue drains in its original order. Use it
while the peer is down for maintenance, or when redirecting `SYNC_PEER_URL`, so nothing is in flight
during the switch. It is deliberately separate from `SYNC_RELAY_ENABLED`, which answers a different
question — *is this the instance that owns the relay loop* — and should stay `true` on exactly one
instance per node.

Both are read at startup, so a restart applies them. `GET /sync/status` reports the live values.

## Operating it

`GET /sync/status` (same token header) reports the backlog and the cursors:

```json
{
  "node_id": "network_a",
  "inbound_mode": "APPLY",
  "relay_enabled": true,
  "send_enabled": true,
  "peer_url": "https://bridge-a-to-b.internal:3000",
  "pending_batches": 0,
  "pending_operations": 0,
  "oldest_pending_at": null,
  "head_attempts": 0,
  "head_last_error": null,
  "sequences": [{ "node_id": "network_b", "last_sequence": 128, "last_batch_id": "..." }]
}
```

A growing `pending_batches` together with a rising `head_attempts` means the head batch cannot be
delivered. Read `head_last_error`, fix the cause, and the relay resumes on its own — nothing is
skipped and nothing is lost. Blocking on purpose is the point: a later batch may depend on the
one in front of it.
