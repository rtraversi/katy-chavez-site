// portal-prima-push workflow — push a KCL person record to Prima.law via Zapier.
//
// Endpoint: POST https://n8n.katychavez.com/webhook/portal-prima-push
// Auth:     headerAuth X-Portal-Secret ("Portal API Secret" cred in n8n)
// Body:     { person_id: UUID }
//
// Flow:
//   1. Fetch full person record from Postgres via portal_get()
//   2. Map + reformat all populated fields to Prima.law's Zapier field schema
//   3. POST the payload to the Zapier webhook (ZAPIER_PRIMA_HOOK env var)
//   4. Respond with { success, person_id, primaPayload }
//
// The Zapier Zap handles SearchContact → Update (if found) or Create (if not).
// See docs below for Zap setup.
//
// Required env on VPS (/opt/kcl-n8n/.env):
//   ZAPIER_PRIMA_HOOK=https://hooks.zapier.com/hooks/catch/XXXXXXX/XXXXXXX/
//
// ── Zapier Zap Setup ────────────────────────────────────────────────────────
//
// Create ONE Zap in your Zapier account:
//
//   Trigger:  Webhooks by Zapier → Catch Hook
//             Copy the webhook URL → paste as ZAPIER_PRIMA_HOOK in VPS .env
//
//   Step 2:   Prima.law → Search Contact
//             • Email: {{data__email}}   (leave blank to skip if no email)
//             • First Name: {{data__firstName}}
//             • Last Name:  {{data__lastName}}
//
//   Step 3:   Paths by Zapier (requires Professional plan)
//     Path A — "Contact exists"
//       Rule: Step 2 · Contact ID · (Text) Exists
//       Action: Prima.law → Update Contact
//               Contact ID: {{2. Contact ID}}
//               Map all other fields from {{data__*}} same as Path B below
//     Path B — "New contact"
//       Rule: Step 2 · Contact ID · (Text) Does not exist
//       Action: Prima.law → Create New Contact
//               firstName: {{data__firstName}}
//               lastName:  {{data__lastName}}
//               email:     {{data__email}}
//               birthDate: {{data__birthDate}}          (mm-dd-yyyy)
//               sex:       {{data__sex}}                (male/female)
//               alienNumber:           {{data__alienNumber}}
//               socialSecurityNumber:  {{data__socialSecurityNumber}}
//               i94Number:             {{data__i94Number}}
//               pobCity:               {{data__pobCity}}
//               pobState:              {{data__pobState}}
//               pobCountry:            {{data__pobCountry}}
//               citizenship:           {{data__citizenship}}
//               currentImmigrationStatus: {{data__currentImmigrationStatus}}
//               dateOfLastEntryToUs:   {{data__dateOfLastEntryToUs}}
//               othersNamesUsed:       {{data__othersNamesUsed}}
//               lprExp:                {{data__lprExp}}
//               classAdmissionLpr:     {{data__classAdmissionLpr}}
//
//   Step 4 (optional, add to BOTH paths):
//     Prima.law → Create New Phone Number
//       Contact ID: (from Create/Update step)
//       Phone Number: {{data__phone}}
//       Filter: only run if {{data__phone}} has value
//
// ── Starter-plan fallback (no Paths) ────────────────────────────────────────
// If you don't have Paths, use a single "Create New Contact" action after
// a Filter step:  "Only continue if: Step 2 · Contact ID · Does not exist"
// This prevents duplicates; existing contacts won't be updated (manual update
// in Prima.law until you upgrade to Professional plan).
//
// ── Workflow ID ──────────────────────────────────────────────────────────────
// Assign after first deploy to n8n: (TBD)

import { workflow, trigger, node, newCredential } from '@n8n/workflow-sdk';

// ── 1. Webhook trigger ───────────────────────────────────────────────────────
const webhookTrigger = trigger({
  type: 'n8n-nodes-base.webhook',
  version: 2.1,
  config: {
    name: 'Webhook',
    parameters: {
      httpMethod: 'POST',
      path: 'portal-prima-push',
      responseMode: 'responseNode',
      authentication: 'headerAuth',
      options: {
        allowedOrigins:
          'https://katychavez.com,https://www.katychavez.com,https://katy-chavez-law.netlify.app',
      },
    },
    credentials: { httpHeaderAuth: newCredential('Portal API Secret') },
    position: [0, 0],
  },
  output: [{ body: { person_id: '00000000-0000-0000-0000-000000000000' } }],
});

// ── 2. Postgres: fetch full person record ────────────────────────────────────
const getPersonQuery = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'portal_get',
    parameters: {
      operation: 'executeQuery',
      query:
        "=SELECT portal_get('{{ ($json.body && $json.body.person_id ? $json.body.person_id : '').replaceAll(\"'\", \"''\") }}'::uuid) AS result;",
    },
    credentials: { postgres: newCredential('Portal Postgres') },
    position: [220, 0],
  },
  output: [{ result: { person: null, case: null, related_persons: [], documents: [], extracted_fields: [] } }],
});

// ── 3. Code: format fields + POST to Zapier ──────────────────────────────────
const formatAndPush = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Format + Push to Zapier',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `// ── Pull person record ───────────────────────────────────────────────────────
const item = $input.first();
const result = item.json.result;
if (!result || !result.person) throw new Error('Person not found for this ID');
const p = result.person;

// ── Helpers ───────────────────────────────────────────────────────────────────

// ISO yyyy-mm-dd → mm-dd-yyyy (Prima.law birthDate / date field format)
function isoToMD(iso) {
  if (!iso) return undefined;
  const m = String(iso).match(/^(\\d{4})-(\\d{2})-(\\d{2})/);
  return m ? m[2] + '-' + m[3] + '-' + m[1] : undefined;
}

// Alien number: strip non-digits → xxx-xxx-xxx
function fmtAlien(a) {
  if (!a) return undefined;
  const d = String(a).replace(/\\D/g, '');
  return d.length === 9 ? d.slice(0,3)+'-'+d.slice(3,6)+'-'+d.slice(6) : String(a);
}

// SSN: strip non-digits → xxx-xx-xxxx
function fmtSSN(s) {
  if (!s) return undefined;
  const d = String(s).replace(/\\D/g, '');
  return d.length === 9 ? d.slice(0,3)+'-'+d.slice(3,5)+'-'+d.slice(5) : String(s);
}

// Sex enum: KCL M/F → Prima.law male/female (X has no Prima equivalent, skip)
function fmtSex(s) {
  if (s === 'M') return 'male';
  if (s === 'F') return 'female';
  return undefined;
}

// Only include a field in the payload if it has a real value
function val(v) {
  return (v !== null && v !== undefined && v !== '') ? v : undefined;
}

// ── Build Prima.law payload (skip any undefined values) ───────────────────────
const payload = {};

// Required identity
if (val(p.name_given))  payload.firstName = p.name_given;
if (val(p.name_family)) payload.lastName  = p.name_family;

// Personal details
if (val(p.email))             payload.email               = p.email;
if (isoToMD(p.dob))           payload.birthDate           = isoToMD(p.dob);
if (fmtSex(p.sex))            payload.sex                 = fmtSex(p.sex);
if (fmtAlien(p.a_number))     payload.alienNumber         = fmtAlien(p.a_number);
if (fmtSSN(p.ssn))            payload.socialSecurityNumber = fmtSSN(p.ssn);
if (val(p.name_alternate))    payload.othersNamesUsed     = p.name_alternate;

// Place of birth — split "City, State" best-effort; pobCountry is separate
if (val(p.place_of_birth)) {
  const parts = String(p.place_of_birth).split(',').map(s => s.trim());
  payload.pobCity = parts[0];
  if (parts[1]) payload.pobState = parts[1];
}
if (val(p.country_of_birth))       payload.pobCountry             = p.country_of_birth;
if (val(p.country_of_citizenship)) payload.citizenship            = p.country_of_citizenship;

// Immigration status
if (val(p.immigration_status))     payload.currentImmigrationStatus = p.immigration_status;
if (isoToMD(p.last_entry_date))    payload.dateOfLastEntryToUs    = isoToMD(p.last_entry_date);
if (val(p.i94_number))             payload.i94Number              = p.i94_number;
if (isoToMD(p.gc_expiry))          payload.lprExp                 = isoToMD(p.gc_expiry);
if (val(p.gc_category))            payload.classAdmissionLpr      = p.gc_category;

// Contact — included for Zapier Zap to use in CreateNewPhoneNumber step
if (val(p.phone))           payload.phone          = p.phone;
if (val(p.current_address)) payload.currentAddress = p.current_address;

// Sanity check: must have at least first + last name
if (!payload.firstName || !payload.lastName) {
  throw new Error('Person is missing first or last name — cannot push to Prima.law');
}

// ── POST to Zapier webhook ─────────────────────────────────────────────────────
const hookUrl = $env.ZAPIER_PRIMA_HOOK;
if (!hookUrl) throw new Error('ZAPIER_PRIMA_HOOK env var is not set on the VPS');

const resp = await this.helpers.httpRequest({
  method: 'POST',
  url: hookUrl,
  headers: { 'Content-Type': 'application/json' },
  body: payload,
  json: true,
});

return [{ json: { success: true, person_id: p.id, primaPayload: payload, zapierResponse: resp } }];`,
    },
    position: [440, 0],
  },
  output: [{ success: true, person_id: '', primaPayload: {}, zapierResponse: {} }],
});

// ── 4. Respond ───────────────────────────────────────────────────────────────
const respond = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.5,
  config: {
    name: 'Respond to Webhook',
    parameters: {
      respondWith: 'json',
      responseBody:
        '={{ JSON.stringify({ success: $json.success, person_id: $json.person_id, primaPayload: $json.primaPayload }) }}',
    },
    position: [660, 0],
    executeOnce: true,
  },
  output: [{}],
});

export default workflow('portal-prima-push', 'portal-prima-push')
  .add(webhookTrigger)
  .to(getPersonQuery)
  .to(formatAndPush)
  .to(respond);
