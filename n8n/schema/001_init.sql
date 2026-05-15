-- KCL Portal — Phase 1 initial schema
--
-- Apply on the VPS:
--   sudo docker compose -f /opt/kcl-n8n/docker-compose.yml exec -T postgres \
--     psql -U portal -d kcl_portal -f - < /opt/kcl-repo/n8n/schema/001_init.sql
--
-- Idempotent? No — running twice will fail on "relation already exists".
-- For schema changes after this, add a 002_*.sql with explicit ALTERs.

-- ── Extensions ──────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ── cases ──────────────────────────────────────────────────────────
-- A case groups one or more persons (petitioner + beneficiary + family
-- + joint sponsor). Light — most data hangs off persons / documents.
CREATE TABLE cases (
  id                  uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  primary_person_id   uuid,                          -- FK added after persons table exists
  case_label          text,                          -- staff-editable display label (e.g. "Garcia AOS")
  notes               text DEFAULT '',
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- ── persons ────────────────────────────────────────────────────────
-- The atomic unit. Each person on a case is one row. Live editable
-- values live here; the AI's original ground truth lives in
-- extracted_fields below (provenance / audit trail).
CREATE TABLE persons (
  id                     uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  case_id                uuid REFERENCES cases(id) ON DELETE SET NULL,
  role                   text NOT NULL DEFAULT 'unspecified'
                         CHECK (role IN (
                           'petitioner','beneficiary','spouse','child','parent',
                           'joint_sponsor','other','unspecified'
                         )),

  -- Identity (passport name is canonical)
  name_passport          text,
  name_given             text,
  name_family            text,
  name_alternate         text,                       -- alternate spellings / accented forms
  dob                    date,
  place_of_birth         text,
  country_of_birth       text,
  country_of_citizenship text,
  sex                    text CHECK (sex IS NULL OR sex IN ('M','F','X')),
  a_number               text,
  ssn                    text,

  -- Immigration status
  immigration_status     text,                       -- free text; e.g. 'EAD','green_card','F-1','parolee'
  visa_type              text,
  last_entry_date        date,
  i94_number             text,
  ead_category           text,
  ead_expiry             date,
  gc_category            text,
  gc_expiry              date,

  -- Contact
  current_address        text,
  mailing_address        text,                       -- nullable when same as current
  phone                  text,
  email                  text,

  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

-- Close the cases → persons reference loop now that persons exists
ALTER TABLE cases
  ADD CONSTRAINT cases_primary_person_fk
  FOREIGN KEY (primary_person_id) REFERENCES persons(id) ON DELETE SET NULL;

-- ── documents ──────────────────────────────────────────────────────
-- Every uploaded file gets a row. doc_type set by AI classification.
-- was_analyzed flags which ones got pulled into extracted_fields.
CREATE TABLE documents (
  id                         uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  case_id                    uuid REFERENCES cases(id) ON DELETE CASCADE,
  person_id                  uuid REFERENCES persons(id) ON DELETE SET NULL,
  job_id                     text,                   -- n8n execution.id that uploaded the file
  filename                   text NOT NULL,          -- safe on-disk filename
  original_filename          text,                   -- as provided by client
  storage_path               text NOT NULL,          -- /data/jobs/{jobId}/inputs/<filename>
  mime_type                  text,
  size_bytes                 bigint,
  doc_type                   text DEFAULT 'unknown'
                             CHECK (doc_type IN (
                               'passport','birth_cert','marriage_cert','green_card','ead',
                               'w2','paystub','tax_return','intake','unknown','other'
                             )),
  was_analyzed               boolean NOT NULL DEFAULT false,
  classification_confidence  numeric,
  uploaded_at                timestamptz NOT NULL DEFAULT now()
);

-- ── extracted_fields ───────────────────────────────────────────────
-- Provenance / audit trail. Records what the AI pulled from which
-- document for which person. Live values on persons may diverge after
-- staff edits — this table is the AI's original ground truth.
CREATE TABLE extracted_fields (
  id            uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  document_id   uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  person_id     uuid REFERENCES persons(id) ON DELETE CASCADE,
  field_name    text NOT NULL,                       -- e.g. 'dob', 'a_number', 'gc_expiry'
  field_value   text,                                -- normalized string; persons holds the typed version
  confidence    numeric,                             -- 0..1 if Claude reports it
  extracted_at  timestamptz NOT NULL DEFAULT now()
);

-- ── notes ──────────────────────────────────────────────────────────
-- Free-text staff notes per case.
CREATE TABLE notes (
  id          uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  case_id     uuid NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  author      text,                                  -- Clerk subject ID or display name
  body        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ── Indexes ────────────────────────────────────────────────────────
CREATE INDEX persons_case_id_idx              ON persons(case_id);
CREATE INDEX persons_email_idx                ON persons(email);
CREATE INDEX persons_dob_idx                  ON persons(dob);
CREATE INDEX persons_a_number_idx             ON persons(a_number);
CREATE INDEX documents_case_id_idx            ON documents(case_id);
CREATE INDEX documents_person_id_idx          ON documents(person_id);
CREATE INDEX documents_job_id_idx             ON documents(job_id);
CREATE INDEX extracted_fields_document_id_idx ON extracted_fields(document_id);
CREATE INDEX extracted_fields_person_id_idx   ON extracted_fields(person_id);
CREATE INDEX cases_primary_person_id_idx      ON cases(primary_person_id);
CREATE INDEX notes_case_id_idx                ON notes(case_id);

-- Fuzzy / substring name search for the portal customer list
CREATE INDEX persons_name_trgm_idx ON persons USING gin (
  (coalesce(name_passport,'') || ' ' || coalesce(name_alternate,'') || ' ' || coalesce(name_given,'') || ' ' || coalesce(name_family,''))
  gin_trgm_ops
);

-- ── updated_at triggers ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION trg_set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER persons_updated_at BEFORE UPDATE ON persons
  FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();
CREATE TRIGGER cases_updated_at BEFORE UPDATE ON cases
  FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();
