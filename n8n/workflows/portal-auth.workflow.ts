// portal-auth workflow — source of truth for n8n
//
// Validates staff username/password against env vars and returns the portal
// API secret token if credentials are correct. Called by portal/index.html
// login form. No header auth required (this IS the auth endpoint).
//
// Body: { username: string, password: string }
// Response: { valid: true, token: "..." } | { valid: false, token: null }
//
// Deploy: create in n8n at https://n8n.katychavez.com, then update the
// workflow() ID below with the real ID and update CLAUDE.md.

import { workflow, trigger, node } from '@n8n/workflow-sdk';

// ── Webhook trigger (public — no auth) ──────────────────────────────
const webhookTrigger = trigger({
  type: 'n8n-nodes-base.webhook',
  version: 2.1,
  config: {
    name: 'Webhook',
    parameters: {
      httpMethod: 'POST',
      path: 'portal-auth',
      responseMode: 'responseNode',
      options: {},
    },
    position: [160, 300],
  },
  output: [{ body: { username: 'staff', password: 'secret' } }],
});

// ── Validate credentials against env vars ────────────────────────────
const validateCredentials = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Validate Credentials',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `const body = $input.first().json.body || {};
const username = (body.username || '').trim();
const password = (body.password || '').trim();

const validUser = ($env.PORTAL_USER || '').trim();
const validPass = ($env.PORTAL_PASS || '').trim();
const secret    = ($env.PORTAL_SECRET || '').trim();

if (!validUser || !validPass || !secret) {
  throw new Error('Server config incomplete: PORTAL_USER, PORTAL_PASS, PORTAL_SECRET must all be set in .env');
}

const valid = username === validUser && password === validPass;
return [{ json: { valid, token: valid ? secret : null } }];`,
    },
    position: [380, 300],
  },
  output: [{ valid: true, token: 'the-portal-secret' }],
});

// ── Respond to webhook ───────────────────────────────────────────────
const respond = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.5,
  config: {
    name: 'Respond to Webhook',
    parameters: {
      respondWith: 'json',
      responseBody: '={{ JSON.stringify($json) }}',
    },
    position: [600, 300],
    executeOnce: true,
  },
  output: [{}],
});

export default workflow('y55JVRRE7dRFahvK', 'portal-auth')
  .add(webhookTrigger)
  .to(validateCredentials)
  .to(respond);
