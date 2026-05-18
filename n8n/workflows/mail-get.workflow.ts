// mail-get workflow — source of truth for n8n
//
// Returns full detail for one mail item plus the individual client PDF
// encoded as base64 (for the portal's Download button). Requires
// X-Portal-Secret header.
//
// Body: { id: "<mail_item_uuid>" }
// Response: { item: {...}, batch: {...}, pdf_base64: "..." | null }
//
// Deploy: create in n8n at https://n8n.katychavez.com, then update the
// workflow() ID below with the real ID and update CLAUDE.md.

import { workflow, trigger, node, newCredential } from '@n8n/workflow-sdk';

// ── Webhook trigger (authenticated) ─────────────────────────────────
const webhookTrigger = trigger({
  type: 'n8n-nodes-base.webhook',
  version: 2.1,
  config: {
    name: 'Webhook',
    parameters: {
      httpMethod: 'POST',
      path: 'mail-get',
      responseMode: 'responseNode',
      authentication: 'headerAuth',
      options: {},
    },
    credentials: { headerAuth: newCredential('Portal API Secret') },
    position: [160, 300],
  },
  output: [{ body: { id: 'some-uuid' } }],
});

// ── Fetch via mail_get stored function ───────────────────────────────
const getQuery = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Query mail_get',
    parameters: {
      operation: 'executeQuery',
      query: "=SELECT mail_get('{{ $json.body.id }}'::uuid) AS result;",
    },
    credentials: { postgres: newCredential('Portal Postgres') },
    position: [380, 300],
  },
  output: [{ result: { item: {}, batch: {} } }],
});

// ── Read PDF from disk and attach as base64 ──────────────────────────
const readPdf = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Read PDF',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `const fs = require('fs');

const dbResult = $input.first().json.result;

// If DB returned an error, pass it through
if (dbResult && dbResult.error) {
  return [{ json: { ...dbResult, pdf_base64: null } }];
}

const storagePath = dbResult && dbResult.item && dbResult.item.storage_path;
let pdf_base64 = null;

if (storagePath) {
  try {
    const buf = fs.readFileSync(storagePath);
    pdf_base64 = buf.toString('base64');
  } catch (e) {
    // File missing (split may have failed) — return null, portal shows fallback
    pdf_base64 = null;
  }
}

return [{ json: { ...dbResult, pdf_base64 } }];`,
    },
    position: [600, 300],
  },
  output: [{ item: {}, batch: {}, pdf_base64: null }],
});

// ── Respond to webhook ───────────────────────────────────────────────
const respond = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.5,
  config: {
    name: 'Respond to Webhook',
    parameters: {
      respondWith: 'json',
      responseBody: '={{ JSON.stringify($json) }}',
    },
    position: [820, 300],
    executeOnce: true,
  },
  output: [{}],
});

export default workflow('eAUb4gNHZ0Y0YMZ8', 'mail-get')
  .add(webhookTrigger)
  .to(getQuery)
  .to(readPdf)
  .to(respond);
