// portal-submit workflow — source of truth for n8n
// Pushed to n8n via the MCP `update_workflow` tool; this file is the
// version-controlled copy. To edit:
//   1. Modify here.
//   2. Validate via mcp__claude_ai_n8n__validate_workflow.
//   3. Update via mcp__claude_ai_n8n__update_workflow (workflowId: FY4kdty7lVnJkzC8).
//   4. Publish via mcp__claude_ai_n8n__publish_workflow.

import { workflow, trigger, node, newCredential } from '@n8n/workflow-sdk';

// ── Webhook trigger ──────────────────────────────────────────────────
const webhookTrigger = trigger({
  type: 'n8n-nodes-base.webhook',
  version: 2.1,
  config: {
    name: 'Webhook',
    parameters: {
      httpMethod: 'POST',
      path: 'portal-submit',
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
  output: [{ body: { clientName: 'Test Client' } }],
});

// ── Persist Job: write uploaded files to disk + meta.json ───────────
const persistJob = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Persist Job',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `const fs = require('fs');

const item = $input.first();
const body = (item.json && item.json.body) || {};
const binary = item.binary || {};
const jobId = String($execution.id);
const baseDir = '/data/jobs/' + jobId;
const inputsDir = baseDir + '/inputs';

fs.mkdirSync(inputsDir, { recursive: true });

const files = [];
let idx = 0;
for (const key of Object.keys(binary)) {
  const file = binary[key];
  const raw = file.fileName || key;
  const safe = raw.replace(/[^a-zA-Z0-9._-]/g, '_');
  const prefixed = String(idx).padStart(2, '0') + '-' + safe;
  const buf = await this.helpers.getBinaryDataBuffer(0, key);
  const fullpath = inputsDir + '/' + prefixed;
  fs.writeFileSync(fullpath, buf);
  files.push({
    filename: prefixed,
    original_filename: file.fileName || raw,
    mime_type: file.mimeType || 'application/octet-stream',
    size_bytes: buf.length,
    storage_path: fullpath,
  });
  idx++;
}

const meta = {
  jobId,
  body,
  receivedAt: new Date().toISOString(),
  fileCount: files.length,
  files,
};
fs.writeFileSync(baseDir + '/meta.json', JSON.stringify(meta, null, 2), 'utf-8');

return [{ json: { jobId, fileCount: files.length, files, body } }];`,
    },
    position: [380, 300],
  },
  output: [{ jobId: '9', fileCount: 2, files: [], body: {} }],
});

// ── Classify + Extract: Claude pass per file ─────────────────────────
const classifyExtract = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Classify + Extract',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `const fs = require('fs');

const jobInfo = $input.first().json;
const jobId = jobInfo.jobId;
const files = jobInfo.files || [];
const apiKey = $env.ANTHROPIC_API_KEY;

if (!apiKey) {
  throw new Error('ANTHROPIC_API_KEY not set in container env');
}

const MODEL = 'claude-sonnet-4-6';
const API_URL = 'https://api.anthropic.com/v1/messages';
const ANALYZABLE = ['passport', 'birth_cert', 'marriage_cert', 'green_card', 'ead'];
const VALID_TYPES = ['passport','birth_cert','marriage_cert','green_card','ead','w2','paystub','tax_return','intake','unknown','other'];

const CLASSIFY_PROMPT = 'Classify this document into one of these categories: passport, birth_cert, marriage_cert, green_card, ead, w2, paystub, tax_return, intake, unknown.\\n\\nReturn JSON only (no markdown fences):\\n{"doc_type": "...", "confidence": 0.0}';

const EXTRACT_PROMPT = 'Extract the following fields from this document. Return JSON only (no markdown fences). Use null for any field not present. Dates as YYYY-MM-DD. Names exactly as written on the document.\\n\\n{\\n  "name_full": null,\\n  "name_given": null,\\n  "name_family": null,\\n  "dob": null,\\n  "place_of_birth": null,\\n  "country_of_birth": null,\\n  "country_of_citizenship": null,\\n  "sex": null,\\n  "a_number": null,\\n  "passport_number": null,\\n  "marriage_date": null,\\n  "marriage_location": null,\\n  "spouse_name": null,\\n  "ead_category": null,\\n  "ead_expiry": null,\\n  "gc_category": null,\\n  "gc_expiry": null\\n}';

const helpers = this.helpers;
async function callClaude(messages, maxTokens) {
  let data;
  try {
    data = await helpers.httpRequest({
      method: 'POST',
      url: API_URL,
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: { model: MODEL, max_tokens: maxTokens || 1500, messages },
      json: true,
    });
  } catch (e) {
    const status = e && e.httpCode ? e.httpCode : '?';
    const detail = e && e.message ? e.message : String(e);
    throw new Error('Claude API ' + status + ': ' + detail.slice(0, 500));
  }
  if (!data || !data.content || !data.content[0]) {
    throw new Error('Claude API empty/malformed response: ' + JSON.stringify(data).slice(0, 200));
  }
  return data.content[0].text;
}

function parseJson(text) {
  let s = String(text).trim();
  if (s.startsWith('\`\`\`')) {
    s = s.replace(/^\`\`\`(?:json)?\\s*\\n?/, '').replace(/\\n?\`\`\`\\s*$/, '');
  }
  return JSON.parse(s);
}

function buildMediaBlock(buf, mimeType) {
  const base64 = buf.toString('base64');
  if (mimeType === 'application/pdf') {
    return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } };
  }
  if (mimeType && mimeType.indexOf('image/') === 0) {
    return { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } };
  }
  return null;
}

const fileResults = [];
for (let i = 0; i < files.length; i++) {
  const f = files[i];
  const errors = [];
  let media = null;
  let buf = null;
  try {
    buf = fs.readFileSync(f.storage_path);
    media = buildMediaBlock(buf, f.mime_type);
    if (!media) errors.push('buildMediaBlock returned null for mime ' + f.mime_type);
  } catch (e) {
    errors.push('readFile: ' + (e && e.message ? e.message : String(e)));
  }

  if (!media) {
    fileResults.push({ ...f, doc_type: 'unknown', classification_confidence: 0, extracted: null, _errors: errors });
    continue;
  }

  let classification = { doc_type: 'unknown', confidence: 0 };
  let classifyRaw = null;
  try {
    classifyRaw = await callClaude([{ role: 'user', content: [media, { type: 'text', text: CLASSIFY_PROMPT }] }], 150);
    const parsed = parseJson(classifyRaw);
    if (VALID_TYPES.indexOf(parsed.doc_type) >= 0) classification = parsed;
    else errors.push('classify returned invalid doc_type: ' + JSON.stringify(parsed));
  } catch (e) {
    errors.push('classify: ' + (e && e.message ? e.message : String(e)));
  }

  let extracted = null;
  if (ANALYZABLE.indexOf(classification.doc_type) >= 0) {
    try {
      const txt = await callClaude([{ role: 'user', content: [media, { type: 'text', text: EXTRACT_PROMPT }] }], 1500);
      extracted = parseJson(txt);
    } catch (e) {
      errors.push('extract: ' + (e && e.message ? e.message : String(e)));
    }
  }

  fileResults.push({
    ...f,
    doc_type: classification.doc_type,
    classification_confidence: classification.confidence,
    extracted,
    _errors: errors,
    _classifyRaw: classifyRaw,
  });
}

function normalize(s) {
  if (!s) return '';
  return String(s).toLowerCase().replace(/[^a-z]+/g, ' ').trim();
}

function fullName(p) {
  if (!p) return '';
  return normalize(p.name_passport || p.name_full || ((p.name_given || '') + ' ' + (p.name_family || '')));
}

function matchPerson(persons, ex) {
  if (!ex) return -1;
  const eFull = normalize(ex.name_full || ((ex.name_given || '') + ' ' + (ex.name_family || '')));
  for (let i = 0; i < persons.length; i++) {
    const p = persons[i];
    const pFull = fullName(p);
    if (eFull && pFull && eFull === pFull) return i;
    if (ex.dob && p.dob && ex.dob === p.dob) {
      const eFam = normalize(ex.name_family);
      const pFam = normalize(p.name_family);
      if (eFam && pFam && eFam === pFam) return i;
    }
  }
  return -1;
}

const persons = [];

// Pass 1: passports define canonical persons
for (const f of fileResults) {
  if (f.doc_type === 'passport' && f.extracted) {
    persons.push({
      role: 'unspecified',
      name_passport: f.extracted.name_full,
      name_given: f.extracted.name_given,
      name_family: f.extracted.name_family,
      dob: f.extracted.dob,
      place_of_birth: f.extracted.place_of_birth,
      country_of_birth: f.extracted.country_of_birth,
      country_of_citizenship: f.extracted.country_of_citizenship,
      sex: f.extracted.sex,
    });
  }
}

// Pass 2: other analyzed docs match existing or create new
for (const f of fileResults) {
  if (f.doc_type === 'passport') continue;
  if (!f.extracted) continue;
  const idx = matchPerson(persons, f.extracted);
  if (idx === -1) {
    persons.push({
      role: 'unspecified',
      name_passport: null,
      name_given: f.extracted.name_given,
      name_family: f.extracted.name_family,
      name_alternate: f.extracted.name_full,
      dob: f.extracted.dob,
      place_of_birth: f.extracted.place_of_birth,
      country_of_birth: f.extracted.country_of_birth,
      country_of_citizenship: f.extracted.country_of_citizenship,
      sex: f.extracted.sex,
      a_number: f.extracted.a_number,
      ead_category: f.extracted.ead_category,
      ead_expiry: f.extracted.ead_expiry,
      gc_category: f.extracted.gc_category,
      gc_expiry: f.extracted.gc_expiry,
    });
  } else {
    const p = persons[idx];
    if (!p.a_number && f.extracted.a_number) p.a_number = f.extracted.a_number;
    if (!p.ead_category && f.extracted.ead_category) p.ead_category = f.extracted.ead_category;
    if (!p.ead_expiry && f.extracted.ead_expiry) p.ead_expiry = f.extracted.ead_expiry;
    if (!p.gc_category && f.extracted.gc_category) p.gc_category = f.extracted.gc_category;
    if (!p.gc_expiry && f.extracted.gc_expiry) p.gc_expiry = f.extracted.gc_expiry;
  }
}

// Documents
const documents = [];
for (let i = 0; i < fileResults.length; i++) {
  const f = fileResults[i];
  let personIndex = null;
  if (f.extracted) {
    const idx = matchPerson(persons, f.extracted);
    if (idx >= 0) personIndex = idx;
  }
  documents.push({
    filename: f.filename,
    original_filename: f.original_filename,
    storage_path: f.storage_path,
    mime_type: f.mime_type,
    size_bytes: f.size_bytes,
    doc_type: f.doc_type,
    was_analyzed: f.extracted ? true : false,
    classification_confidence: f.classification_confidence,
    person_index: personIndex,
  });
}

// Extracted fields
const extractedFields = [];
for (let docIdx = 0; docIdx < fileResults.length; docIdx++) {
  const f = fileResults[docIdx];
  if (!f.extracted) continue;
  const personIdx = matchPerson(persons, f.extracted);
  for (const key of Object.keys(f.extracted)) {
    const value = f.extracted[key];
    if (value === null || value === undefined || value === '') continue;
    extractedFields.push({
      document_index: docIdx,
      person_index: personIdx >= 0 ? personIdx : null,
      field_name: key,
      field_value: String(value),
      confidence: f.classification_confidence,
    });
  }
}

const primary = persons[0];
const caseLabel = primary
  ? ((primary.name_family || primary.name_passport || 'Unknown') + ' (Job ' + jobId + ')')
  : ('Job ' + jobId);

return [{
  json: {
    job_id: jobId,
    case_label: caseLabel,
    persons,
    documents,
    extracted_fields: extractedFields,
    summary: {
      files: fileResults.length,
      analyzed: fileResults.filter(function(f) { return f.extracted ? true : false; }).length,
      persons: persons.length,
      errors: [].concat.apply([], fileResults.map(function(f) {
        return (f._errors || []).map(function(e) { return f.filename + ': ' + e; });
      })),
      classify_samples: fileResults.map(function(f) {
        return { filename: f.filename, doc_type: f.doc_type, raw: f._classifyRaw };
      }),
    },
  },
}];`,
    },
    position: [600, 300],
  },
  output: [{
    job_id: '9',
    case_label: 'Garcia (Job 9)',
    persons: [],
    documents: [],
    extracted_fields: [],
    summary: { files: 2, analyzed: 1, persons: 1 },
  }],
});

// ── Insert via portal_intake stored function ─────────────────────────
const intakeInsert = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Insert via portal_intake',
    parameters: {
      operation: 'executeQuery',
      query:
        "=SELECT portal_intake(" +
        "'{{ $json.job_id }}'," +
        "'{{ ($json.case_label || '').replaceAll(\"'\", \"''\") }}'," +
        "'{{ JSON.stringify($json.persons).replaceAll(\"'\", \"''\") }}'::jsonb," +
        "'{{ JSON.stringify($json.documents).replaceAll(\"'\", \"''\") }}'::jsonb," +
        "'{{ JSON.stringify($json.extracted_fields).replaceAll(\"'\", \"''\") }}'::jsonb" +
        ") AS result;",
    },
    credentials: { postgres: newCredential('Portal Postgres') },
    position: [820, 300],
  },
  output: [{ result: { case_id: '...', person_ids: [], document_ids: [] } }],
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
        "={{ JSON.stringify({ success: true, jobId: $('Persist Job').item.json.jobId, case: $json.result, summary: $('Classify + Extract').item.json.summary }) }}",
    },
    position: [1040, 300],
    executeOnce: true,
  },
  output: [{}],
});

export default workflow('FY4kdty7lVnJkzC8', 'portal-submit')
  .add(webhookTrigger)
  .to(persistJob)
  .to(classifyExtract)
  .to(intakeInsert)
  .to(respond);
