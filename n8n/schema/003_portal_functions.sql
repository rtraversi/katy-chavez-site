-- KCL Portal — read + update stored functions
--
-- Apply on the VPS:
--   cat /opt/kcl-repo/n8n/schema/003_portal_functions.sql | \
--     sudo docker compose -f /opt/kcl-n8n/docker-compose.yml exec -T \
--       postgres psql -U portal -d kcl_portal
--
-- Re-runnable via CREATE OR REPLACE.

-- ── portal_list ────────────────────────────────────────────────────
-- Paginated person list with optional substring search across the
-- four name columns. Returns persons + total in one shot.
CREATE OR REPLACE FUNCTION portal_list(
  p_search text DEFAULT '',
  p_limit  int  DEFAULT 50,
  p_offset int  DEFAULT 0
) RETURNS jsonb AS $$
DECLARE
  v_persons jsonb;
  v_total   bigint;
BEGIN
  WITH filtered AS (
    SELECT p.id, p.case_id, p.role,
           p.name_passport, p.name_given, p.name_family, p.name_alternate,
           p.dob, p.email, p.phone, p.current_address,
           p.immigration_status, p.updated_at, p.created_at,
           c.case_label,
           (SELECT COUNT(*) FROM documents d WHERE d.person_id = p.id) AS doc_count
    FROM persons p
    LEFT JOIN cases c ON c.id = p.case_id
    WHERE
      coalesce(p_search,'') = ''
      OR (
        coalesce(p.name_passport,'') || ' '
        || coalesce(p.name_alternate,'') || ' '
        || coalesce(p.name_given,'') || ' '
        || coalesce(p.name_family,'')
      ) ILIKE '%' || p_search || '%'
  )
  SELECT
    coalesce(jsonb_agg(row_to_json(t)) FILTER (WHERE t.id IS NOT NULL), '[]'::jsonb),
    (SELECT COUNT(*) FROM filtered)
  INTO v_persons, v_total
  FROM (
    SELECT * FROM filtered
    ORDER BY updated_at DESC
    LIMIT GREATEST(LEAST(p_limit, 200), 1)
    OFFSET GREATEST(p_offset, 0)
  ) t;

  RETURN jsonb_build_object(
    'persons', v_persons,
    'total',   v_total
  );
END;
$$ LANGUAGE plpgsql STABLE;

-- ── portal_get ─────────────────────────────────────────────────────
-- Full record for one person: the person itself, the case they
-- belong to, other persons on the same case, documents attached to
-- the case, and the AI-provenance extracted_fields for this person.
CREATE OR REPLACE FUNCTION portal_get(p_person_id uuid)
RETURNS jsonb AS $$
DECLARE
  v_person    jsonb;
  v_case      jsonb;
  v_case_id   uuid;
  v_related   jsonb;
  v_documents jsonb;
  v_fields    jsonb;
BEGIN
  SELECT row_to_json(p)::jsonb, p.case_id
    INTO v_person, v_case_id
  FROM persons p
  WHERE p.id = p_person_id;

  IF v_person IS NULL THEN
    RETURN jsonb_build_object('error', 'person_not_found');
  END IF;

  SELECT row_to_json(c)::jsonb INTO v_case FROM cases c WHERE c.id = v_case_id;

  SELECT coalesce(jsonb_agg(row_to_json(p)), '[]'::jsonb) INTO v_related
  FROM persons p
  WHERE p.case_id = v_case_id AND p.id <> p_person_id;

  SELECT coalesce(jsonb_agg(row_to_json(d)), '[]'::jsonb) INTO v_documents
  FROM documents d
  WHERE d.case_id = v_case_id;

  SELECT coalesce(jsonb_agg(row_to_json(ef) ORDER BY ef.field_name), '[]'::jsonb) INTO v_fields
  FROM extracted_fields ef
  WHERE ef.person_id = p_person_id;

  RETURN jsonb_build_object(
    'person',           v_person,
    'case',             coalesce(v_case, 'null'::jsonb),
    'related_persons',  v_related,
    'documents',        v_documents,
    'extracted_fields', v_fields
  );
END;
$$ LANGUAGE plpgsql STABLE;

-- ── portal_update ──────────────────────────────────────────────────
-- Update a whitelisted set of editable fields on a person. Silently
-- ignores unknown fields. Empty strings are coerced to NULL so the
-- frontend can clear a field by sending ''.
CREATE OR REPLACE FUNCTION portal_update(
  p_person_id uuid,
  p_fields    jsonb
) RETURNS jsonb AS $$
DECLARE
  v_allowed     text[] := ARRAY[
    'role',
    'name_passport','name_given','name_family','name_alternate',
    'dob','place_of_birth','country_of_birth','country_of_citizenship','sex',
    'a_number','ssn',
    'immigration_status','visa_type','last_entry_date','i94_number',
    'ead_category','ead_expiry','gc_category','gc_expiry',
    'current_address','mailing_address','phone','email'
  ];
  v_field       text;
  v_set_clauses text[] := ARRAY[]::text[];
BEGIN
  FOR v_field IN SELECT jsonb_object_keys(p_fields) LOOP
    IF v_field = ANY(v_allowed) THEN
      v_set_clauses := v_set_clauses
        || (quote_ident(v_field) || ' = nullif($1->>' || quote_literal(v_field) || ', '''')');
    END IF;
  END LOOP;

  IF array_length(v_set_clauses, 1) > 0 THEN
    EXECUTE format(
      'UPDATE persons SET %s WHERE id = $2',
      array_to_string(v_set_clauses, ', ')
    ) USING p_fields, p_person_id;
  END IF;

  RETURN (
    SELECT row_to_json(p)::jsonb
    FROM persons p
    WHERE p.id = p_person_id
  );
END;
$$ LANGUAGE plpgsql;
