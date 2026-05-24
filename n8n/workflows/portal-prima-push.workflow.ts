// portal-prima-push workflow — push a KCL person record to Prima.law via Zapier.
//
// Endpoint: POST https://n8n.katychavez.com/webhook/portal-prima-push
// Auth:     headerAuth X-Portal-Secret ("Portal API Secret" cred in n8n)
// Body:     { person_id: UUID }
// Trigger:  Manual — staff clicks "↑ Prima.law" on the customer card after review.
//           Never fires automatically on save.
//
// Flow:
//   1. Fetch full person record from Postgres via portal_get()
//   2. Map + reformat all populated fields to Prima.law's Zapier field schema
//   3. POST the payload to the Zapier webhook (ZAPIER_PRIMA_HOOK env var)
//   4. Respond with { success, person_id, primaPayload }
//
// The Zapier Zap handles dedup (SearchContact by phone → Update or Create)
// and then creates the phone number record linked to the contact.
//
// Required env on VPS (/opt/kcl-n8n/.env):
//   ZAPIER_PRIMA_HOOK=https://hooks.zapier.com/hooks/catch/XXXXXXX/XXXXXXX/
//
// ── Dedup strategy ───────────────────────────────────────────────────────────
// Search PRIMARY by phone number — attorneys use phone as the primary
// client lookup in Prima.law. Not email-first because clients don't always
// have email, but all clients have a phone number.
// If phone search returns a match → Update that contact.
// If no match → Create new contact.
// Note: If a family member shares the same phone as the primary client,
// staff should verify the match in Prima.law before pushing (rare edge case).
//
// ── Which persons to push ────────────────────────────────────────────────────
// Push ONE person at a time — staff opens that person's card and clicks the
// button. The BENEFICIARY is always the primary person on a case.
// Push the beneficiary first. Related persons (petitioner, spouse) can be
// pushed individually from their own cards.
//
// RELATIONSHIP LINKING IN PRIMA.LAW:
// Prima.law has a relationship manager, but its Zapier actions for family
// members (new_family_member / update_family_member) expose NO configurable
// parameters — they cannot be used as write actions from Zapier.
// The only automated relationship option is the `relatedContactId` field on
// CreateNewContact, which links a new contact to an existing one by Prima.law
// contact ID. We don't yet store Prima.law IDs in KCL, so this is a
// manual step for now: after pushing a beneficiary and a petitioner, link
// them in Prima.law's UI (People → Relationships tab).
// Future enhancement: add a `prima_contact_id` column to the persons table
// so KCL can pass relatedContactId automatically when pushing related persons.
//
// ── Zapier Zap Setup ─────────────────────────────────────────────────────────
//
// Create ONE Zap in your Zapier account:
//
//   Step 1 — TRIGGER
//     Webhooks by Zapier → Catch Hook
//     Copy the webhook URL → paste as ZAPIER_PRIMA_HOOK in VPS .env
//     Turn on the Zap, then test-fire from the portal to confirm receipt.
//
//   Step 2 — SEARCH (phone-first dedup)
//     Prima.law → Search Contact
//       Phone Number: {{data__phone}}
//       Last Name:    {{data__lastName}}   ← secondary check
//     This returns the contact's ID if found.
//
//   Step 3 — PATHS (requires Zapier Professional plan)
//
//     Path A — "Contact found"
//       Rule: Step 2 · Contact ID · (Text) Exists
//       Action: Prima.law → Update Contact
//         Contact ID:  {{2. Contact ID}}
//         firstName:   {{data__firstName}}
//         lastName:    {{data__lastName}}
//         email:       {{data__email}}
//         birthDate:   {{data__birthDate}}
//         sex:         {{data__sex}}
//         alienNumber:              {{data__alienNumber}}
//         socialSecurityNumber:     {{data__socialSecurityNumber}}
//         i94Number:                {{data__i94Number}}
//         pobCity:                  {{data__pobCity}}
//         pobState:                 {{data__pobState}}
//         pobCountry:               {{data__pobCountry}}
//         citizenship:              {{data__citizenship}}
//         currentImmigrationStatus: {{data__currentImmigrationStatus}}
//         dateOfLastEntryToUs:      {{data__dateOfLastEntryToUs}}
//         othersNamesUsed:          {{data__othersNamesUsed}}
//         lprExp:                   {{data__lprExp}}
//         classAdmissionLpr:        {{data__classAdmissionLpr}}
//
//     Path B — "New contact"
//       Rule: Step 2 · Contact ID · (Text) Does not exist
//       Action: Prima.law → Create New Contact
//         (same field mapping as Path A above)
//
//   Step 4 — PHONE (add inside BOTH Path A and Path B)
//     Add a Filter first: Only continue if {{data__phone}} has value
//     Prima.law → Create New Phone Number
//       Contact ID:    {{3. Contact ID}}   ← from whichever Create/Update ran
//       Number:        {{data__phone}}
//       Type:          mobile              ← hard-code; immigration clients use mobile
//       Best time:     {{data__phoneAvailableAt}}  (leave blank unless added later)
//     NOTE: This creates a new phone record each push. Prima.law deduplicates
//     phone numbers on its side, but verify this doesn't double-add on updates.
//
// ── Starter-plan fallback (no Paths) ─────────────────────────────────────────
// If you don't have Paths, use two separate Zaps sharing NO webhook URL:
//   Zap 1 "Create":  Webhook → Search Contact → Filter (Contact ID does NOT exist)
//                    → Create New Contact → Create New Phone Number
//   Zap 2 "Update":  (separate webhook URL) → Update Contact → (update phone)
//   Then add a second env var ZAPIER_PRIMA_UPDATE_HOOK and modify the Code node
//   below to call the appropriate URL based on... actually, without a search step
//   in n8n, you can't know which to call. Simplest Starter fallback:
//   → Just use Zap 1 (Create with Filter). No auto-update; staff updates manually.
//   → Upgrade to Professional when the volume warrants it.
//
// ── Address note ─────────────────────────────────────────────────────────────
// KCL stores current_address as free text. Prima.law's CreateNewAddress action
// requires separate city/state/zip fields. Address is NOT pushed automatically.
// Staff can add it manually in Prima.law, or a future enhancement can parse
// the address string (regex for US addresses or an address-parsing npm package).
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
