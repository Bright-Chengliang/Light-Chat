import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import {
  GuestStore,
  GUEST_UID,
  GUEST_USERNAME,
  guestPublicUser,
  normalizeGuestEndpoint,
  validateGuestModelIds,
} from '../lib/guest-store.mjs';

test('guest identity is a zero-credit role without administrator access', () => {
  const user = guestPublicUser();
  assert.equal(user.uid, GUEST_UID);
  assert.equal(user.username, GUEST_USERNAME);
  assert.equal(user.role, 'guest');
  assert.equal(user.credits, 0);
  assert.equal(user.disabled, false);
});

test('guest endpoints must be plain public http(s) URLs by default', async () => {
  await assert.rejects(normalizeGuestEndpoint('http://localhost:3002/v1', { resolveDns: false }), /本机或内网/);
  await assert.rejects(normalizeGuestEndpoint('http://127.0.0.1:3002/v1', { resolveDns: false }), /本机或内网/);
  await assert.rejects(normalizeGuestEndpoint('http://10.0.0.5/v1', { resolveDns: false }), /本机或内网/);
  await assert.rejects(normalizeGuestEndpoint('http://192.168.1.1/v1', { resolveDns: false }), /本机或内网/);
  await assert.rejects(normalizeGuestEndpoint('ftp://api.example.com/v1', { resolveDns: false }), /http\/https/);
  await assert.rejects(normalizeGuestEndpoint('https://user:pass@api.example.com/v1', { resolveDns: false }), /内嵌凭据/);
  assert.equal(await normalizeGuestEndpoint('', { resolveDns: false }), '');
  assert.equal(await normalizeGuestEndpoint('https://api.example.com/v1/', { resolveDns: false }), 'https://api.example.com/v1');
  assert.equal(await normalizeGuestEndpoint('http://127.0.0.1:3002/v1', { allowPrivate: true, resolveDns: false }), 'http://127.0.0.1:3002/v1');
});

test('guest model lists trim, deduplicate, and cap entries', () => {
  assert.deepEqual(validateGuestModelIds([' gpt-5 ', 'claude-sonnet-4-5', 'gpt-5']), ['gpt-5', 'claude-sonnet-4-5']);
  assert.throws(() => validateGuestModelIds('gpt-5'), /可用模型列表无效/);
  assert.throws(() => validateGuestModelIds(['']), /可用模型列表无效/);
  assert.throws(() => validateGuestModelIds(Array.from({ length: 201 }, (_, index) => `model-${index}`)), /可用模型列表无效/);
});

test('guest settings persist non-secret config and keep the API key in memory only', async () => {
  const root = await mkdtemp(join(tmpdir(), 'guest-store-'));
  try {
    const path = join(root, 'guest-settings.json');
    const store = new GuestStore(path, { allowPrivateEndpoints: true });
    await store.initialize();
    const saved = await store.saveSettings({
      endpoint: 'http://127.0.0.1:9001/v1/',
      allowedModels: ['gpt-5', 'gpt-5'],
      apiKey: 'guest-secret',
    });
    assert.equal(saved.endpoint, 'http://127.0.0.1:9001/v1');
    assert.equal(saved.hasApiKey, true);
    assert.deepEqual(saved.allowedModels, ['gpt-5']);
    assert.equal(store.canUseModel('gpt-5'), true);
    assert.equal(store.canUseModel('claude-sonnet-4-5'), false);

    const reloaded = new GuestStore(path, { allowPrivateEndpoints: true });
    await reloaded.initialize();
    assert.equal(reloaded.endpoint, 'http://127.0.0.1:9001/v1');
    assert.deepEqual(reloaded.publicSettings().allowedModels, ['gpt-5']);
    assert.equal(reloaded.publicSettings().hasApiKey, false);
    assert.equal(reloaded.apiKeyValue, '');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('guest settings can replace or explicitly clear the in-memory key', async () => {
  const root = await mkdtemp(join(tmpdir(), 'guest-store-'));
  try {
    const store = new GuestStore(join(root, 'guest-settings.json'), { allowPrivateEndpoints: true });
    await store.initialize();
    await store.saveSettings({ endpoint: '', allowedModels: [], apiKey: 'first-key' });
    assert.equal(store.apiKeyValue, 'first-key');
    await store.saveSettings({ endpoint: '', allowedModels: [], apiKey: '' });
    assert.equal(store.apiKeyValue, 'first-key');
    await store.saveSettings({ endpoint: '', allowedModels: [], apiKey: 'second-key' });
    assert.equal(store.apiKeyValue, 'second-key');
    await store.saveSettings({ endpoint: '', allowedModels: [], clearApiKey: true });
    assert.equal(store.apiKeyValue, '');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
