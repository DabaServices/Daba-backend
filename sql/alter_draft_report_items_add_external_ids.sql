BEGIN;

ALTER TABLE shoval.draft_report_items
    ADD COLUMN IF NOT EXISTS external_report_id uuid,
    ADD COLUMN IF NOT EXISTS external_item_id uuid;

CREATE INDEX IF NOT EXISTS idx_draft_report_items_external_ids
    ON shoval.draft_report_items (external_report_id, external_item_id);

COMMIT;
