import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createChatApp } from '../lib/app.mjs';
import { createFakeNewApi, listen, login, session } from './helpers.mjs';

const CUSTOM_MODEL_ID = 'custom/c123abc4/gemini-3-flash';

async function fixture({ fakeOptions = {} } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'chat-custom-preferences-'));
  await mkdir(join(root, 'public'), { recursive: true });
  await mkdir(join(root, '.data'), { recursive: true });
  await Promise.all([
    writeFile(join(root, 'public', 'login.html'), '<!doctype html><title>login</title>'),
    writeFile(join(root, 'public', 'app.html'), '<!doctype html><title>app</title>'),
  ]);
  const fake = await createFakeNewApi(fakeOptions);
  const app = await createChatApp({
    rootDir: root,
    apiKey: 'test-api-key',
    bootstrapUsername: 'test-admin',
    bootstrapPassword: 'temporary-test-password',
    sessionSecret: 'test-session-secret-that-is-long-enough',
    port: 0,
    newApiBaseUrl: fake.baseUrl,
    pdfTextExtractor: { extract: async () => '[Page 1]' },
  });
  const baseUrl = await listen(app.server);
  const initial = await session(baseUrl);
  const signedIn = await login(baseUrl, initial);
  assert.equal(signedIn.response.status, 200);
  return {
    baseUrl,
    fake,
    signedIn,
    async close() {
      await app.close();
      await fake.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

function mutationHeaders(context) {
  return {
    Cookie: context.signedIn.cookie,
    Origin: context.baseUrl,
    'X-CSRF-Token': context.signedIn.body.csrfToken,
    'Content-Type': 'application/json',
  };
}

test('preferences accept browser-local custom endpoint model ids and keep them intact', async () => {
  const context = await fixture();
  try {
    const saved = await fetch(`${context.baseUrl}/api/preferences`, {
      method: 'PUT',
      headers: mutationHeaders(context),
      body: JSON.stringify({
        favoriteGroups: [{
          id: 'custom-group',
          name: '自定义端点',
          items: [{ modelId: CUSTOM_MODEL_ID, model: CUSTOM_MODEL_ID, mode: 'chat', label: 'gemini-3-flash' }],
        }],
        selected: { modelId: CUSTOM_MODEL_ID, mode: 'chat' },
        modelContextLimits: { [CUSTOM_MODEL_ID]: 131072 },
        conversationTitleModel: CUSTOM_MODEL_ID,
      }),
    });
    const preferences = await saved.json();
    assert.equal(saved.status, 200, JSON.stringify(preferences));
    assert.equal(preferences.favoriteGroups[0].items[0].modelId, CUSTOM_MODEL_ID);
    assert.equal(preferences.favoriteGroups[0].items[0].label, 'gemini-3-flash');
    assert.equal(preferences.selected.modelId, CUSTOM_MODEL_ID);
    assert.equal(preferences.modelContextLimits[CUSTOM_MODEL_ID], 131072);
    assert.equal(preferences.conversationTitleModel, CUSTOM_MODEL_ID);

    const reloaded = await fetch(`${context.baseUrl}/api/preferences`, { headers: { Cookie: context.signedIn.cookie } }).then((response) => response.json());
    assert.equal(reloaded.favoriteGroups[0].items[0].modelId, CUSTOM_MODEL_ID);
    assert.equal(reloaded.selected.modelId, CUSTOM_MODEL_ID);
    assert.equal(reloaded.modelContextLimits[CUSTOM_MODEL_ID], 131072);
    assert.equal(reloaded.conversationTitleModel, CUSTOM_MODEL_ID);
  } finally {
    await context.close();
  }
});

test('unknown non-custom model ids are still rejected from preferences', async () => {
  const context = await fixture();
  try {
    const saved = await fetch(`${context.baseUrl}/api/preferences`, {
      method: 'PUT',
      headers: mutationHeaders(context),
      body: JSON.stringify({
        favoriteGroups: [{
          id: 'broken-group',
          name: '未知模型',
          items: [{ modelId: 'not-a-real-model', model: 'not-a-real-model', mode: 'chat' }],
        }],
        selected: null,
        modelContextLimits: {},
      }),
    });
    const body = await saved.json();
    assert.equal(saved.status, 400, JSON.stringify(body));
    assert.equal(body.code, 'MODEL_NOT_ALLOWED');
  } finally {
    await context.close();
  }
});

test('server-side title generation falls back to a server model when the saved title model is custom', async () => {
  const context = await fixture({ fakeOptions: { chatResponseText: '自定义端点标题' } });
  try {
    const saved = await fetch(`${context.baseUrl}/api/preferences`, {
      method: 'PUT',
      headers: mutationHeaders(context),
      body: JSON.stringify({
        favoriteGroups: [],
        selected: null,
        modelContextLimits: {},
        conversationTitleModel: CUSTOM_MODEL_ID,
      }),
    });
    assert.equal(saved.status, 200);

    const response = await fetch(`${context.baseUrl}/api/conversations/title`, {
      method: 'POST',
      headers: mutationHeaders(context),
      body: JSON.stringify({ source: '用自定义端点模型生成标题的来源文本' }),
    });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.title, '自定义端点标题');
    assert.notEqual(body.model, CUSTOM_MODEL_ID);
    assert.equal(body.model, 'gemini-3.5-flash-low-fan');
  } finally {
    await context.close();
  }
});
