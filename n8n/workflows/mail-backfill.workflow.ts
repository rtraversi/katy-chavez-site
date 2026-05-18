// mail-backfill workflow — one-shot manual run
//
// Opens in n8n UI → click Execute to post Monday.com updates
// for all existing mail_items that predate Phase B, then emails
// a summary table to katychavezlaw@gmail.com.
//
// For each client, searches the Katy Chavez Main Board by last name
// (beneficiary = client), posts one update with all notices + download
// links, then emails a per-client table showing matched/not-found/errors.
//
// Safe to re-run — each run adds a new Monday update, no deduplication.
//
// Deploy:
//   - Workflow ID: nuQGpYMyr4JY4Anx (n8n.katychavez.com)
//   - Manual trigger only — no webhook

import { workflow, trigger, node, newCredential, expr } from '@n8n/workflow-sdk';

const manualTrigger = trigger({
  type: 'n8n-nodes-base.manualTrigger',
  version: 1,
  config: {
    name: 'Run Backfill',
    parameters: {},
    position: [160, 300],
  },
  output: [{}],
});

const queryAllItems = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Query All Mail Items',
    parameters: {
      operation: 'executeQuery',
      query: 'SELECT id, client_name, client_first_name, client_last_name, notice_type, application_type, summary, notice_date FROM mail_items ORDER BY client_last_name NULLS LAST, client_first_name NULLS LAST, created_at',
    },
    credentials: { postgres: newCredential('Portal Postgres') },
    position: [380, 300],
  },
  output: [{ id: 'uuid', client_name: 'Garcia, Maria', notice_type: 'receipt_notice' }],
});

const postMondayUpdates = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Post Monday Updates',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `var self = this;
var items = $input.all().map(function(i) { return i.json; });

if (items.length === 0) {
  var emptyHtml = '<p>No mail items found in the database.</p>';
  return [{ json: { posted: 0, not_found: 0, total_clients: 0, errors: [], emailHtml: emptyHtml } }];
}

var portalSecret = $env.PORTAL_SECRET;
var mondayApiKey = $env.MONDAY_API_KEY || '';
var BOARD_ID = '2468110147';
var BASE_URL = 'https://n8n.katychavez.com/webhook/mail-file';

var noticeLabels = {
  biometrics_notice: 'Biometrics Notice',
  approval_notice: 'Approval Notice',
  receipt_notice: 'Receipt Notice',
  rfe: 'RFE',
  transfer_notice: 'Transfer Notice',
  rejection: 'Rejection',
  card_production_ordered: 'Card Production Ordered',
  other: 'Other',
};

var byClient = {};
for (var i = 0; i < items.length; i++) {
  var item = items[i];
  var key = item.client_name || ('unknown_' + i);
  if (!byClient[key]) byClient[key] = { info: item, notices: [] };
  byClient[key].notices.push(item);
}

async function searchMonday(term) {
  var gql = 'query ($boardId: ID!, $term: String!) { boards(ids: [$boardId]) { items_page(limit: 5, query_params: {term: $term}) { items { id name } } } }';
  var result = await self.helpers.httpRequest({
    method: 'POST',
    url: 'https://api.monday.com/v2',
    headers: { 'Authorization': mondayApiKey, 'Content-Type': 'application/json', 'API-Version': '2024-10' },
    body: JSON.stringify({ query: gql, variables: { boardId: BOARD_ID, term: term } }),
  });
  var parsed = typeof result === 'string' ? JSON.parse(result) : result;
  var boards = parsed.data && parsed.data.boards;
  if (!boards || boards.length === 0) return [];
  var page = boards[0].items_page;
  return page ? (page.items || []) : [];
}

async function postUpdate(mondayItemId, body) {
  var mutation = 'mutation ($itemId: ID!, $body: String!) { create_update(item_id: $itemId, body: $body) { id } }';
  await self.helpers.httpRequest({
    method: 'POST',
    url: 'https://api.monday.com/v2',
    headers: { 'Authorization': mondayApiKey, 'Content-Type': 'application/json', 'API-Version': '2024-01' },
    body: JSON.stringify({ query: mutation, variables: { itemId: mondayItemId, body: body } }),
  });
}

var posted = 0;
var notFound = [];
var errors = [];
var clientNames = Object.keys(byClient);
var postedClients = [];

for (var c = 0; c < clientNames.length; c++) {
  var clientName = clientNames[c];
  try {
    var clientData = byClient[clientName];
    var info = clientData.info;
    var notices = clientData.notices;

    var mondayItems = [];
    if (info.client_last_name) mondayItems = await searchMonday(info.client_last_name);
    if (mondayItems.length === 0 && info.client_first_name) mondayItems = await searchMonday(info.client_first_name);
    if (mondayItems.length === 0 && clientName && !clientName.startsWith('unknown_')) mondayItems = await searchMonday(clientName);

    if (mondayItems.length === 0) {
      notFound.push(clientName);
      continue;
    }

    var mondayId = mondayItems[0].id;
    var mondayName = mondayItems[0].name;
    var lines = [];
    lines.push('<strong>USCIS Mail Backfill — ' + notices.length + ' notice' + (notices.length === 1 ? '' : 's') + ' on file</strong>');
    lines.push('');

    for (var n = 0; n < notices.length; n++) {
      var notice = notices[n];
      var label = noticeLabels[notice.notice_type] || notice.notice_type || 'Notice';
      var appType = notice.application_type ? ' (' + notice.application_type + ')' : '';
      var dateStr = notice.notice_date ? String(notice.notice_date).slice(0, 10) : '';
      var dlUrl = BASE_URL + '?id=' + notice.id + '&token=' + portalSecret;
      lines.push('• ' + label + appType + (dateStr ? ' — ' + dateStr : '') + ' — <a href="' + dlUrl + '">Download PDF</a>');
    }

    if (info.summary) {
      lines.push('');
      lines.push(info.summary);
    }

    await postUpdate(mondayId, lines.join('<br>'));
    posted++;
    postedClients.push({ clientName: clientName, mondayName: mondayName, count: notices.length });
  } catch (err) {
    errors.push({ client: clientName, error: err.message });
  }
}

var dateLabel = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

var rows = postedClients.map(function(pc) {
  return '<tr><td style="padding:6px 12px;border-bottom:1px solid #e8e0d4;">' + pc.clientName + '</td>'
    + '<td style="padding:6px 12px;border-bottom:1px solid #e8e0d4;">' + pc.mondayName + '</td>'
    + '<td style="padding:6px 12px;border-bottom:1px solid #e8e0d4;text-align:center;">' + pc.count + '</td></tr>';
}).join('');

var notFoundRows = notFound.map(function(n) {
  return '<tr><td style="padding:6px 12px;border-bottom:1px solid #e8e0d4;color:#b3392e;">' + n + '</td></tr>';
}).join('');

var errorRows = errors.map(function(e) {
  return '<tr><td style="padding:6px 12px;border-bottom:1px solid #e8e0d4;">' + e.client + '</td>'
    + '<td style="padding:6px 12px;border-bottom:1px solid #e8e0d4;color:#b3392e;">' + e.error + '</td></tr>';
}).join('');

var emailHtml = '<div style="font-family:sans-serif;max-width:680px;">'
  + '<h2 style="color:#2B3A52;">USCIS Mail Backfill — ' + dateLabel + '</h2>'
  + '<p style="color:#555;">Backfill run complete. ' + posted + ' of ' + clientNames.length + ' client(s) updated in Monday.com.</p>'
  + '<table style="width:100%;border-collapse:collapse;margin-top:16px;background:#fff;border:1px solid #e8e0d4;">'
  + '<thead><tr style="background:#2B3A52;color:#fff;">'
  + '<th style="padding:8px 12px;text-align:left;">Client (DB)</th>'
  + '<th style="padding:8px 12px;text-align:left;">Monday Match</th>'
  + '<th style="padding:8px 12px;text-align:center;">Notices</th>'
  + '</tr></thead><tbody>' + (rows || '<tr><td colspan="3" style="padding:12px;color:#888;">None posted</td></tr>') + '</tbody></table>';

if (notFound.length > 0) {
  emailHtml += '<h3 style="color:#b3392e;margin-top:24px;">Not Found in Monday (' + notFound.length + ')</h3>'
    + '<table style="width:100%;border-collapse:collapse;background:#fff;border:1px solid #e8e0d4;">'
    + '<tbody>' + notFoundRows + '</tbody></table>';
}

if (errors.length > 0) {
  emailHtml += '<h3 style="color:#b3392e;margin-top:24px;">Errors (' + errors.length + ')</h3>'
    + '<table style="width:100%;border-collapse:collapse;background:#fff;border:1px solid #e8e0d4;">'
    + '<thead><tr><th style="padding:8px 12px;text-align:left;">Client</th><th style="padding:8px 12px;text-align:left;">Error</th></tr></thead>'
    + '<tbody>' + errorRows + '</tbody></table>';
}

emailHtml += '</div>';

return [{ json: { total_clients: clientNames.length, posted: posted, not_found: notFound.length, errors: errors, emailHtml: emailHtml } }];`,
    },
    position: [600, 300],
  },
  output: [{ total_clients: 5, posted: 4, not_found: 1, errors: [], emailHtml: '<div>...</div>' }],
});

const sendEmail = node({
  type: 'n8n-nodes-base.emailSend',
  version: 2.1,
  config: {
    name: 'Send Summary Email',
    parameters: {
      fromEmail: 'katychavezlaw@gmail.com',
      toEmail: 'katychavezlaw@gmail.com',
      subject: expr("USCIS Mail Backfill — {{ $json.posted }} of {{ $json.total_clients }} client(s) updated — {{ new Date().toLocaleDateString() }}"),
      emailFormat: 'html',
      html: expr('{{ $json.emailHtml }}'),
      options: { appendAttribution: false },
    },
    credentials: { smtp: newCredential('KCL Gmail') },
    position: [820, 300],
  },
  output: [{}],
});

export default workflow('nuQGpYMyr4JY4Anx', 'mail-backfill')
  .add(manualTrigger)
  .to(queryAllItems)
  .to(postMondayUpdates)
  .to(sendEmail);
