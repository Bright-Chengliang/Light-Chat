import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { createChatApp } from '../lib/app.mjs';
import { createFakeNewApi, cookieFrom, listen, session } from './helpers.mjs';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'chat-guest-'));
  await mkdir(join(root, 'public'), { recursive: true });
  await mkdir(join(root, '.data'), { recursive: true });
  await Promise.all([
    writeFile(join(root, 'public', 'login.html'), '<!doctype html><title>login</title>'),
    writeFile(join(root, 'public', 'app.html'), '<!doctype html><title>app</title>'),
  ]);
  const fake = await createFakeNewApi({ chatResponseText: '游客回复' });
  const app = await createChatApp({
    rootDir: root,
    apiKey: 'test-api-key',
    bootstrapUsername: 'test-admin',
    bootstrapPassword: 'temporary-test-password',
    sessionSecret: 'test-session-secret-that-is-long-enough',
    port: 0,
    newApiBaseUrl: fake.baseUrl,
    guestAllowPrivateEndpoints: true,
    pdfTextExtractor: { extract: async () => '[Page 1]' },
  });
  const baseUrl = await listen(app.server);
  return {
    root,
    fake,
    app,
    baseUrl,
    async close() {
      await app.close();
      await fake.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function guestLogin(baseUrl) {
  const initial = await session(baseUrl);
  const response = await fetch(`${baseUrl}/api/auth/guest`, {
    method: 'POST',
    headers: {
      Cookie: initial.cookie,
      Origin: baseUrl,
      'X-CSRF-Token': initial.body.csrfToken,
      'Content-Type': 'application/json',
    },
    body: '{}',
  });
  const body = await response.json();
  return { response, body, cookie: response.ok ? cookieFrom(response) : initial.cookie };
}

async function guestJson(baseUrl, cookie, pathname, { method = 'GET', body } = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(method !== 'GET' ? { Origin: baseUrl, 'X-CSRF-Token': (await session(baseUrl, cookie)).body.csrfToken } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { response, body: await response.json() };
}

test('guest can enter without a password but starts with zero credits and no model access', async () => {
  const context = await fixture();
  try {
    const signedIn = await guestLogin(context.baseUrl);
    assert.equal(signedIn.response.status, 200);
    assert.equal(signedIn.body.role, 'guest');
    assert.equal(signedIn.body.credits, 0);

    const current = await session(context.baseUrl, signedIn.cookie);
    assert.equal(current.body.authenticated, true);
    assert.equal(current.body.role, 'guest');
    assert.equal(current.body.username, '游客');
    assert.equal(current.body.credits, 0);

    const quota = await guestJson(context.baseUrl, signedIn.cookie, '/api/quota');
    assert.equal(quota.response.status, 200);
    assert.equal(quota.body.role, 'guest');
    assert.equal(quota.body.credits, 0);
    assert.equal(quota.body.usagePoints, 0);

    const models = await guestJson(context.baseUrl, signedIn.cookie, '/api/models');
    assert.equal(models.response.status, 200);
    assert.deepEqual(models.body.models, []);

    const adminDenied = await guestJson(context.baseUrl, signedIn.cookie, '/api/admin/users');
    assert.equal(adminDenied.response.status, 403);
    assert.equal(context.fake.requests.length, 1);
  } finally {
    await context.close();
  }
});

test('guest can configure a private upstream and only use models it allows', async () => {
  const context = await fixture();
  try {
    const signedIn = await guestLogin(context.baseUrl);
    const saved = await guestJson(context.baseUrl, signedIn.cookie, '/api/guest/settings', {
      method: 'PUT',
      body: {
        endpoint: `${context.fake.baseUrl}/`,
        allowedModels: ['chat-test', 'gpt-image-2'],
        apiKey: 'test-api-key',
      },
    });
    assert.equal(saved.response.status, 200);
    assert.equal(saved.body.endpoint, context.fake.baseUrl);
    assert.equal(saved.body.hasApiKey, true);
    assert.deepEqual(saved.body.allowedModels, ['chat-test', 'gpt-image-2']);

    const redacted = await guestJson(context.baseUrl, signedIn.cookie, '/api/guest/settings');
    assert.equal(redacted.body.hasApiKey, true);
    assert.equal(Object.hasOwn(redacted.body, 'apiKey'), false);
    assert.doesNotMatch(JSON.stringify(redacted.body), /test-api-key/);

    const models = await guestJson(context.baseUrl, signedIn.cookie, '/api/models?refresh=1');
    assert.deepEqual(models.body.models.map((model) => model.id).sort(), ['chat-test', 'gpt-image-2']);

    const chat = await guestJson(context.baseUrl, signedIn.cookie, '/api/chat', {
      method: 'POST',
      body: { model: 'chat-test', messages: [{ role: 'user', content: '你好' }], stream: false },
    });
    assert.equal(chat.response.status, 200);
    assert.equal(chat.body.text, '游客回复');
    const upstreamRequest = context.fake.requests.find((request) => request.url === '/v1/chat/completions');
    assert.equal(upstreamRequest.authorization, 'Bearer test-api-key');

    const denied = await guestJson(context.baseUrl, signedIn.cookie, '/api/chat', {
      method: 'POST',
      body: { model: 'claude-sonnet-4-5', messages: [{ role: 'user', content: '你好' }], stream: false },
    });
    assert.equal(denied.response.status, 403);
    assert.equal(denied.body.code, 'MODEL_ACCESS_DENIED');

    const quota = await guestJson(context.baseUrl, signedIn.cookie, '/api/quota');
    assert.equal(quota.body.credits, 0);
    assert.equal(quota.body.usagePoints, 0);
    assert.equal(quota.body.chatCalls, 0);
  } finally {
    await context.close();
  }
});

test('guest can preview models from a typed endpoint without saving settings', async () => {
  const context = await fixture();
  try {
    const signedIn = await guestLogin(context.baseUrl);
    const preview = await guestJson(context.baseUrl, signedIn.cookie, '/api/guest/models/preview', {
      method: 'POST',
      body: { endpoint: context.fake.baseUrl, apiKey: 'test-api-key' },
    });
    assert.equal(preview.response.status, 200);
    const ids = preview.body.models.map((model) => model.id);
    assert.equal(ids.includes('chat-test'), true);
    assert.equal(ids.includes('gpt-image-2'), true);

    const invalid = await guestJson(context.baseUrl, signedIn.cookie, '/api/guest/models/preview', {
      method: 'POST',
      body: { endpoint: 'ftp://api.example.com/v1', apiKey: '' },
    });
    assert.equal(invalid.response.status, 400);

    const untouched = await guestJson(context.baseUrl, signedIn.cookie, '/api/guest/settings');
    assert.equal(untouched.body.endpoint, '');
    assert.deepEqual(untouched.body.allowedModels, []);
  } finally {
    await context.close();
  }
});

test('guest cannot reach administrator-only surfaces', async () => {
  const context = await fixture();
  try {
    const signedIn = await guestLogin(context.baseUrl);
    const opcDenied = await fetch(`${context.baseUrl}/opc/`, { headers: { Cookie: signedIn.cookie }, redirect: 'manual' });
    assert.equal(opcDenied.status, 403);
    const workflowsDenied = await guestJson(context.baseUrl, signedIn.cookie, '/api/workflows');
    assert.equal(workflowsDenied.response.status, 403);
  } finally {
    await context.close();
  }
});
