# KCL Portal — project context for Claude

Working notes for anyone (human or Claude) picking up this repo. Read this first.

## What this is

The website + portal for **Katy Chavez Law (KCL)** at katychavez.com.

Two products in one repo:
1. **Marketing site** — `index.html` at the root, plain HTML/CSS. Auto-deployed to Netlify on every push to `main`.
2. **Staff portal** under `/portal/` — uploads client documents, AI-extracts customer data into Postgres, lets staff view + edit. Built in two phases:
   - **Phase 1 (shipped 2026-05-15):** upload → extract → list/search/edit customer records.
   - **Phase 2 (next):** USCIS form library + automated form filling with `pdf-lib` → editable AcroForm PDFs.

This project is also intended as a **template** for similar portals at other immigration-attorney firms. Keep tenant-specific values in env / config, not hardcoded.

## Tech stack

- **Frontend:** static HTML/CSS/JS, no build step, no framework. Netlify hosts.
- **n8n** on a shared-tenancy Hostinger KVM 2 VPS (`https://n8n.katychavez.com`). Behind BSR's Traefik.
- **Postgres 16** in a sibling container next to n8n (internal-only at `postgres:5432`).
- **Claude API** for document classification + structured extraction (model: `claude-sonnet-4-6`).
- **Cloudflare DNS** in front of katychavez.com + n8n.katychavez.com.

## Repo layout

```
/                        marketing site (index.html)
  netlify.toml           redirects + security headers
  portal/
    index.html           staff dashboard (list + search) — Phase 1
    customer.html        contact card with editable tabs — Phase 1
    admin.html           OLD job-list dashboard (deprecated; not deleted yet)
    dev-jwt.html         abandoned Clerk debug page (not deleted yet)
  n8n/
    docker-compose.yml   VPS stack: n8n + postgres
    bootstrap.sh         idempotent VPS provisioning script
    .env.example         template for /opt/kcl-n8n/.env on VPS
    schema/              ordered SQL migrations
      001_init.sql                tables + indexes + triggers
      002_intake_function.sql     portal_intake() — AI-extract → DB insert
      003_portal_functions.sql    portal_list/get/update functions
    workflows/           n8n workflow SDK source (canonical copies)
      portal-submit.workflow.ts   upload + classify + extract
      portal-list.workflow.ts     paginated list with search
      portal-get.workflow.ts      full record
      portal-update.workflow.ts   whitelisted field updates
  *.jpg / *.png          marketing site images
```

User's memory files at `C:\Users\rtrav\.claude\projects\C--sites-katychavez-site\memory\` contain the longer history and decisions log.

## VPS architecture

Stack runs at `/opt/kcl-n8n/` on the Hostinger VPS:

- `kcl-n8n-n8n-1` (n8nio/n8n:latest) — workflow engine, behind shared Traefik
- `kcl-n8n-postgres-1` (postgres:16-alpine) — internal-only Postgres
- Volumes: `n8n_data` (n8n's SQLite state), `postgres_data` (portal DB), bind-mounted `./jobs` (file uploads, chowned 1000:1000) and `./forms` (USCIS PDFs, ro)

`bootstrap.sh` is re-runnable. Triggers: pull the repo to `/opt/kcl-repo`, then `sudo bash /opt/kcl-repo/n8n/bootstrap.sh` — copies the latest `docker-compose.yml` into `/opt/kcl-n8n/`, pulls images, recreates the stack.

Required env in `/opt/kcl-n8n/.env`:
```
N8N_HOST=n8n.katychavez.com
N8N_ENCRYPTION_KEY=…
ANTHROPIC_API_KEY=sk-ant-…
TELEGRAM_BOT_TOKEN=…
CLERK_SECRET_KEY=…
CLERK_JWT_ISSUER=https://decent-seahorse-78.clerk.accounts.dev
POSTGRES_USER=portal
POSTGRES_PASSWORD=…
POSTGRES_DB=kcl_portal
```

Two n8n env vars matter for the Code nodes:
- `NODE_FUNCTION_ALLOW_BUILTIN=fs,path` — lets the portal-submit Code node mkdir + writeFileSync
- `N8N_BLOCK_ENV_ACCESS_IN_NODE=false` — lets the Code node read `$env.ANTHROPIC_API_KEY`

## Postgres schema

Tables:
- `cases` — light, mainly groups people via `primary_person_id`
- `persons` — the editable customer record (identity / contact / immigration status). One row per person; multiple persons per case (petitioner + spouse + children + joint sponsor).
- `documents` — uploaded files. Has `case_id` + optional `person_id`. Tracks `doc_type`, `was_analyzed`, `classification_confidence`, `storage_path` (on-disk path under `/data/jobs/{jobId}/inputs/`).
- `extracted_fields` — AI audit trail. Records which doc said which value for which person, with confidence. Live edits go to `persons`; `extracted_fields` is immutable ground truth.
- `notes` — case-level free-text staff notes.

Stored functions (called from n8n workflows):
- `portal_intake(job_id, case_label, persons, documents, extracted_fields) → jsonb` — atomic insert from the AI extraction output.
- `portal_list(search, limit, offset) → jsonb` — paginated list with name substring search.
- `portal_get(person_id) → jsonb` — person + case + related_persons + documents + extracted_fields in one call.
- `portal_update(person_id, fields) → jsonb` — whitelisted column updates via dynamic SQL.

Schema changes are migration files in `n8n/schema/NNN_*.sql`. Apply via:
```bash
cat /opt/kcl-repo/n8n/schema/NNN_*.sql | \
  sudo docker compose -f /opt/kcl-n8n/docker-compose.yml exec -T postgres \
  psql -U portal -d kcl_portal
```

## n8n workflows

Each workflow has:
1. A canonical source file in `n8n/workflows/*.workflow.ts`
2. A live deployment in n8n addressed by ID (see table below)

Updates flow: edit the `.workflow.ts` file → push via `mcp__claude_ai_n8n__update_workflow` → publish via `mcp__claude_ai_n8n__publish_workflow`. Do not edit workflows directly in the n8n UI without back-porting to the source file.

| Workflow | ID | Path | Auth |
|---|---|---|---|
| portal-submit | `FY4kdty7lVnJkzC8` | POST `/webhook/portal-submit` | none (intentionally public — upload form) |
| portal-list | `L3bd4UHZCcARP20h` | POST `/webhook/portal-list` | headerAuth `X-Portal-Secret` |
| portal-get | `SXqe3pjmo61JM0la` | POST `/webhook/portal-get` | headerAuth `X-Portal-Secret` |
| portal-update | `MTSTqeGlb2mAqHVh` | POST `/webhook/portal-update` | headerAuth `X-Portal-Secret` |

n8n credentials configured (all in n8n UI, never in git):
- `Portal Postgres` — connects to `postgres:5432`
- `Portal API Secret` — header `X-Portal-Secret`, value in Rob's password manager
- `Clerk JWT` — RS256 PEM. Configured but not currently used (see Auth below).

## Auth state

**Currently:** API-secret-only. Both portal pages have `const REQUIRE_CLERK = false` — Clerk gate is bypassed. Anyone visiting `/portal` lands at the secret prompt; pasting the right secret unlocks the dashboard. CRUD webhooks check the `X-Portal-Secret` header.

**Why bypassed:** Clerk dev instance returns `needs_client_trust` after successful password verification, and the Clerk JS SDK (5.125.10) doesn't yet have code to resolve that challenge. Spent multiple rounds debugging; not a config issue on our side.

**Re-enabling paths (pick one):**
1. **Clerk production** — different keys, domain allowlisting, skips most dev anti-abuse. Likely works without code changes (just flip `REQUIRE_CLERK` back to true once verified).
2. **Cloudflare Access** — gate `/portal/*` at the CF edge with email-based access policies. Free up to 50 users, zero code, single-tenant only.
3. **Self-hosted Keycloak / Authentik** — full control, multi-tenant via realms. Right answer for the template if it becomes a product.

Per memory `feedback-privilege-boundary`: customer data must stay on KCL infrastructure. Auth provider can be third-party (it doesn't store the documents themselves) but anything touching client documents must be self-hosted or BAA-covered.

## Phase 1 status

**Backend:** ✅ done. All four workflows verified via curl. Real AI extraction works on Spanish and English marriage certs (tested with two sample PDFs).

**Frontend:** ✅ done.
- `/portal` lists customers with search.
- `/portal/customer.html?id=<uuid>` shows full record across up to 7 tabs (Identity / Contact / Status / Marriage* / Family* / Documents / Notes). Editable fields save via portal-update. Dirty-state navigation guard.
- Verified end-to-end 2026-05-15: list loads, search filters, click navigates, save persists.

**Known open items in Phase 1:**
- **Add documents to existing case** (highest priority next slice) — staff frequently receive client docs in waves, not all at once. Today the dashboard's `+ New case` button always creates a fresh case, so a second upload for the same client duplicates them. Need a `+ Add documents` button on `portal/customer.html` near the Documents tab that opens the same modal but tags the upload with `case_id=<this>`. Backend change: extend `portal-submit` (or build a sibling `portal-append` workflow) to detect `case_id` and switch to append-mode — INSERT documents + extracted_fields under existing case_id, reconcile new info into existing persons by name+DOB match, only create new persons if a genuinely new family member appears in the docs.
- Marriage tab is **read-only** — fields (`marriage_date`, `marriage_location`, `spouse_name`) live in `extracted_fields` only; `persons` has no columns for them yet. A 004 migration + persons-column addition + `portal_update` allow-list extension would make these editable.
- Notes tab is **read-only** — `cases.notes` exists; no update endpoint covers it yet.
- Marriage cert family detection v1 creates **one person per cert**. The other named individual is captured as `extracted_fields.spouse_name`. v2: create two persons per cert and use spouse_name to link them.
- Cleanup pass: delete `portal/admin.html` (deprecated) and `portal/dev-jwt.html` (abandoned debug page).
- Auth re-enable on the CRUD webhooks (Clerk-prod / Cloudflare Access / Keycloak) — `REQUIRE_CLERK = false` flag at the top of both portal pages controls the front-end side.

## Phase 2 — USCIS form filling (next)

Goal: from a customer's data + a selected case type, generate filled USCIS PDFs that are still editable (AcroForm-preserved).

### Scope as planned

1. **USCIS form library** — blank fillable PDFs stored on the VPS at `/data/forms/{form-id}/{edition-date}/`. Mounted read-only into the n8n container as `/data/forms`. Mirror in a private repo for version control. (Existing volume already mounted, currently empty.)
2. **Case-type → forms mapping** — config (env or DB):
   - AOS: I-485, I-130, I-864, I-765, I-131, I-693
   - DACA: I-821D, I-765
   - K-1: I-129F
   - Consular Processing: I-130, I-864, DS-260
   - Citizenship: N-400
   - Waivers: I-601, I-601A
3. **Case-type selector on the customer card** — new dropdown + "Generate forms" button. Triggers a new workflow.
4. **`portal-fill` workflow** — takes `{case_id, case_type}`, pulls the customer + related persons + extracted_fields, fills the forms with pdf-lib, zips, stores at `/data/jobs/{case_id}/output.zip`.
5. **Output delivery** — link in the customer card. Optionally Telegram notify the `Chaveros Task Chat` group (chat ID -4153056144 via @KCImmlaw_BOT — see memory).
6. **USCIS form-update automation** — separate scheduled workflow that checks USCIS for new form editions daily and alerts Telegram if a form changed (field mapping may need rework).

### Likely Phase 2 ordering

1. Mirror a small set of fillable USCIS PDFs onto the VPS at `/data/forms/`. Start with I-485 (largest, most common AOS form) as the bench-test case.
2. Build the field-mapping data — a JSON describing "for I-485, which AcroForm field name maps to which persons-table column."
3. Build the `portal-fill` workflow in n8n. Reads customer data, runs pdf-lib in a Code node (will need `NODE_FUNCTION_ALLOW_EXTERNAL=pdf-lib` env addition + rebuild of n8n image, OR a sidecar service).
4. Add the case-type selector + "Generate forms" button to `portal/customer.html`.
5. Wire the output: display "filled forms" list on the customer card, downloadable.

### Decisions to make for Phase 2

- **Form library storage**: keep on VPS disk (current plan) or move to a private repo / Cloudflare R2 / object storage? Disk is simplest, works today.
- **pdf-lib in n8n vs sidecar**: n8n's Code node sandbox doesn't allow pdf-lib by default. Options:
  - (a) Build a custom n8n image with `pdf-lib` available via `NODE_FUNCTION_ALLOW_EXTERNAL`. 1 line of Dockerfile.
  - (b) Run a tiny Node/Fastify service in a third container, expose `/fill` endpoint, call via HTTP from n8n. More moving parts but cleaner separation.
- **Field-mapping spec format**: hand-written JSON per form? Generated from inspecting AcroForm fields? Hybrid (auto-generate skeleton, hand-edit)?
- **Auth on `portal-fill`**: same `X-Portal-Secret` header as the other CRUD endpoints (until Clerk JWT comes back).

### Phase 2 prerequisites to verify before starting

- Anthropic API key is fine, but pdf-lib doesn't need Claude (it's deterministic). Phase 2 is mostly mechanical.
- VPS disk space for the form library is small (~50MB for the full USCIS set).
- The `persons` table has most of the columns Phase 2 needs. May need to add marriage / spouse fields as columns (not just extracted_fields rows) to make them fill-time accessible.

## Resuming work — quick guide

1. Read this file (you're here).
2. Skim the memory files at `C:\Users\rtrav\.claude\projects\C--sites-katychavez-site\memory\MEMORY.md` for the history / decisions log.
3. Verify the VPS stack is up: `https://n8n.katychavez.com` loads, `docker compose ps` on the VPS shows both containers healthy.
4. Verify the portal is live: `https://katychavez.com/portal` → secret prompt → customer list.
5. For Phase 2: start with the smallest end-to-end slice — load one form template, write a field map for ~10 fields, run pdf-lib through a Code node (after enabling the npm package), output an editable PDF. Validate the whole loop before scaling to the rest.

## Conventions worth following

- **Never paste secrets in chat or commits.** Live values: `/opt/kcl-n8n/.env` on the VPS, plus Rob's password manager. Templates only in `.env.example`.
- **Schema changes are migrations**, never destructive ad-hoc UPDATE statements. Each migration is a numbered file in `n8n/schema/`.
- **Workflow source files** are the canonical version. If you edit a workflow in n8n's UI, back-port it to the `.workflow.ts` file in the same commit.
- **Don't add features without scope-checking against Phase 1 vs Phase 2.** USCIS form fill is Phase 2; resist building it before Phase 1 is shipped + verified by Katy.
- **Keep tenant-specific values in env / config**, not hardcoded. This is intended to be a template for other firms (see memory: `project-kcl-portal-template`).
