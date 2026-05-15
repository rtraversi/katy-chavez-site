// portal-list workflow — paginated customer list with optional search.
// Endpoint: POST https://n8n.katychavez.com/webhook/portal-list
// Auth: shared secret via X-Portal-Secret header ("Portal API Secret" cred in n8n).
//       Stop-gap; will switch to Clerk JWT when the frontend lands.
// Body: { search?: string, limit?: number, offset?: number }
// Returns: { persons: [...], total: number }

import { workflow, trigger, node, newCredential } from '@n8n/workflow-sdk';

const webhookTrigger = trigger({
  type: 'n8n-nodes-base.webhook',
  version: 2.1,
  config: {
    name: 'Webhook',
    parameters: {
      httpMethod: 'POST',
      path: 'portal-list',
      responseMode: 'responseNode',
      authentication: 'headerAuth',
      options: {
        allowedOrigins:
          'https://katychavez.com,https://www.katychavez.com,https://katy-chavez-law.netlify.app',
      },
    },
    credentials: { httpHeaderAuth: newCredential('Portal API Secret') },
    position: [200, 300],
  },
  output: [{ body: { search: '', limit: 50, offset: 0 } }],
});

const listQuery = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'portal_list',
    parameters: {
      operation: 'executeQuery',
      query:
        "=SELECT portal_list(" +
        "'{{ ($json.body && $json.body.search ? $json.body.search : '').replaceAll(\"'\", \"''\") }}'," +
        "{{ Math.min(Math.max(parseInt($json.body && $json.body.limit) || 50, 1), 200) }}," +
        "{{ Math.max(parseInt($json.body && $json.body.offset) || 0, 0) }}" +
        ") AS result;",
    },
    credentials: { postgres: newCredential('Portal Postgres') },
    position: [420, 300],
  },
  output: [{ result: { persons: [], total: 0 } }],
});

const respond = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.5,
  config: {
    name: 'Respond to Webhook',
    parameters: {
      respondWith: 'json',
      responseBody: "={{ JSON.stringify($json.result) }}",
    },
    position: [640, 300],
    executeOnce: true,
  },
  output: [{}],
});

export default workflow('portal-list', 'portal-list')
  .add(webhookTrigger)
  .to(listQuery)
  .to(respond);
