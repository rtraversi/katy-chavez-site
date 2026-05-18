// mail-list workflow — source of truth for n8n
//
// Returns a paginated, searchable list of mail items for the portal
// Mail Sorting tab. Requires the X-Portal-Secret header.
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
      path: 'mail-list',
      responseMode: 'responseNode',
      authentication: 'headerAuth',
      options: {},
    },
    credentials: { headerAuth: newCredential('Portal API Secret') },
    position: [160, 300],
  },
  output: [{ body: { search: '', limit: 50, offset: 0 } }],
});

// ── Query via mail_list stored function ──────────────────────────────
const listQuery = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Query mail_list',
    parameters: {
      operation: 'executeQuery',
      query:
        "=SELECT mail_list(" +
        "'{{ ($json.body && $json.body.search) ? String($json.body.search).replaceAll(\"'\", \"''\") : '' }}'," +
        "{{ ($json.body && $json.body.limit) ? Number($json.body.limit) : 50 }}," +
        "{{ ($json.body && $json.body.offset) ? Number($json.body.offset) : 0 }}" +
        ") AS result;",
    },
    credentials: { postgres: newCredential('Portal Postgres') },
    position: [380, 300],
  },
  output: [{ result: { items: [], total: 0 } }],
});

// ── Respond to webhook ───────────────────────────────────────────────
const respond = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.5,
  config: {
    name: 'Respond to Webhook',
    parameters: {
      respondWith: 'json',
      responseBody: '={{ JSON.stringify($json.result) }}',
    },
    position: [600, 300],
    executeOnce: true,
  },
  output: [{}],
});

export default workflow('mail-list-tbd', 'mail-list')
  .add(webhookTrigger)
  .to(listQuery)
  .to(respond);
