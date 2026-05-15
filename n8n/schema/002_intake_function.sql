-- KCL Portal — portal_intake stored function
--
-- Takes the AI-extracted result of a portal submission and atomically
-- inserts the case + persons + documents + extracted_fields rows.
-- Returns the new case_id + person_ids so the workflow can echo them.
--
-- Apply on the VPS:
--   cat /opt/kcl-repo/n8n/schema/002_intake_function.sql | \
--     sudo docker compose -f /opt/kcl-n8n/docker-compose.yml exec -T \
--       postgres psql -U portal -d kcl_portal
--
-- Re-runnable: uses CREATE OR REPLACE.

CREATE OR REPLACE FUNCTION portal_intake(
  p_job_id text,
  p_case_label text,
  p_persons jsonb,            -- array of person objects (see shape below)
  p_documents jsonb,          -- array of doc objects with person_index
  p_extracted_fields jsonb    -- array of field objects with person_index + document_index
) RETURNS jsonb AS $$
DECLARE
  v_case_id uuid;
  v_person_id uuid;
  v_document_id uuid;
  v_person_ids uuid[] := ARRAY[]::uuid[];
  v_document_ids uuid[] := ARRAY[]::uuid[];
  v_p jsonb;
  v_d jsonb;
  v_f jsonb;
  v_idx int;
BEGIN
  -- 1. Create the case
  INSERT INTO cases (case_label)
    VALUES (p_case_label)
    RETURNING id INTO v_case_id;

  -- 2. Insert persons in order; capture IDs by position
  FOR v_p IN SELECT * FROM jsonb_array_elements(p_persons) LOOP
    INSERT INTO persons (
      case_id, role,
      name_passport, name_given, name_family, name_alternate,
      dob, place_of_birth, country_of_birth, country_of_citizenship, sex,
      a_number, ssn,
      immigration_status, visa_type, last_entry_date, i94_number,
      ead_category, ead_expiry, gc_category, gc_expiry,
      current_address, mailing_address, phone, email
    ) VALUES (
      v_case_id,
      coalesce(v_p->>'role', 'unspecified'),
      v_p->>'name_passport',
      v_p->>'name_given',
      v_p->>'name_family',
      v_p->>'name_alternate',
      nullif(v_p->>'dob', '')::date,
      v_p->>'place_of_birth',
      v_p->>'country_of_birth',
      v_p->>'country_of_citizenship',
      v_p->>'sex',
      v_p->>'a_number',
      v_p->>'ssn',
      v_p->>'immigration_status',
      v_p->>'visa_type',
      nullif(v_p->>'last_entry_date', '')::date,
      v_p->>'i94_number',
      v_p->>'ead_category',
      nullif(v_p->>'ead_expiry', '')::date,
      v_p->>'gc_category',
      nullif(v_p->>'gc_expiry', '')::date,
      v_p->>'current_address',
      v_p->>'mailing_address',
      v_p->>'phone',
      v_p->>'email'
    ) RETURNING id INTO v_person_id;
    v_person_ids := v_person_ids || v_person_id;
  END LOOP;

  -- 3. Set primary person to the first one inserted (typically the petitioner / canonical-passport-holder)
  IF array_length(v_person_ids, 1) > 0 THEN
    UPDATE cases SET primary_person_id = v_person_ids[1] WHERE id = v_case_id;
  END IF;

  -- 4. Insert documents; capture IDs by position; resolve person_id via person_index
  FOR v_d IN SELECT * FROM jsonb_array_elements(p_documents) LOOP
    v_idx := nullif(v_d->>'person_index', '')::int;  -- nullable
    INSERT INTO documents (
      case_id, person_id, job_id,
      filename, original_filename, storage_path,
      mime_type, size_bytes,
      doc_type, was_analyzed, classification_confidence
    ) VALUES (
      v_case_id,
      CASE WHEN v_idx IS NOT NULL THEN v_person_ids[v_idx + 1] ELSE NULL END,  -- v_idx is 0-based
      p_job_id,
      v_d->>'filename',
      v_d->>'original_filename',
      v_d->>'storage_path',
      v_d->>'mime_type',
      nullif(v_d->>'size_bytes', '')::bigint,
      coalesce(v_d->>'doc_type', 'unknown'),
      coalesce((v_d->>'was_analyzed')::boolean, false),
      nullif(v_d->>'classification_confidence', '')::numeric
    ) RETURNING id INTO v_document_id;
    v_document_ids := v_document_ids || v_document_id;
  END LOOP;

  -- 5. Insert extracted_fields, resolving person_id + document_id via indexes
  FOR v_f IN SELECT * FROM jsonb_array_elements(p_extracted_fields) LOOP
    INSERT INTO extracted_fields (
      document_id, person_id, field_name, field_value, confidence
    ) VALUES (
      v_document_ids[(v_f->>'document_index')::int + 1],
      CASE WHEN v_f->>'person_index' IS NOT NULL THEN v_person_ids[(v_f->>'person_index')::int + 1] ELSE NULL END,
      v_f->>'field_name',
      v_f->>'field_value',
      nullif(v_f->>'confidence', '')::numeric
    );
  END LOOP;

  -- 6. Return what was created
  RETURN jsonb_build_object(
    'case_id', v_case_id,
    'person_ids', to_jsonb(v_person_ids),
    'document_ids', to_jsonb(v_document_ids)
  );
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION portal_intake IS
'Atomically creates a case + persons + documents + extracted_fields from
the AI-extracted output of a portal submission. Indexes in p_documents
and p_extracted_fields are 0-based references into p_persons (and into
p_documents for fields). Returns { case_id, person_ids[], document_ids[] }.';
