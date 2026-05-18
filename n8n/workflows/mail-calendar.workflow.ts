// mail-calendar workflow — source of truth for n8n
//
// POST /webhook/mail-calendar
// Body: { year: number, month: number }
// Header: X-Portal-Secret: <secret>
//
// Returns batches grouped by scan date for the requested month,
// so the portal can render a monthly calendar view.
//
// Prerequisites:
//   - mail-ingest workflow deployed (writes mail_batches + mail_items)
//   - Migration 004_mail_tables.sql applied
//   - Portal Postgres credential configured in n8n
//
// Deploy:
//   - Workflow ID: mGHU4fpIvFxBmuQo (n8n.katychavez.com)
//   - Production URL: https://n8n.katychavez.com/webhook/mail-calendar

import { workflow, trigger, node, newCredential, expr } from '@n8n/workflow-sdk';

const mailCalendarWebhook = trigger({
  type: 'n8n-nodes-base.webhook',
  version: 2.1,
  config: {
    name: 'Mail Calendar Webhook',
    parameters: {
      httpMethod: 'POST',
      path: 'mail-calendar',
      responseMode: 'responseNode',
      options: {},
    },
    position: [160, 300],
  },
  output: [{ body: { year: 2026, month: 5 } }],
});

const validateAuth = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Validate Auth',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `const headers = $input.first().json.headers || {};
const token = headers['x-portal-secret'] || '';
if (!token || token !== $env.PORTAL_SECRET) throw new Error('Unauthorized');
const body = $input.first().json.body || {};
const year = parseInt(body.year, 10);
const month = parseInt(body.month, 10);
if (!year || !month || month < 1 || month > 12) throw new Error('Invalid year/month');
return [{ json: { year: year, month: month } }];`,
    },
    position: [380, 300],
  },
  output: [{ year: 2026, month: 5 }],
});

const queryBatches = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Query Batches',
    parameters: {
      operation: 'executeQuery',
      query: "=SELECT mb.id as batch_id, mb.created_at::date as scan_date, mb.original_filename, COALESCE(json_agg(json_build_object('id', mi.id, 'client_name', mi.client_name, 'notice_type', mi.notice_type, 'application_type', mi.application_type) ORDER BY mi.client_last_name NULLS LAST, mi.client_first_name NULLS LAST) FILTER (WHERE mi.id IS NOT NULL), '[]'::json) as items FROM mail_batches mb LEFT JOIN mail_items mi ON mi.batch_id = mb.id WHERE EXTRACT(YEAR FROM mb.created_at) = {{ $json.year }} AND EXTRACT(MONTH FROM mb.created_at) = {{ $json.month }} GROUP BY mb.id, mb.created_at ORDER BY mb.created_at::date, mb.created_at",
    },
    credentials: { postgres: newCredential('Portal Postgres') },
    position: [600, 300],
  },
  output: [{ batch_id: 'uuid', scan_date: '2026-05-01', original_filename: 'scan.pdf', items: [] }],
});

const groupByDate = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Group by Date',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `var rows = $input.all().map(function(i) { return i.json; });
var ref = $('Validate Auth').first().json;
var year = ref.year;
var month = ref.month;
var byDate = {};
for (var i = 0; i < rows.length; i++) {
  var row = rows[i];
  var dateStr = row.scan_date ? String(row.scan_date).slice(0, 10) : null;
  if (!dateStr) continue;
  if (!byDate[dateStr]) byDate[dateStr] = [];
  var items = Array.isArray(row.items) ? row.items : JSON.parse(row.items || '[]');
  byDate[dateStr].push({
    batch_id: row.batch_id,
    original_filename: row.original_filename,
    item_count: items.length,
    items: items
  });
}
return [{ json: { year: year, month: month, batches_by_date: byDate } }];`,
    },
    position: [820, 300],
  },
  output: [{ year: 2026, month: 5, batches_by_date: {} }],
});

const respond = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.5,
  config: {
    name: 'Respond',
    parameters: {
      respondWith: 'json',
      responseBody: expr('={{ JSON.stringify($json) }}'),
      options: {},
    },
    position: [1040, 300],
  },
  output: [{}],
});

export default workflow('mGHU4fpIvFxBmuQo', 'mail-calendar')
  .add(mailCalendarWebhook)
  .to(validateAuth)
  .to(queryBatches)
  .to(groupByDate)
  .to(respond);
