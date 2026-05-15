// portal-update workflow — update editable fields on a person.
// Endpoint: POST https://n8n.katychavez.com/webhook/portal-update
// Auth: shared secret via X-Portal-Secret header ("Portal API Secret" cred in n8n).
//       Stop-gap; will switch to Clerk JWT when the frontend lands.
// Body: { person_id: string (uuid), fields: { [column]: value, ... } }
// Returns: the updated person record (or null if not found)

import { workflow, trigger, node, newCredential } from '@n8n/workflow-sdk';

const webhookTrigger = trigger({
  type: 'n8n-nodes-base.webhook',
  version: 2.1,
  config: {
    name: 'Webhook',
    parameters: {
      httpMethod: 'POST',
      path: 'portal-update',
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
  output: [{ body: { person_id: '00000000-0000-0000-0000-000000000000', fields: {} } }],
});

const updateQuery = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'portal_update',
    parameters: {
      operation: 'executeQuery',
      query:
        "=SELECT portal_update(" +
        "'{{ ($json.body && $json.body.person_id ? $json.body.person_id : '').replaceAll(\"'\", \"''\") }}'::uuid," +
        "'{{ JSON.stringify(($json.body && $json.body.fields) || {}).replaceAll(\"'\", \"''\") }}'::jsonb" +
        ") AS result;",
    },
    credentials: { postgres: newCredential('Portal Postgres') },
    position: [420, 300],
  },
  output: [{ result: null }],
});

const respond = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.5,
  config: {
    name: 'Respond to Webhook',
    parameters: {
      respondWith: 'json',
      responseBody: "={{ JSON.stringify({ success: true, person: $json.result }) }}",
    },
    position: [640, 300],
    executeOnce: true,
  },
  output: [{}],
});

export default workflow('portal-update', 'portal-update')
  .add(webhookTrigger)
  .to(updateQuery)
  .to(respond);
