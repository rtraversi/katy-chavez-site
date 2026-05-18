-- KCL Portal — Phase 3: USCIS mail sorting tables + functions
--
-- Apply on the VPS:
--   cat /opt/kcl-repo/n8n/schema/004_mail_tables.sql | \
--     sudo docker compose -f /opt/kcl-n8n/docker-compose.yml exec -T \
--       postgres psql -U portal -d kcl_portal
--
-- Re-runnable: tables use IF NOT EXISTS; functions use CREATE OR REPLACE.

-- ── mail_batches ───────────────────────────────────────────────────
-- One row per staff mail scan upload. The original combined PDF lives
-- on disk at storage_path; individual client PDFs are in mail_items.
CREATE TABLE IF NOT EXISTS mail_batches (
  id                uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  batch_exec_id     text,                         -- n8n execution ID
  original_filename text,
  storage_path      text NOT NULL,                -- /data/mail/{execId}/original.pdf
  page_count        int,
  item_count        int NOT NULL DEFAULT 0,
  status            text NOT NULL DEFAULT 'processing'
                    CHECK (status IN ('processing','done','error')),
  error_message     text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mail_batches_created_idx ON mail_batches(created_at DESC);

-- ── mail_items ─────────────────────────────────────────────────────
-- One row per distinct client mail piece found in a batch scan.
-- Claude extracts all fields; storage_path points to the split PDF.
CREATE TABLE IF NOT EXISTS mail_items (
  id                    uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  batch_id              uuid NOT NULL REFERENCES mail_batches(id) ON DELETE CASCADE,

  -- Client identity (as Claude reads from the USCIS form)
  client_name           text,                     -- full name exactly as on form
  client_first_name     text,
  client_last_name      text,

  -- USCIS form fields
  receipt_number        text,                     -- e.g. LIN2112345678
  a_number              text,
  notice_type           text
                        CHECK (notice_type IN (
                          'biometrics_notice','approval_notice','receipt_notice',
                          'rfe','transfer_notice','rejection',
                          'card_production_ordered','other'
                        )),
  application_type      text,                     -- I-485, I-765, I-131, etc.
  notice_date           date,

  -- Biometrics appointment fields (null for other notice types)
  appointment_date      date,
  appointment_time      text,
  appointment_location  text,
  appointment_bring     text,                     -- what to bring, as extracted

  -- AI summary + storage
  summary               text,                     -- Claude's plain-English summary
  storage_path          text,                     -- /data/mail/{execId}/{slug}.pdf (null if split failed)
  page_numbers          int[],                    -- 1-indexed page numbers in original scan
  raw_extraction        jsonb,                    -- full Claude object for this piece

  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mail_items_batch_idx         ON mail_items(batch_id);
CREATE INDEX IF NOT EXISTS mail_items_created_idx       ON mail_items(created_at DESC);
CREATE INDEX IF NOT EXISTS mail_items_client_name_idx   ON mail_items(client_last_name, client_first_name);
CREATE INDEX IF NOT EXISTS mail_items_notice_type_idx   ON mail_items(notice_type);
CREATE INDEX IF NOT EXISTS mail_items_receipt_idx       ON mail_items(receipt_number);

-- Fuzzy name search on mail items
CREATE INDEX IF NOT EXISTS mail_items_name_trgm_idx ON mail_items USING gin (
  (coalesce(client_last_name,'') || ' ' || coalesce(client_first_name,'') || ' ' || coalesce(client_name,''))
  gin_trgm_ops
);

-- ── mail_intake ────────────────────────────────────────────────────
-- Called from the mail-ingest n8n workflow after Claude analysis +
-- PDF splitting. Atomically inserts one batch row + N item rows.
-- Returns { batch_id, item_ids }.
CREATE OR REPLACE FUNCTION mail_intake(
  p_exec_id          text,
  p_original_filename text,
  p_storage_path     text,
  p_page_count       int,
  p_items            jsonb    -- array of item objects from Claude + pdf-lib
) RETURNS jsonb AS $$
DECLARE
  v_batch_id  uuid;
  v_item_ids  uuid[] := ARRAY[]::uuid[];
  v_item      jsonb;
  v_item_id   uuid;
BEGIN
  -- Insert batch row
  INSERT INTO mail_batches (
    batch_exec_id, original_filename, storage_path, page_count,
    item_count, status
  ) VALUES (
    p_exec_id, p_original_filename, p_storage_path, p_page_count,
    jsonb_array_length(p_items), 'done'
  ) RETURNING id INTO v_batch_id;

  -- Insert one item row per client mail piece
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    INSERT INTO mail_items (
      batch_id,
      client_name, client_first_name, client_last_name,
      receipt_number, a_number,
      notice_type, application_type, notice_date,
      appointment_date, appointment_time, appointment_location, appointment_bring,
      summary, storage_path, page_numbers, raw_extraction
    ) VALUES (
      v_batch_id,
      v_item->>'client_name',
      v_item->>'client_first_name',
      v_item->>'client_last_name',
      v_item->>'receipt_number',
      v_item->>'a_number',
      -- coerce notice_type to valid enum value
      CASE WHEN (v_item->>'notice_type') IN (
        'biometrics_notice','approval_notice','receipt_notice',
        'rfe','transfer_notice','rejection','card_production_ordered','other'
      ) THEN (v_item->>'notice_type') ELSE 'other' END,
      v_item->>'application_type',
      CASE WHEN v_item->>'notice_date' ~ '^\d{4}-\d{2}-\d{2}$'
           THEN (v_item->>'notice_date')::date ELSE NULL END,
      CASE WHEN v_item->>'appointment_date' ~ '^\d{4}-\d{2}-\d{2}$'
           THEN (v_item->>'appointment_date')::date ELSE NULL END,
      v_item->>'appointment_time',
      v_item->>'appointment_location',
      v_item->>'appointment_bring',
      v_item->>'summary',
      v_item->>'storage_path',
      ARRAY(SELECT (x::text)::int FROM jsonb_array_elements_text(coalesce(v_item->'page_numbers','[]'::jsonb)) x),
      v_item
    ) RETURNING id INTO v_item_id;

    v_item_ids := v_item_ids || v_item_id;
  END LOOP;

  RETURN jsonb_build_object(
    'batch_id',  v_batch_id,
    'item_ids',  to_jsonb(v_item_ids),
    'item_count', array_length(v_item_ids, 1)
  );
END;
$$ LANGUAGE plpgsql;

-- ── mail_list ──────────────────────────────────────────────────────
-- Paginated list of mail items, newest first. Optional name search.
-- Returns items joined with batch date for the portal list view.
CREATE OR REPLACE FUNCTION mail_list(
  p_search text DEFAULT '',
  p_limit  int  DEFAULT 50,
  p_offset int  DEFAULT 0
) RETURNS jsonb AS $$
DECLARE
  v_items jsonb;
  v_total bigint;
BEGIN
  WITH filtered AS (
    SELECT
      mi.id, mi.batch_id,
      mi.client_name, mi.client_first_name, mi.client_last_name,
      mi.receipt_number, mi.a_number,
      mi.notice_type, mi.application_type,
      mi.notice_date, mi.appointment_date, mi.appointment_time,
      mi.appointment_location, mi.summary,
      mi.storage_path IS NOT NULL AS has_pdf,
      mi.created_at,
      mb.created_at AS batch_date,
      mb.original_filename
    FROM mail_items mi
    JOIN mail_batches mb ON mb.id = mi.batch_id
    WHERE
      coalesce(p_search,'') = ''
      OR (
        coalesce(mi.client_last_name,'') || ' '
        || coalesce(mi.client_first_name,'') || ' '
        || coalesce(mi.client_name,'')
      ) ILIKE '%' || p_search || '%'
  )
  SELECT
    coalesce(jsonb_agg(row_to_json(t)) FILTER (WHERE t.id IS NOT NULL), '[]'::jsonb),
    (SELECT COUNT(*) FROM filtered)
  INTO v_items, v_total
  FROM (
    SELECT * FROM filtered
    ORDER BY created_at DESC
    LIMIT  GREATEST(LEAST(p_limit, 200), 1)
    OFFSET GREATEST(p_offset, 0)
  ) t;

  RETURN jsonb_build_object(
    'items', v_items,
    'total', v_total
  );
END;
$$ LANGUAGE plpgsql STABLE;

-- ── mail_get ───────────────────────────────────────────────────────
-- Full detail for one mail item. Returns all fields including the
-- raw_extraction blob. PDF bytes are served separately by the workflow.
CREATE OR REPLACE FUNCTION mail_get(p_item_id uuid)
RETURNS jsonb AS $$
DECLARE
  v_item  jsonb;
  v_batch jsonb;
BEGIN
  SELECT row_to_json(mi)::jsonb INTO v_item
  FROM mail_items mi
  WHERE mi.id = p_item_id;

  IF v_item IS NULL THEN
    RETURN jsonb_build_object('error', 'item_not_found');
  END IF;

  SELECT row_to_json(mb)::jsonb INTO v_batch
  FROM mail_batches mb
  WHERE mb.id = (v_item->>'batch_id')::uuid;

  RETURN jsonb_build_object(
    'item',  v_item,
    'batch', coalesce(v_batch, 'null'::jsonb)
  );
END;
$$ LANGUAGE plpgsql STABLE;
