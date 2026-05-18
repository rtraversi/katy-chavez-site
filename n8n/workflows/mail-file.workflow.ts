// mail-file workflow — source of truth for n8n
//
// GET /webhook/mail-file?id={uuid}&token={secret}
// Validates the PORTAL_SECRET token, looks up the mail item UUID in the portal
// DB, reads the individual split PDF from /data/mail/, and streams it back as a
// binary PDF download attachment.
//
// UUID-based (not path-based) so that Monday.com links remain valid even if
// /data/mail/ is migrated to a different VPS or storage provider.
//
// Prerequisites:
//   - mail-ingest workflow deployed (writes mail_items + splits PDFs)
//   - Migration 004_mail_tables.sql applied
//   - Portal Postgres credential configured in n8n
//   - /data/mail/ volume mounted
//
// Deploy:
//   - Workflow ID: fGW97vB7688WCeDC (n8n.katychavez.com)
//   - Production URL: https://n8n.katychavez.com/webhook/mail-file?id=...&token=...

import { workflow, trigger, node, newCredential, expr } from '@n8n/workflow-sdk';

const webhookTrigger = trigger({
  type: 'n8n-nodes-base.webhook',
  version: 2.1,
  config: {
    name: 'Mail File Webhook',
    parameters: {
      httpMethod: 'GET',
      path: 'mail-file',
      responseMode: 'responseNode',
      options: {},
    },
    position: [160, 300],
  },
  output: [{ query: { id: 'abc-123', token: 'secret' } }],
});

const validateRequest = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Validate Request',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `const query = $input.first().json.query || {};
const token = query.token;
const id = query.id;

if (!token || token !== $env.PORTAL_SECRET) {
  throw new Error('Unauthorized');
}
if (!id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
  throw new Error('Invalid ID format');
}
return [{ json: { id } }];`,
    },
    position: [380, 300],
  },
  output: [{ id: 'abc-123' }],
});

const getFilePath = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Get File Path',
    parameters: {
      operation: 'executeQuery',
      query: "=SELECT storage_path, original_filename FROM mail_items WHERE id = '{{ $json.id }}'",
    },
    credentials: { postgres: newCredential('Portal Postgres') },
    position: [600, 300],
  },
  output: [{ storage_path: '/data/mail/abc/garcia-maria-01.pdf', original_filename: 'scan.pdf' }],
});

const readFile = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Read File',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `const fs = require('fs');
const info = $input.first().json;
const storagePath = info.storage_path;

if (!storagePath) throw new Error('File not found in database');
if (!fs.existsSync(storagePath)) throw new Error('File not on disk: ' + storagePath);

const buf = fs.readFileSync(storagePath);
const parts = storagePath.split('/');
const filename = parts[parts.length - 1] || 'notice.pdf';
const binaryData = await this.helpers.prepareBinaryData(buf, filename, 'application/pdf');

return [{ json: { filename }, binary: { data: binaryData } }];`,
    },
    position: [820, 300],
  },
  output: [{ filename: 'garcia-maria-01.pdf' }],
});

const respondWithFile = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.5,
  config: {
    name: 'Respond with File',
    parameters: {
      respondWith: 'binary',
      responseDataSource: 'automatically',
      options: {
        responseHeaders: {
          entries: [
            {
              name: 'Content-Disposition',
              value: expr('attachment; filename="{{ $json.filename }}"'),
            },
          ],
        },
      },
    },
    position: [1040, 300],
  },
  output: [{}],
});

export default workflow('fGW97vB7688WCeDC', 'mail-file')
  .add(webhookTrigger)
  .to(validateRequest)
  .to(getFilePath)
  .to(readFile)
  .to(respondWithFile);
