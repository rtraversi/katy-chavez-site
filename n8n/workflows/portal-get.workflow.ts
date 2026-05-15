// portal-get workflow — full record for one person.
// Endpoint: POST https://n8n.katychavez.com/webhook/portal-get
// Auth: Clerk JWT (via Clerk JWT credential in n8n)
// Body: { person_id: string (uuid) }
// Returns: { person, case, related_persons, documents, extracted_fields }

import { workflow, trigger, node, newCredential } from '@n8n/workflow-sdk';

const webhookTrigger = trigger({
  type: 'n8n-nodes-base.webhook',
  version: 2.1,
  config: {
    name: 'Webhook',
    parameters: {
      httpMethod: 'POST',
      path: 'portal-get',
      responseMode: 'responseNode',
      authentication: 'jwtAuth',
      options: {
        allowedOrigins:
          'https://katychavez.com,https://www.katychavez.com,https://katy-chavez-law.netlify.app',
      },
    },
    credentials: { jwtAuth: newCredential('Clerk JWT') },
    position: [200, 300],
  },
  output: [{ body: { person_id: '00000000-0000-0000-0000-000000000000' } }],
});

const getQuery = node({
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
    position: [420, 300],
  },
  output: [{ result: { person: null, case: null, related_persons: [], documents: [], extracted_fields: [] } }],
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

export default workflow('portal-get', 'portal-get')
  .add(webhookTrigger)
  .to(getQuery)
  .to(respond);
