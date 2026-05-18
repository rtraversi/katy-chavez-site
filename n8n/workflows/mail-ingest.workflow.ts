// mail-ingest workflow — source of truth for n8n
//
// Receives a staff-uploaded USCIS mail scan (one PDF containing multiple
// client notices). Sends the full PDF to Claude for analysis, extracts one
// structured record per client, splits the PDF into individual files with
// pdf-lib, persists everything to the mail_batches + mail_items tables.
//
// Prerequisites:
//   - KCL n8n container built from n8n/Dockerfile (includes pdf-lib)
//   - NODE_FUNCTION_ALLOW_EXTERNAL=pdf-lib in docker-compose.yml
//   - Migration 004_mail_tables.sql applied to the portal DB
//   - /data/mail/ volume mounted (./mail:/data/mail in docker-compose.yml)
//
// Deploy to n8n:
//   1. Create a new workflow in n8n at https://n8n.katychavez.com
//   2. Import this TypeScript via the n8n MCP create_workflow_from_code tool
//      OR paste the generated JSON via the n8n UI Import menu.
//   3. After creation, update the workflow() ID below with the real n8n ID.
//   4. Publish the workflow.

import { workflow, trigger, node, newCredential } from '@n8n/workflow-sdk';

// ── Webhook trigger ──────────────────────────────────────────────────
const webhookTrigger = trigger({
  type: 'n8n-nodes-base.webhook',
  version: 2.1,
  config: {
    name: 'Webhook',
    parameters: {
      httpMethod: 'POST',
      path: 'mail-ingest',
      responseMode: 'responseNode',
      options: {
        binaryData: true,
        binaryPropertyName: 'data',
        allowedOrigins:
          'https://katychavez.com,https://www.katychavez.com,https://katy-chavez-law.netlify.app',
      },
    },
    position: [160, 300],
  },
  output: [{ body: {} }],
});

// ── Persist Scan: save uploaded file to /data/mail/{execId}/ ─────────
const persistScan = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Persist Scan',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `const fs = require('fs');

const item = $input.first();
const binary = item.binary || {};
const execId = String($execution.id);
const baseDir = '/data/mail/' + execId;

fs.mkdirSync(baseDir, { recursive: true });

const keys = Object.keys(binary);
if (keys.length === 0) throw new Error('No file uploaded');

// Accept the first uploaded file. Staff should upload one scan per run.
const fileKey = keys[0];
const file = binary[fileKey];
const originalFilename = file.fileName || 'scan.pdf';
const storagePath = baseDir + '/original.pdf';

const buf = await this.helpers.getBinaryDataBuffer(0, fileKey);
fs.writeFileSync(storagePath, buf);

return [{ json: { execId, storagePath, originalFilename, fileSize: buf.length, baseDir } }];`,
    },
    position: [380, 300],
  },
  output: [{ execId: 'abc', storagePath: '/data/mail/abc/original.pdf', originalFilename: 'scan.pdf', fileSize: 12345, baseDir: '/data/mail/abc' }],
});

// ── Analyze with Claude: identify each client's mail piece ───────────
const analyzeWithClaude = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Analyze with Claude',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `const fs = require('fs');

const info = $input.first().json;
const apiKey = $env.ANTHROPIC_API_KEY;
if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set in container env');

const buf = fs.readFileSync(info.storagePath);
const base64 = buf.toString('base64');

const SYSTEM = 'You are a document processing assistant for an immigration law firm. Respond with valid JSON only. No markdown fences, no preamble, no explanation. Begin your response with [ and end with ].';

const PROMPT = \`You are analyzing a batch scan of USCIS mail received by Katy Chavez Law, an immigration law firm. The scan is a single PDF that may contain multiple separate USCIS notices for different clients — they are scanned consecutively.

Your task:
1. Identify each distinct USCIS mail piece. A new piece typically begins with a USCIS letterhead, case number, or "NOTICE TYPE" heading.
2. For each piece, extract all key information using the exact field names below.
3. Return ONLY a JSON array, one object per mail piece.

For each mail piece, return exactly this structure (use null for missing fields):
{
  "client_name": "LAST, FIRST MI exactly as printed on the notice",
  "client_first_name": "first name only",
  "client_last_name": "last name only",
  "receipt_number": "e.g. LIN2112345678 — no dashes unless USCIS printed them",
  "a_number": "digits only, e.g. 123456789, or null",
  "notice_type": one of exactly: "biometrics_notice" | "approval_notice" | "receipt_notice" | "rfe" | "transfer_notice" | "rejection" | "card_production_ordered" | "other",
  "application_type": "e.g. I-485, I-765, I-131, I-130, I-821D, etc., or null",
  "notice_date": "YYYY-MM-DD or null",
  "appointment_date": "YYYY-MM-DD or null — only for biometrics_notice",
  "appointment_time": "e.g. 8:30 AM or null — only for biometrics_notice",
  "appointment_location": "full address string or null — only for biometrics_notice",
  "appointment_bring": "plain text list of what to bring or null — only for biometrics_notice",
  "summary": "2-3 sentences of plain English: what this notice is, what it means for the client, and what action (if any) they must take. Be specific — include dates and deadlines.",
  "page_numbers": [1, 2]  — 1-indexed list of page numbers in the scan that belong to this mail piece. Blank pages, cover sheets, and separator pages should be attributed to the nearest mail piece.
}

Return the array even if only one mail piece is found. Do not include explanatory text outside the JSON array.\`;

let response;
try {
  response = await this.helpers.httpRequest({
    method: 'POST',
    url: 'https://api.anthropic.com/v1/messages',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: {
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      system: SYSTEM,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'document',
            source: { type: 'base64', media_type: 'application/pdf', data: base64 },
          },
          { type: 'text', text: PROMPT },
        ],
      }],
    },
    json: true,
  });
} catch (e) {
  const status = e && e.httpCode ? e.httpCode : '?';
  throw new Error('Claude API ' + status + ': ' + (e && e.message ? e.message.slice(0, 400) : String(e)));
}

if (!response || !response.content || !response.content[0]) {
  throw new Error('Claude returned empty response: ' + JSON.stringify(response).slice(0, 200));
}

const rawText = response.content[0].text;
let items;
try {
  let s = rawText.trim();
  // Strip markdown fences if present
  if (s.startsWith('\`\`\`')) {
    s = s.replace(/^\`\`\`(?:json)?\\s*\\n?/, '').replace(/\\n?\`\`\`\\s*$/, '');
  }
  items = JSON.parse(s);
} catch (e) {
  // Fallback: find the JSON array in the response
  const start = rawText.indexOf('[');
  const end = rawText.lastIndexOf(']');
  if (start >= 0 && end > start) {
    items = JSON.parse(rawText.slice(start, end + 1));
  } else {
    throw new Error('Could not parse Claude response as JSON array. Raw: ' + rawText.slice(0, 500));
  }
}

if (!Array.isArray(items) || items.length === 0) {
  throw new Error('Claude returned empty or non-array result. Raw: ' + rawText.slice(0, 500));
}

return [{ json: { ...info, items, _claudeRaw: rawText.slice(0, 1000) } }];`,
    },
    position: [600, 300],
  },
  output: [{
    execId: 'abc',
    storagePath: '/data/mail/abc/original.pdf',
    originalFilename: 'scan.pdf',
    baseDir: '/data/mail/abc',
    items: [{ client_name: 'GARCIA, MARIA', client_first_name: 'MARIA', client_last_name: 'GARCIA', notice_type: 'biometrics_notice', page_numbers: [1, 2] }],
  }],
});

// ── Split PDFs: one file per client using pdf-lib ────────────────────
const splitPdfs = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Split PDFs',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `const { PDFDocument } = require('pdf-lib');
const fs = require('fs');

const info = $input.first().json;
const { execId, storagePath, baseDir, items } = info;

const originalBytes = fs.readFileSync(storagePath);
const originalPdf = await PDFDocument.load(originalBytes);
const totalPages = originalPdf.getPageCount();

const itemsWithPaths = [];

for (let i = 0; i < items.length; i++) {
  const item = items[i];

  // Build a filesystem-safe slug from the client name
  const last = (item.client_last_name || 'unknown').toLowerCase().replace(/[^a-z0-9]/g, '');
  const first = (item.client_first_name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const slug = last + (first ? '-' + first : '') + '-' + String(i + 1).padStart(2, '0');
  const itemPath = baseDir + '/' + slug + '.pdf';

  const pageIndices = (item.page_numbers || [])
    .map(n => Number(n) - 1)                        // convert to 0-indexed
    .filter(n => n >= 0 && n < totalPages);

  let splitPath = null;
  if (pageIndices.length > 0) {
    try {
      const newPdf = await PDFDocument.create();
      const copiedPages = await newPdf.copyPages(originalPdf, pageIndices);
      copiedPages.forEach(page => newPdf.addPage(page));
      const pdfBytes = await newPdf.save();
      fs.writeFileSync(itemPath, Buffer.from(pdfBytes));
      splitPath = itemPath;
    } catch (e) {
      // Log but don't fail — item will be recorded without individual PDF
      console.error('PDF split error for ' + slug + ': ' + (e && e.message ? e.message : String(e)));
    }
  }

  itemsWithPaths.push({ ...item, storage_path: splitPath });
}

return [{ json: { ...info, items: itemsWithPaths, pageCount: totalPages } }];`,
    },
    position: [820, 300],
  },
  output: [{
    execId: 'abc',
    storagePath: '/data/mail/abc/original.pdf',
    baseDir: '/data/mail/abc',
    pageCount: 4,
    items: [{ client_name: 'GARCIA, MARIA', storage_path: '/data/mail/abc/garcia-maria-01.pdf', page_numbers: [1, 2] }],
  }],
});

// ── Insert via mail_intake stored function ───────────────────────────
const mailInsert = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Insert via mail_intake',
    parameters: {
      operation: 'executeQuery',
      query:
        "=SELECT mail_intake(" +
        "'{{ $json.execId }}'," +
        "'{{ ($json.originalFilename || '').replaceAll(\"'\", \"''\") }}'," +
        "'{{ $json.storagePath }}'," +
        "{{ $json.pageCount }}," +
        "'{{ JSON.stringify($json.items).replaceAll(\"'\", \"''\") }}'::jsonb" +
        ") AS result;",
    },
    credentials: { postgres: newCredential('Portal Postgres') },
    position: [1040, 300],
  },
  output: [{ result: { batch_id: '...', item_ids: [], item_count: 1 } }],
});

// ── Respond to webhook ───────────────────────────────────────────────
const respond = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.5,
  config: {
    name: 'Respond to Webhook',
    parameters: {
      respondWith: 'json',
      responseBody:
        "={{ JSON.stringify({ success: true, batch_id: $json.result.batch_id, item_count: $json.result.item_count, item_ids: $json.result.item_ids }) }}",
    },
    position: [1260, 300],
    executeOnce: true,
  },
  output: [{}],
});

export default workflow('WxijwOWgZ3dTm3J6', 'mail-ingest')
  .add(webhookTrigger)
  .to(persistScan)
  .to(analyzeWithClaude)
  .to(splitPdfs)
  .to(mailInsert)
  .to(respond);
