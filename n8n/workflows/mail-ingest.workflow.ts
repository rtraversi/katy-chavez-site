// mail-ingest workflow — source of truth for n8n
//
// Receives a staff-uploaded USCIS mail scan (one PDF containing multiple
// client notices). Sends the full PDF to Claude for analysis, extracts one
// structured record per client, splits the PDF into individual files with
// pdf-lib, persists everything to the mail_batches + mail_items tables,
// posts a Monday.com update per client with a download link, and emails a
// summary to katychavezlaw@gmail.com.
//
// Prerequisites:
//   - KCL n8n container built from n8n/Dockerfile (includes pdf-lib)
//   - NODE_FUNCTION_ALLOW_EXTERNAL=pdf-lib in docker-compose.yml
//   - Migration 004_mail_tables.sql applied to the portal DB
//   - /data/mail/ volume mounted (./mail:/data/mail in docker-compose.yml)
//   - Portal Postgres credential configured in n8n
//   - KCL Gmail (smtp) credential configured in n8n
//   - KCL Monday (mondayComApi) credential configured in n8n
//
// Deploy to n8n:
//   - Workflow ID: WxijwOWgZ3dTm3J6 (n8n.katychavez.com)

import { workflow, trigger, node, newCredential, expr } from '@n8n/workflow-sdk';

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
    position: [0, 0],
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

const fileKey = keys[0];
const file = binary[fileKey];
const originalFilename = file.fileName || 'scan.pdf';
const storagePath = baseDir + '/original.pdf';

const buf = await this.helpers.getBinaryDataBuffer(0, fileKey);
fs.writeFileSync(storagePath, buf);

return [{ json: { execId, storagePath, originalFilename, fileSize: buf.length, baseDir } }];`,
    },
    position: [224, 0],
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

const SYSTEM = 'You are a document processing assistant for an immigration law firm. Respond with valid JSON only. No markdown fences, no preamble, no explanation. Begin your response with [ and end with ]. All string values must be on a single line with no literal newline or tab characters inside them.';

const PROMPT = \`You are analyzing a batch scan of USCIS mail received by Katy Chavez Law. The scan is a single PDF that may contain multiple separate USCIS notices for different clients scanned consecutively.

Your task:
1. Identify each distinct USCIS mail piece.
2. For each piece, extract all key information using the exact field names below.
3. Return ONLY a JSON array, one object per mail piece.

For each mail piece return exactly this structure (use null for missing fields):
{
  "client_name": "LAST, FIRST MI exactly as printed",
  "client_first_name": "first name only",
  "client_last_name": "last name only",
  "receipt_number": "e.g. LIN2112345678",
  "a_number": "digits only or null",
  "notice_type": one of: "biometrics_notice" | "approval_notice" | "receipt_notice" | "rfe" | "transfer_notice" | "rejection" | "card_production_ordered" | "other",
  "application_type": "e.g. I-485 or null",
  "notice_date": "YYYY-MM-DD or null",
  "appointment_date": "YYYY-MM-DD or null",
  "appointment_time": "e.g. 8:30 AM or null",
  "appointment_location": "full address on one line or null",
  "appointment_bring": "comma-separated list of items to bring or null",
  "summary": "2-3 sentences on a single line: what this notice is, what it means, and any action required. Include dates.",
  "page_numbers": [1, 2]
}

Return the array even if only one mail piece is found. No text outside the JSON array.\`;

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
      messages: [{ role: 'user', content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } },
        { type: 'text', text: PROMPT },
      ]}],
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

// Sanitize Claude JSON: fix literal control chars and invalid escape sequences inside string values.
// Uses String.fromCharCode(92) for backslash to avoid JS escape-sequence ambiguity across eval layers.
function sanitizeJsonStrings(str) {
  var bs = String.fromCharCode(92);
  var result = '';
  var inString = false;
  var escape = false;
  for (var i = 0; i < str.length; i++) {
    var c = str[i];
    var code = c.charCodeAt(0);
    if (escape) {
      if (c === '"' || c === bs || c === '/' || c === 'n' || c === 'r' || c === 't' || c === 'b' || c === 'f' || c === 'u') {
        result += c;
      } else {
        result += bs + c;
      }
      escape = false;
    } else if (inString && c === bs) {
      result += c;
      escape = true;
    } else if (c === '"') {
      inString = !inString;
      result += c;
    } else if (inString && code < 32) {
      if (code === 10) result += bs + 'n';
      else if (code === 13) result += bs + 'r';
      else if (code === 9) result += bs + 't';
      else if (code === 8) result += bs + 'b';
      else if (code === 12) result += bs + 'f';
      else result += bs + 'u' + code.toString(16).padStart(4, '0');
    } else {
      result += c;
    }
  }
  return result;
}

function tryParse(s) {
  try { return JSON.parse(s); } catch (_e) {}
  var san = sanitizeJsonStrings(s);
  try { return JSON.parse(san); } catch (e2) {
    var posMatch = e2 && e2.message && e2.message.match(/position (\\d+)/);
    var pos = posMatch ? parseInt(posMatch[1]) : 0;
    var ctx = san.slice(Math.max(0, pos - 120), pos + 120);
    throw new Error('JSON parse failed after sanitize: ' + (e2 && e2.message) + ' | context: ' + ctx);
  }
}

var items;
try {
  var s = rawText.trim();
  if (s.startsWith('\`\`\`')) {
    s = s.replace(/^\`\`\`(?:json)?\\s*\\n?/, '').replace(/\\n?\`\`\`\\s*$/, '');
  }
  items = tryParse(s);
} catch (e) {
  var start = rawText.indexOf('[');
  var end = rawText.lastIndexOf(']');
  if (start >= 0 && end > start) {
    items = tryParse(rawText.slice(start, end + 1));
  } else {
    throw new Error('Could not find JSON array in Claude response. Raw: ' + rawText.slice(0, 500));
  }
}

if (!Array.isArray(items) || items.length === 0) {
  throw new Error('Claude returned empty or non-array result. Raw: ' + rawText.slice(0, 500));
}

return [{ json: { ...info, items, _claudeRaw: rawText.slice(0, 1000) } }];`,
    },
    position: [448, 0],
  },
  output: [{
    execId: 'abc',
    storagePath: '/data/mail/abc/original.pdf',
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
  const last = (item.client_last_name || 'unknown').toLowerCase().replace(/[^a-z0-9]/g, '');
  const first = (item.client_first_name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const slug = last + (first ? '-' + first : '') + '-' + String(i + 1).padStart(2, '0');
  const itemPath = baseDir + '/' + slug + '.pdf';
  const pageIndices = (item.page_numbers || []).map(n => Number(n) - 1).filter(n => n >= 0 && n < totalPages);
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
      console.error('PDF split error for ' + slug + ': ' + (e && e.message ? e.message : String(e)));
    }
  }
  itemsWithPaths.push({ ...item, storage_path: splitPath });
}
return [{ json: { ...info, items: itemsWithPaths, pageCount: totalPages } }];`,
    },
    position: [672, 0],
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
    position: [896, 0],
  },
  output: [{ result: { batch_id: 'batch-uuid', item_ids: ['item-uuid-1'], item_count: 1 } }],
});

// ── Fetch inserted items with their UUIDs for Monday + email ─────────
const getBatchItems = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Get Batch Items',
    parameters: {
      operation: 'executeQuery',
      query: "=SELECT id, client_name, client_first_name, client_last_name, notice_type, application_type, summary, notice_date FROM mail_items WHERE batch_id = '{{ $json.result.batch_id }}' ORDER BY created_at",
    },
    credentials: { postgres: newCredential('Portal Postgres') },
    position: [1120, 0],
  },
  output: [{ id: 'item-uuid-1', client_name: 'GARCIA, MARIA', client_first_name: 'MARIA', client_last_name: 'GARCIA', notice_type: 'biometrics_notice', application_type: 'I-485', summary: 'Biometrics appointment scheduled.', notice_date: '2026-05-15' }],
});

// ── Post Monday updates + build email summary ────────────────────────
const mondayAndEmail = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Monday and Email',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `var self = this;
var items = $input.all().map(function(i) { return i.json; });
var portalSecret = $env.PORTAL_SECRET;
var mondayApiKey = $env.MONDAY_API_KEY || '';
var BOARD_ID = '2468110147';
var BASE_URL = 'https://n8n.katychavez.com/webhook/mail-file';
var today = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

var clientMap = {};
for (var i = 0; i < items.length; i++) {
  var item = items[i];
  var key = item.client_name || 'UNKNOWN';
  if (!clientMap[key]) {
    clientMap[key] = { name: key, firstName: item.client_first_name || '', lastName: item.client_last_name || '', notices: [] };
  }
  clientMap[key].notices.push(item);
}
var clients = Object.values(clientMap);
var foundClients = [];
var notFoundClients = [];

async function searchMonday(term) {
  var safe = term.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  var gql = 'query ($boardId: ID!) { boards(ids: [$boardId]) { items_page(limit: 10, query_params: {rules: [{column_id: "name", compare_value: "' + safe + '", operator: contains_text}]}) { items { id name } } } }';
  var resp = await self.helpers.httpRequest({
    method: 'POST',
    url: 'https://api.monday.com/v2',
    headers: { 'Authorization': mondayApiKey, 'Content-Type': 'application/json', 'API-Version': '2024-10' },
    body: { query: gql, variables: { boardId: BOARD_ID } },
    json: true,
  });
  if (resp.errors) throw new Error('Monday search error: ' + JSON.stringify(resp.errors[0]));
  var boards = resp && resp.data && resp.data.boards;
  if (!boards || boards.length === 0) return [];
  var page = boards[0].items_page;
  return page ? (page.items || []) : [];
}

async function postUpdate(mondayItemId, body) {
  var mutation = 'mutation Post($itemId: ID!, $body: String!) { create_update(item_id: $itemId, body: $body) { id } }';
  await self.helpers.httpRequest({
    method: 'POST',
    url: 'https://api.monday.com/v2',
    headers: { 'Authorization': mondayApiKey, 'Content-Type': 'application/json', 'API-Version': '2024-10' },
    body: { query: mutation, variables: { itemId: String(mondayItemId), body: body } },
    json: true,
  });
}

for (var ci = 0; ci < clients.length; ci++) {
  var client = clients[ci];
  var lastName = client.lastName;
  var firstName = client.firstName;
  var lastLower = lastName.toLowerCase();
  var firstLower = firstName.toLowerCase();

  var matched = lastName ? await searchMonday(lastName) : [];
  var mondayItem = null;
  for (var mi = 0; mi < matched.length; mi++) {
    var mName = matched[mi].name.toLowerCase();
    if (mName.includes(lastLower) && (!firstLower || mName.includes(firstLower))) {
      mondayItem = matched[mi];
      break;
    }
  }
  if (!mondayItem && matched.length > 0) mondayItem = matched[0];

  if (!mondayItem && firstName) {
    var byFirst = await searchMonday(firstName);
    for (var fi = 0; fi < byFirst.length; fi++) {
      if (byFirst[fi].name.toLowerCase().includes(lastLower)) {
        mondayItem = byFirst[fi];
        break;
      }
    }
  }

  if (mondayItem) {
    var lines = ['USCIS Mail Received — ' + today, ''];
    for (var ni = 0; ni < client.notices.length; ni++) {
      var notice = client.notices[ni];
      var noticeType = (notice.notice_type || 'notice').split('_').join(' ');
      var appType = notice.application_type ? ' (' + notice.application_type + ')' : '';
      lines.push(noticeType + appType);
      if (notice.summary) lines.push(notice.summary);
      lines.push('Download: ' + BASE_URL + '?id=' + notice.id + '&token=' + portalSecret);
      if (ni < client.notices.length - 1) lines.push('');
    }
    var updateText = lines.join('\n');
    try {
      await postUpdate(mondayItem.id, updateText);
      foundClients.push({ client_name: client.name, monday_name: mondayItem.name, notice_count: client.notices.length });
    } catch (e) {
      notFoundClients.push({ client_name: client.name, reason: 'Monday update error: ' + (e && e.message ? e.message.slice(0, 100) : String(e)) });
    }
  } else {
    notFoundClients.push({ client_name: client.name, reason: 'Not found in Monday' });
  }
}

var tableRows = '';
for (var fc = 0; fc < foundClients.length; fc++) {
  var f = foundClients[fc];
  tableRows += '<tr><td>' + f.client_name + '</td><td>' + f.monday_name + '</td><td style="color:green">Updated</td><td>' + f.notice_count + '</td></tr>';
}
for (var nc = 0; nc < notFoundClients.length; nc++) {
  var nf = notFoundClients[nc];
  tableRows += '<tr><td>' + nf.client_name + '</td><td colspan="2" style="color:#cc0000">' + nf.reason + '</td><td>-</td></tr>';
}

var emailHtml = '<h2>USCIS Mail Ingest — ' + today + '</h2>' +
  '<p>Processed <strong>' + items.length + '</strong> notice(s) for <strong>' + clients.length + '</strong> client(s).</p>' +
  '<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-family:sans-serif;font-size:13px">' +
  '<tr style="background:#f0f0f0"><th>Client (notice)</th><th>Monday Match</th><th>Status</th><th>Notices</th></tr>' +
  tableRows + '</table>' +
  (notFoundClients.length > 0
    ? '<p style="color:#cc0000"><strong>' + notFoundClients.length + ' client(s) not found in Monday</strong> — please add manually.</p>'
    : '<p style="color:green">All clients updated in Monday successfully.</p>');

return [{ json: { foundClients: foundClients, notFoundClients: notFoundClients, totalClients: clients.length, emailHtml: emailHtml } }];`,
    },
    position: [1344, 0],
  },
  output: [{ foundClients: [], notFoundClients: [], totalClients: 1, emailHtml: '<p>Summary</p>' }],
});

// ── Send summary email ───────────────────────────────────────────────
const sendEmail = node({
  type: 'n8n-nodes-base.emailSend',
  version: 2.1,
  config: {
    name: 'Send Summary Email',
    parameters: {
      fromEmail: 'katychavezlaw@gmail.com',
      toEmail: 'katychavezlaw@gmail.com',
      subject: expr("USCIS Mail Ingest — {{ $json.totalClients }} client(s) processed — {{ new Date().toLocaleDateString() }}"),
      emailFormat: 'html',
      html: expr('{{ $json.emailHtml }}'),
      options: { appendAttribution: false },
    },
    credentials: { smtp: newCredential('KCL Gmail') },
    position: [1568, 0],
  },
  output: [{}],
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
        "={{ JSON.stringify({ success: true, batch_id: $('Insert via mail_intake').first().json.result.batch_id, item_count: $('Insert via mail_intake').first().json.result.item_count, item_ids: $('Insert via mail_intake').first().json.result.item_ids }) }}",
    },
    position: [1792, 0],
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
  .to(getBatchItems)
  .to(mondayAndEmail)
  .to(sendEmail)
  .to(respond);
