import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createChatApp } from '../lib/app.mjs';
import { listen, login, session } from './helpers.mjs';

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}

async function fixture({ seedData } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'light-chat-lazy-sync-'));
  await mkdir(join(root, 'public'), { recursive: true });
  if (seedData) {
    await mkdir(join(root, '.data'), { recursive: true });
    for (const [name, content] of Object.entries(seedData)) await writeFile(join(root, '.data', name), content);
  }
  await Promise.all([
    writeFile(join(root, 'public', 'login.html'), '<!doctype html><title>login</title>'),
    writeFile(join(root, 'public', 'app.html'), '<!doctype html><title>app</title>'),
    writeFile(join(root, 'public', 'app.js'), `// ${'x'.repeat(4096)}\nconsole.log('app');\n`),
  ]);
  let modelRequests = 0;
  let holdModels = false;
  const fetchImpl = async (url) => {
    const pathname = new URL(url).pathname;
    if (pathname === '/v1/models') {
      modelRequests += 1;
      if (holdModels) await new Promise((resolve) => setTimeout(resolve, 2500));
      return jsonResponse({ data: [{ id: 'chat-basic' }] });
    }
    return jsonResponse({ error: { message: 'not found' } }, 404);
  };
  const app = await createChatApp({
    rootDir: root,
    apiKey: 'test-api-key',
    bootstrapUsername: 'test-admin',
    bootstrapPassword: 'temporary-test-password',
    sessionSecret: 'test-session-secret-that-is-long-enough',
    newApiBaseUrl: 'http://newapi.test/v1',
    fetchImpl,
    port: 0,
  });
  const baseUrl = await listen(app.server);
  return {
    root, app, baseUrl,
    get modelRequests() { return modelRequests; },
    holdModels() { holdModels = true; },
    async close() { await app.close(); await rm(root, { recursive: true, force: true }); },
  };
}

async function signIn(context) {
  const initial = await session(context.baseUrl);
  const signedIn = await login(context.baseUrl, { ...initial, username: 'test-admin', password: 'temporary-test-password' });
  assert.equal(signedIn.response.status, 200, JSON.stringify(signedIn.body));
  return signedIn;
}

async function api(context, signedIn, method, pathname, body, headers = {}) {
  const requestHeaders = { Cookie: signedIn.cookie, ...headers };
  if (!['GET', 'HEAD'].includes(method)) {
    requestHeaders.Origin = context.baseUrl;
    requestHeaders['X-CSRF-Token'] = signedIn.body.csrfToken;
  }
  if (body !== undefined) requestHeaders['Content-Type'] = 'application/json';
  const response = await fetch(`${context.baseUrl}${pathname}`, { method, headers: requestHeaders, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : null };
}

const message = (id, content, createdAt) => ({ id, role: 'user', content, reasoning: '', modelId: '', mode: 'chat', replyToId: '', attachments: [], images: [], usage: null, variants: [], variantIndex: 0, createdAt });
const conversation = (id, updatedAt, messages, extra = {}) => ({
  id, title: id, titleCustomized: true, createdAt: 10, updatedAt, roleId: '', workflowId: '', folderId: '', copiedFromConversationId: '', favoriteOrder: null, favoritedAt: null, lastRequest: null, messages, ...extra,
});

test('conversation index returns metadata only and revalidates with ETag', async () => {
  const context = await fixture();
  try {
    const admin = await signIn(context);
    const seeded = await api(context, admin, 'PUT', '/api/conversations', { version: 1, conversations: [conversation('conv-a', 100, [message('m1', 'hello', 100), message('m2', 'world', 101)])] });
    assert.equal(seeded.response.status, 200);

    const index = await api(context, admin, 'GET', '/api/conversations/index');
    assert.equal(index.response.status, 200);
    assert.equal(index.body.conversations.length, 1);
    assert.equal(index.body.conversations[0].messageCount, 2);
    assert.equal(index.body.conversations[0].messages, undefined);
    const etag = index.response.headers.get('etag');
    assert.ok(etag);

    const revalidated = await fetch(`${context.baseUrl}/api/conversations/index`, { headers: { Cookie: admin.cookie, 'If-None-Match': etag } });
    assert.equal(revalidated.status, 304);

    const single = await api(context, admin, 'GET', '/api/conversations/conv-a');
    assert.equal(single.response.status, 200);
    assert.deepEqual(single.body.conversation.messages.map((item) => item.content), ['hello', 'world']);

    const missing = await api(context, admin, 'GET', '/api/conversations/conv-missing');
    assert.equal(missing.response.status, 404);

    // Any write invalidates the ETag.
    await api(context, admin, 'PATCH', '/api/conversations', { metas: [{ ...conversation('conv-a', 200, []), title: '新标题' }] });
    const changed = await fetch(`${context.baseUrl}/api/conversations/index`, { headers: { Cookie: admin.cookie, 'If-None-Match': etag } });
    assert.equal(changed.status, 200);
  } finally {
    await context.close();
  }
});

test('metadata patches never touch stored messages and empty full payloads cannot wipe history', async () => {
  const context = await fixture();
  try {
    const admin = await signIn(context);
    await api(context, admin, 'PUT', '/api/conversations', { version: 1, conversations: [conversation('conv-a', 100, [message('m1', '保留的历史', 100)])] });

    // A stub on a lazy client carries no messages; the meta patch must keep them.
    const meta = await api(context, admin, 'PATCH', '/api/conversations', { metas: [{ ...conversation('conv-a', 150, []), favoritedAt: 150, favoriteOrder: 0, title: '收藏后的标题' }] });
    assert.equal(meta.response.status, 200, JSON.stringify(meta.body));
    let single = await api(context, admin, 'GET', '/api/conversations/conv-a');
    assert.equal(single.body.conversation.title, '收藏后的标题');
    assert.equal(single.body.conversation.favoritedAt, 150);
    assert.equal(single.body.conversation.createdAt, 10);
    assert.deepEqual(single.body.conversation.messages.map((item) => item.content), ['保留的历史']);

    // An older meta patch is ignored.
    await api(context, admin, 'PATCH', '/api/conversations', { metas: [{ ...conversation('conv-a', 120, []), title: '过期标题' }] });
    single = await api(context, admin, 'GET', '/api/conversations/conv-a');
    assert.equal(single.body.conversation.title, '收藏后的标题');

    // A full conversation with zero messages is rejected unless explicitly cleared.
    const wipe = await api(context, admin, 'PATCH', '/api/conversations', { conversations: [conversation('conv-a', 999, [])] });
    assert.equal(wipe.response.status, 200);
    assert.deepEqual(wipe.body.rejectedIds, ['conv-a']);
    single = await api(context, admin, 'GET', '/api/conversations/conv-a');
    assert.equal(single.body.conversation.messages.length, 1);

    const cleared = await api(context, admin, 'PATCH', '/api/conversations', { conversations: [conversation('conv-a', 1000, [])], clearedIds: ['conv-a'] });
    assert.deepEqual(cleared.body.rejectedIds, []);
    single = await api(context, admin, 'GET', '/api/conversations/conv-a');
    assert.equal(single.body.conversation.messages.length, 0);

    // Full upserts and deletions persist; the response is the small index.
    const upsert = await api(context, admin, 'PATCH', '/api/conversations', { conversations: [conversation('conv-b', 2000, [message('b1', '新会话', 2000)])], deletedIds: ['conv-a'] });
    assert.deepEqual(upsert.body.conversations.map((item) => [item.id, item.messageCount]), [['conv-b', 1]]);
    assert.ok(upsert.body.deletedIds.includes('conv-a'));
    const persisted = JSON.parse(await readFile(join(context.root, '.data', 'conversations-00000.json'), 'utf8'));
    assert.deepEqual(persisted.conversations.map((item) => item.id), ['conv-b']);

    const minimalDelete = await api(context, admin, 'DELETE', '/api/conversations/conv-b', undefined, { Prefer: 'return=minimal' });
    assert.equal(minimalDelete.response.status, 200);
    assert.deepEqual(minimalDelete.body.conversations, []);
    assert.equal(typeof minimalDelete.body.revision, 'number');
  } finally {
    await context.close();
  }
});

test('media lookup finds the owning conversation without downloading history', async () => {
  const context = await fixture();
  try {
    const admin = await signIn(context);
    const withImage = { ...message('m-img', '图片', 100), images: [{ id: 'imgAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', url: '/api/media/imgAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', mimeType: 'image/png', fileName: 'a.png', isImage: true, alt: '', size: 1 }] };
    await api(context, admin, 'PUT', '/api/conversations', { version: 1, conversations: [conversation('conv-img', 100, [withImage])] });
    const found = await api(context, admin, 'GET', '/api/conversations/locate-media?id=imgAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    assert.equal(found.response.status, 200, JSON.stringify(found.body));
    assert.deepEqual(found.body, { conversationId: 'conv-img', messageId: 'm-img' });
    const notFound = await api(context, admin, 'GET', '/api/conversations/locate-media?id=unknown');
    assert.equal(notFound.response.status, 404);
  } finally {
    await context.close();
  }
});

test('static assets are gzip-compressed and revalidated instead of re-downloaded', async () => {
  const context = await fixture();
  try {
    const first = await fetch(`${context.baseUrl}/app.js`, { headers: { 'Accept-Encoding': 'gzip' } });
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('content-encoding'), 'gzip');
    assert.equal(first.headers.get('cache-control'), 'no-cache');
    assert.match(await first.text(), /console\.log\('app'\)/);
    const etag = first.headers.get('etag');
    const second = await fetch(`${context.baseUrl}/app.js`, { headers: { 'If-None-Match': etag } });
    assert.equal(second.status, 304);
  } finally {
    await context.close();
  }
});

test('read-only model listing serves the cached catalog while a slow upstream refreshes', async () => {
  const context = await fixture();
  try {
    const admin = await signIn(context);
    const warm = await api(context, admin, 'GET', '/api/models');
    assert.equal(warm.response.status, 200);
    // Expire the cache (by moving the clock) and make the upstream slow.
    context.holdModels();
    const originalNow = Date.now;
    Date.now = () => originalNow() + 10 * 60 * 1000;
    try {
      const started = originalNow();
      const stale = await api(context, admin, 'GET', '/api/models');
      assert.equal(stale.response.status, 200);
      assert.deepEqual(stale.body.models.map((model) => model.id), ['chat-basic']);
      assert.ok(originalNow() - started < 2000, 'stale catalog must be returned without waiting for the upstream');
    } finally {
      Date.now = originalNow;
    }
  } finally {
    await context.close();
  }
});

test('start-up recovers a damaged admin history from .bak instead of saving an empty one', async () => {
  const good = JSON.stringify({ version: 1, folders: [], conversations: [conversation('conv-safe', 100, [message('m1', '必须保留', 100)])] });
  const context = await fixture({ seedData: { 'conversations-00000.json': '{"version":1,"conversations":[{"id":', 'conversations-00000.json.bak': good } });
  try {
    const admin = await signIn(context);
    const single = await api(context, admin, 'GET', '/api/conversations/conv-safe');
    assert.equal(single.response.status, 200);
    assert.deepEqual(single.body.conversation.messages.map((item) => item.content), ['必须保留']);
    assert.equal(await readFile(join(context.root, '.data', 'conversations-00000.json.bak'), 'utf8'), good);
  } finally {
    await context.close();
  }
});

test('start-up refuses to run when the admin history and its backup are both unusable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'light-chat-lazy-sync-'));
  try {
    await mkdir(join(root, '.data'), { recursive: true });
    await writeFile(join(root, '.data', 'conversations-00000.json'), 'broken');
    await writeFile(join(root, '.data', 'conversations-00000.json.bak'), 'broken too');
    await assert.rejects(() => createChatApp({
      rootDir: root, apiKey: 'test-api-key', bootstrapUsername: 'test-admin', bootstrapPassword: 'temporary-test-password',
      sessionSecret: 'test-session-secret-that-is-long-enough', newApiBaseUrl: 'http://newapi.test/v1',
      fetchImpl: async () => jsonResponse({ data: [{ id: 'chat-basic' }] }), port: 0,
    }), /拒绝启动/);
    assert.equal(await readFile(join(root, '.data', 'conversations-00000.json'), 'utf8'), 'broken');
    assert.equal(await readFile(join(root, '.data', 'conversations-00000.json.bak'), 'utf8'), 'broken too');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('start-up skips only unrecognizable conversation records and preserves the original file', async () => {
  const raw = JSON.stringify({ version: 1, folders: [], conversations: [conversation('conv-ok', 100, [message('m1', '正常会话', 100)]), { id: 'conv-bad' }] });
  const context = await fixture({ seedData: { 'conversations-00000.json': raw } });
  try {
    const admin = await signIn(context);
    const index = await api(context, admin, 'GET', '/api/conversations/index');
    assert.deepEqual(index.body.conversations.map((item) => item.id), ['conv-ok']);
    const files = await readdir(join(context.root, '.data'));
    const preserved = files.find((name) => name.startsWith('conversations-00000.json.pre-normalize-'));
    assert.ok(preserved);
    assert.equal(await readFile(join(context.root, '.data', preserved), 'utf8'), raw);
  } finally {
    await context.close();
  }
});
