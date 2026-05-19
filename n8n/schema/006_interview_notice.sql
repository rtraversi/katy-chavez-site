-- KCL Portal — Phase 3c: add interview_notice type to mail_intake function
--
-- Apply on the VPS:
--   cat /opt/kcl-repo/n8n/schema/006_interview_notice.sql | \
--     sudo docker compose -f /opt/kcl-n8n/docker-compose.yml exec -T \
--       postgres psql -U portal -d kcl_portal
--
-- Re-runnable: function uses CREATE OR REPLACE.

CREATE OR REPLACE FUNCTION mail_intake(
  p_exec_id           text,
  p_original_filename text,
  p_storage_path      text,
  p_page_count        int,
  p_items             jsonb
) RETURNS jsonb AS $$
DECLARE
  v_batch_id  uuid;
  v_item_ids  uuid[] := ARRAY[]::uuid[];
  v_item      jsonb;
  v_item_id   uuid;
BEGIN
  INSERT INTO mail_batches (
    batch_exec_id, original_filename, storage_path, page_count,
    item_count, status
  ) VALUES (
    p_exec_id, p_original_filename, p_storage_path, p_page_count,
    jsonb_array_length(p_items), 'done'
  ) RETURNING id INTO v_batch_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    INSERT INTO mail_items (
      batch_id,
      client_name, client_first_name, client_last_name,
      receipt_number, a_number,
      notice_type, application_type, notice_date,
      appointment_date, appointment_time, appointment_location, appointment_bring,
      response_due_date, rfe_evidence_requested, rejection_reason,
      summary, storage_path, page_numbers, raw_extraction
    ) VALUES (
      v_batch_id,
      v_item->>'client_name',
      v_item->>'client_first_name',
      v_item->>'client_last_name',
      v_item->>'receipt_number',
      v_item->>'a_number',
      CASE WHEN (v_item->>'notice_type') IN (
        'biometrics_notice','approval_notice','receipt_notice',
        'rfe','transfer_notice','rejection','card_production_ordered',
        'interview_notice','other'
      ) THEN (v_item->>'notice_type') ELSE 'other' END,
      v_item->>'application_type',
      CASE WHEN v_item->>'notice_date' ~ '^\d{4}-\d{2}-\d{2}$'
           THEN (v_item->>'notice_date')::date ELSE NULL END,
      CASE WHEN v_item->>'appointment_date' ~ '^\d{4}-\d{2}-\d{2}$'
           THEN (v_item->>'appointment_date')::date ELSE NULL END,
      v_item->>'appointment_time',
      v_item->>'appointment_location',
      v_item->>'appointment_bring',
      CASE WHEN v_item->>'response_due_date' ~ '^\d{4}-\d{2}-\d{2}$'
           THEN (v_item->>'response_due_date')::date ELSE NULL END,
      CASE
        WHEN jsonb_typeof(v_item->'rfe_evidence_requested') = 'array'
        THEN ARRAY(SELECT x FROM jsonb_array_elements_text(v_item->'rfe_evidence_requested') x)
        ELSE NULL
      END,
      v_item->>'rejection_reason',
      v_item->>'summary',
      v_item->>'storage_path',
      ARRAY(SELECT (x)::int FROM jsonb_array_elements_text(coalesce(v_item->'page_numbers','[]'::jsonb)) x),
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
