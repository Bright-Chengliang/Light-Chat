import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createChatApp } from '../lib/app.mjs';
import { hashPassword } from '../lib/security.mjs';
import { listen, login, session, tinyPng } from './helpers.mjs';

const MODELS = ['chat-basic', 'chat-extra', 'chat-denied', 'gpt-image-basic', 'gpt-image-denied'];

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}

function controlledUpstream() {
  const state = {
    requests: [],
    failChat: false,
    failImage: false,
    holdChat: false,
    holdImage: false,
    pendingChats: [],
    pendingImages: [],
  };
  const successfulChat = () => jsonResponse({
    choices: [{ message: { content: '测试回答' } }],
    usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
  });
  state.fetch = async (url, options = {}) => {
    const pathname = new URL(url).pathname;
    state.requests.push({ pathname, method: options.method || 'GET', body: options.body });
    if (pathname === '/v1/models') return jsonResponse({ data: MODELS.map((id) => ({ id })) });
    if (pathname === '/v1/chat/completions') {
      if (state.failChat) return jsonResponse({ error: { message: 'forced chat failure' } }, 500);
      if (state.holdChat) {
        return new Promise((resolve, reject) => {
          const pending = { resolve: () => resolve(successfulChat()), reject };
          state.pendingChats.push(pending);
          options.signal?.addEventListener('abort', () => reject(options.signal.reason), { once: true });
        });
      }
      return successfulChat();
    }
    if (pathname === '/v1/images/generations') {
      if (state.failImage) return jsonResponse({ error: { message: 'forced image failure' } }, 500);
      if (state.holdImage) {
        return new Promise((resolve, reject) => {
          const pending = { resolve: () => resolve(jsonResponse({ data: [{ b64_json: tinyPng().toString('base64') }] })), reject };
          state.pendingImages.push(pending);
          options.signal?.addEventListener('abort', () => reject(options.signal.reason), { once: true });
        });
      }
      return jsonResponse({ data: [{ b64_json: tinyPng().toString('base64') }] });
    }
    return jsonResponse({ error: { message: 'not found' } }, 404);
  };
  state.count = (pathname) => state.requests.filter((request) => request.pathname === pathname).length;
  state.releaseChats = () => {
    const pending = state.pendingChats.splice(0);
    state.holdChat = false;
    for (const request of pending) request.resolve();
  };
  state.releaseImages = () => {
    const pending = state.pendingImages.splice(0);
    state.holdImage = false;
    for (const request of pending) request.resolve();
  };
  return state;
}

async function fixture({ legacyAccount } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'light-chat-account-v3-'));
  await mkdir(join(root, 'public'), { recursive: true });
  await Promise.all([
    writeFile(join(root, 'public', 'login.html'), '<!doctype html><title>login</title>'),
    writeFile(join(root, 'public', 'app.html'), '<!doctype html><title>app</title>'),
  ]);
  if (legacyAccount) {
    await mkdir(join(root, '.data'), { recursive: true });
    await writeFile(join(root, '.data', 'account.json'), `${JSON.stringify(legacyAccount, null, 2)}\n`);
  }
  const upstream = controlledUpstream();
  const app = await createChatApp({
    rootDir: root,
    apiKey: 'test-api-key',
    bootstrapUsername: 'test-admin',
    bootstrapPassword: 'temporary-test-password',
    sessionSecret: 'test-session-secret-that-is-long-enough',
    newApiBaseUrl: 'http://newapi.test/v1',
    fetchImpl: upstream.fetch,
    port: 0,
  });
  const baseUrl = await listen(app.server);
  return {
    root, app, upstream, baseUrl,
    async close() {
      upstream.releaseChats();
      upstream.releaseImages();
      await app.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function signIn(context, username = 'test-admin', password = 'temporary-test-password') {
  const initial = await session(context.baseUrl);
  const signedIn = await login(context.baseUrl, { ...initial, username, password });
  assert.equal(signedIn.response.status, 200, JSON.stringify(signedIn.body));
  return signedIn;
}

async function api(context, signedIn, method, pathname, body, headers = {}) {
  const requestHeaders = { Cookie: signedIn.cookie, ...headers };
  if (!['GET', 'HEAD'].includes(method)) {
    requestHeaders.Origin = context.baseUrl;
    requestHeaders['X-CSRF-Token'] = signedIn.body.csrfToken;
  }
  let payload;
  if (body !== undefined && !Buffer.isBuffer(body)) {
    requestHeaders['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  } else payload = body;
  const response = await fetch(`${context.baseUrl}${pathname}`, { method, headers: requestHeaders, body: payload });
  const contentType = response.headers.get('content-type') || '';
  return { response, body: contentType.includes('application/json') ? await response.json() : await response.arrayBuffer() };
}

async function createUser(context, admin, overrides = {}) {
  const result = await api(context, admin, 'POST', '/api/admin/users', {
    username: 'ordinary-user',
    password: 'ordinary-user-password',
    credits: 0,
    extraModels: [],
    ...overrides,
  });
  assert.equal(result.response.status, 201, JSON.stringify(result.body));
  return result.body.user;
}

async function quota(context, signedIn) {
  const result = await api(context, signedIn, 'GET', '/api/quota');
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  return result.body;
}

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(message);
}

test('account v2 migrates to v3 without changing the administrator hash or UID', async () => {
  const passwordHash = await hashPassword('legacy-admin-password');
  const updatedAt = '2026-07-01T00:00:00.000Z';
  const context = await fixture({ legacyAccount: { version: 2, username: 'legacy-admin', passwordHash, updatedAt } });
  try {
    const persisted = JSON.parse(await readFile(join(context.root, '.data', 'account.json'), 'utf8'));
    assert.equal(persisted.version, 3);
    assert.equal(persisted.users.length, 1);
    assert.deepEqual(
      { uid: persisted.users[0].uid, username: persisted.users[0].username, role: persisted.users[0].role, passwordHash: persisted.users[0].passwordHash },
      { uid: '00000', username: 'legacy-admin', role: 'admin', passwordHash },
    );
    assert.equal(persisted.users[0].updatedAt, updatedAt);

    const admin = await signIn(context, 'legacy-admin', 'legacy-admin-password');
    assert.equal(admin.body.uid, '00000');
    assert.equal(admin.body.role, 'admin');
  } finally {
    await context.close();
  }
});

test('ordinary login, administrator protection, recharge, disable, and delete enforce account lifecycle', async () => {
  const context = await fixture();
  try {
    const admin = await signIn(context);
    const first = await createUser(context, admin, { username: 'lifecycle-user', password: 'lifecycle-user-password', credits: 2, extraModels: ['chat-basic'] });
    assert.equal(first.uid, '0000000');
    const ordinary = await signIn(context, 'lifecycle-user', 'lifecycle-user-password');
    assert.deepEqual(
      { uid: ordinary.body.uid, role: ordinary.body.role, credits: ordinary.body.credits },
      { uid: first.uid, role: 'user', credits: 2 },
    );
    const ordinaryAdminList = await api(context, ordinary, 'GET', '/api/admin/users');
    assert.equal(ordinaryAdminList.response.status, 403);
    assert.equal(ordinaryAdminList.body.code, 'ADMIN_REQUIRED');

    for (const [method, pathname, body] of [
      ['DELETE', '/api/admin/users/00000', undefined],
      ['PUT', '/api/admin/users/00000/status', { disabled: true }],
      ['POST', '/api/admin/users/00000/recharge', { points: 10 }],
      ['PUT', '/api/admin/users/00000/model-access', { modelGroupId: null, extraModels: [] }],
    ]) {
      const protectedResult = await api(context, admin, method, pathname, body);
      assert.equal(protectedResult.response.status, 403);
      assert.equal(protectedResult.body.code, 'ADMIN_PROTECTED');
    }

    const recharged = await api(context, admin, 'POST', `/api/admin/users/${first.uid}/recharge`, { points: 8 });
    assert.equal(recharged.response.status, 200);
    assert.equal(recharged.body.user.credits, 10);
    assert.equal((await quota(context, ordinary)).credits, 10);

    const disabled = await api(context, admin, 'PUT', `/api/admin/users/${first.uid}/status`, { disabled: true });
    assert.equal(disabled.response.status, 200);
    assert.equal(disabled.body.user.disabled, true);
    assert.equal((await api(context, ordinary, 'GET', '/api/status')).response.status, 401);

    const enabled = await api(context, admin, 'PUT', `/api/admin/users/${first.uid}/status`, { disabled: false });
    assert.equal(enabled.response.status, 200);
    assert.equal(enabled.body.user.disabled, false);
    assert.equal((await api(context, ordinary, 'GET', '/api/status')).response.status, 401);

    const replacementSession = await signIn(context, 'lifecycle-user', 'lifecycle-user-password');
    const deleted = await api(context, admin, 'DELETE', `/api/admin/users/${first.uid}`);
    assert.equal(deleted.response.status, 200);
    assert.equal((await api(context, replacementSession, 'GET', '/api/status')).response.status, 401);
  } finally {
    await context.close();
  }
});

test('administrator conversation history merges device-local records on the server without exposing them to ordinary users', async () => {
  const context = await fixture();
  try {
    const admin = await signIn(context);
    const conversation = (id, updatedAt, content, workflowId = '') => ({
      id, title: content, titleCustomized: true, createdAt: updatedAt - 1, updatedAt, roleId: '', workflowId, folderId: '', copiedFromConversationId: '', favoriteOrder: null, lastRequest: null,
      messages: [{ id: `${id}-message`, role: 'user', content, reasoning: '', modelId: '', mode: 'chat', replyToId: '', attachments: [], images: [], usage: null, variants: [], variantIndex: 0, createdAt: updatedAt }],
    });
    const first = await api(context, admin, 'PUT', '/api/conversations', { version: 1, conversations: [conversation('device-a', 100, '来自设备 A')] });
    assert.equal(first.response.status, 200, JSON.stringify(first.body));
    const merged = await api(context, admin, 'PUT', '/api/conversations', { version: 1, conversations: [conversation('device-a', 200, '设备 A 的新版本', 'image-prompt-architect'), conversation('device-b', 150, '来自设备 B')] });
    assert.equal(merged.response.status, 200, JSON.stringify(merged.body));
    assert.deepEqual(merged.body.conversations.map((item) => [item.id, item.messages[0].content]), [['device-a', '设备 A 的新版本'], ['device-b', '来自设备 B']]);
    assert.equal(merged.body.conversations.find((item) => item.id === 'device-a').workflowId, 'image-prompt-architect');
    const persisted = JSON.parse(await readFile(join(context.root, '.data', 'conversations-00000.json'), 'utf8'));
    assert.equal(persisted.conversations.length, 2);

    const user = await createUser(context, admin, { username: 'history-user', password: 'history-user-password', credits: 1, extraModels: ['chat-basic'] });
    const ordinary = await signIn(context, user.username, 'history-user-password');
    for (const method of ['GET', 'PUT']) {
      const result = await api(context, ordinary, method, '/api/conversations', method === 'PUT' ? { version: 1, conversations: [] } : undefined);
      assert.equal(result.response.status, 403);
      assert.equal(result.body.code, 'ADMIN_REQUIRED');
    }

    const noCsrf = await fetch(`${context.baseUrl}/api/conversations`, {
      method: 'PUT', headers: { Cookie: admin.cookie, Origin: context.baseUrl, 'Content-Type': 'application/json' }, body: JSON.stringify({ version: 1, conversations: [] }),
    });
    assert.equal(noCsrf.status, 403);
  } finally {
    await context.close();
  }
});

test('administrator history restores a missing image ID only from a unique owned media equivalent', async () => {
  const context = await fixture();
  try {
    const admin = await signIn(context);
    const image = tinyPng(4, 4);
    const uploaded = await api(context, admin, 'POST', '/api/uploads', image, {
      'Content-Type': 'image/png',
      'X-File-Name': encodeURIComponent('history-reference.png'),
    });
    assert.equal(uploaded.response.status, 201, JSON.stringify(uploaded.body));
    const source = uploaded.body.attachment;
    const sent = await api(context, admin, 'POST', '/api/chat', {
      model: 'chat-basic', stream: false,
      messages: [{ role: 'user', content: '保留历史图片', attachmentIds: [source.id] }],
    });
    assert.equal(sent.response.status, 200, JSON.stringify(sent.body));

    const legacyId = 'L'.repeat(32);
    const conversation = {
      id: 'restore-history-media', title: '恢复历史图片', titleCustomized: true, createdAt: 100, updatedAt: 100, roleId: '', workflowId: '', folderId: '', copiedFromConversationId: '', favoriteOrder: null, lastRequest: null,
      messages: [{
        id: 'restore-history-message', role: 'user', content: '旧历史消息', reasoning: '', modelId: '', mode: 'chat', replyToId: '',
        attachments: [{ ...source, id: legacyId, url: `/api/media/${legacyId}` }], images: [], usage: null, variants: [], variantIndex: 0, createdAt: 100,
      }],
    };
    const saved = await api(context, admin, 'PUT', '/api/conversations', { version: 1, conversations: [conversation] });
    assert.equal(saved.response.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.conversations[0].messages[0].attachments[0].url, `/api/media/${legacyId}`);

    const recovered = await api(context, admin, 'GET', `/api/media/${legacyId}`);
    assert.equal(recovered.response.status, 200);
    assert.deepEqual(Buffer.from(recovered.body), image);
  } finally {
    await context.close();
  }
});

test('server startup restores recoverable historical administrator images before serving conversations', async () => {
  const context = await fixture();
  let restarted;
  try {
    const admin = await signIn(context);
    const image = tinyPng(4, 4);
    const uploaded = await api(context, admin, 'POST', '/api/uploads', image, {
      'Content-Type': 'image/png',
      'X-File-Name': encodeURIComponent('startup-history.png'),
    });
    assert.equal(uploaded.response.status, 201, JSON.stringify(uploaded.body));
    const source = uploaded.body.attachment;
    await api(context, admin, 'POST', '/api/chat', {
      model: 'chat-basic', stream: false,
      messages: [{ role: 'user', content: '保留启动恢复图片', attachmentIds: [source.id] }],
    });

    await context.app.close();
    const legacyId = 'S'.repeat(32);
    await writeFile(join(context.root, '.data', 'conversations-00000.json'), `${JSON.stringify({
      version: 1,
      conversations: [{
        id: 'startup-history-media', title: '启动恢复图片', titleCustomized: true, createdAt: 100, updatedAt: 100, roleId: '', workflowId: '', folderId: '', copiedFromConversationId: '', favoriteOrder: null, lastRequest: null,
        messages: [{ id: 'startup-history-message', role: 'user', content: '旧图片', reasoning: '', modelId: '', mode: 'chat', replyToId: '', attachments: [{ ...source, id: legacyId, url: `/api/media/${legacyId}` }], images: [], usage: null, variants: [], variantIndex: 0, createdAt: 100 }],
      }],
    }, null, 2)}\n`);

    restarted = await createChatApp({
      rootDir: context.root,
      apiKey: 'test-api-key',
      bootstrapUsername: 'test-admin',
      bootstrapPassword: 'temporary-test-password',
      sessionSecret: 'test-session-secret-that-is-long-enough',
      newApiBaseUrl: 'http://newapi.test/v1',
      fetchImpl: context.upstream.fetch,
      port: 0,
    });
    const baseUrl = await listen(restarted.server);
    const initial = await session(baseUrl);
    const restartedAdmin = await login(baseUrl, { ...initial, username: 'test-admin', password: 'temporary-test-password' });
    const recovered = await fetch(`${baseUrl}/api/media/${legacyId}`, { headers: { Cookie: restartedAdmin.cookie } });
    assert.equal(recovered.status, 200);
    assert.deepEqual(Buffer.from(await recovered.arrayBuffer()), image);
  } finally {
    await restarted?.close().catch(() => undefined);
    await context.app.close().catch(() => undefined);
    await rm(context.root, { recursive: true, force: true });
  }
});

test('successful chat and image calls charge points while upstream failures refund reservations', async () => {
  const context = await fixture();
  try {
    const admin = await signIn(context);
    await createUser(context, admin, {
      username: 'billing-user', password: 'billing-user-password', credits: 12,
      extraModels: ['chat-basic', 'gpt-image-basic'],
    });
    const user = await signIn(context, 'billing-user', 'billing-user-password');

    context.upstream.failChat = true;
    const failedChat = await api(context, user, 'POST', '/api/chat', {
      model: 'chat-basic', stream: false, messages: [{ role: 'user', content: '失败对话' }],
    });
    assert.equal(failedChat.response.status, 502);
    assert.deepEqual(await quota(context, user), {
      uid: '0000000', role: 'user', credits: 12, usagePoints: 0, chatCalls: 0, imageCalls: 0, costs: { chat: 1, image: 5, geminiFlashImage: 1 },
    });

    context.upstream.failChat = false;
    context.upstream.failImage = true;
    const failedImage = await api(context, user, 'POST', '/api/images/generations', {
      model: 'gpt-image-basic', prompt: '失败生图', size: '1024x1024', count: 1,
    });
    assert.equal(failedImage.response.status, 502);
    assert.equal((await quota(context, user)).credits, 12);

    context.upstream.failImage = false;
    const successfulChat = await api(context, user, 'POST', '/api/chat', {
      model: 'chat-basic', stream: false, messages: [{ role: 'user', content: '成功对话' }],
    });
    assert.equal(successfulChat.response.status, 200);
    const successfulImage = await api(context, user, 'POST', '/api/images/generations', {
      model: 'gpt-image-basic', prompt: '成功生图', size: '1024x1024', count: 1,
    });
    assert.equal(successfulImage.response.status, 200);
    const afterSuccess = await quota(context, user);
    assert.deepEqual(
      { credits: afterSuccess.credits, usagePoints: afterSuccess.usagePoints, chatCalls: afterSuccess.chatCalls, imageCalls: afterSuccess.imageCalls },
      { credits: 6, usagePoints: 6, chatCalls: 1, imageCalls: 1 },
    );
  } finally {
    await context.close();
  }
});

test('client-cancelled model requests commit each model type at its normal rate', async () => {
  const context = await fixture();
  try {
    const admin = await signIn(context);
    await createUser(context, admin, {
      username: 'cancel-user', password: 'cancel-user-password', credits: 7, extraModels: ['chat-basic', 'gpt-image-basic'],
    });
    const user = await signIn(context, 'cancel-user', 'cancel-user-password');
    context.upstream.holdChat = true;
    const controller = new AbortController();
    const request = fetch(`${context.baseUrl}/api/chat`, {
      method: 'POST',
      headers: {
        Cookie: user.cookie,
        Origin: context.baseUrl,
        'X-CSRF-Token': user.body.csrfToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: 'chat-basic', stream: false, messages: [{ role: 'user', content: '主动取消' }] }),
      signal: controller.signal,
    });
    await waitFor(() => context.upstream.pendingChats.length === 1, '待取消请求没有进入上游');
    controller.abort();
    await assert.rejects(request, { name: 'AbortError' });
    await waitFor(async () => {
      const current = await quota(context, user);
      return current.credits === 6 && current.usagePoints === 1 && current.chatCalls === 1;
    }, '主动取消对话后没有按 1 积分结算');

    context.upstream.holdImage = true;
    const imageController = new AbortController();
    const imageRequest = fetch(`${context.baseUrl}/api/images/generations`, {
      method: 'POST',
      headers: {
        Cookie: user.cookie,
        Origin: context.baseUrl,
        'X-CSRF-Token': user.body.csrfToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: 'gpt-image-basic', prompt: '主动取消生图', size: '1024x1024', count: 1 }),
      signal: imageController.signal,
    });
    await waitFor(() => context.upstream.pendingImages.length === 1, '待取消生图请求没有进入上游');
    imageController.abort();
    await assert.rejects(imageRequest, { name: 'AbortError' });
    await waitFor(async () => {
      const current = await quota(context, user);
      return current.credits === 1 && current.usagePoints === 6 && current.chatCalls === 1 && current.imageCalls === 1;
    }, '主动取消生图后没有按 5 积分结算');
  } finally {
    await context.close();
  }
});

test('insufficient balance rejects chat and image before the upstream service is called', async () => {
  const context = await fixture();
  try {
    const admin = await signIn(context);
    await createUser(context, admin, {
      username: 'empty-balance-user', password: 'empty-balance-password', credits: 0,
      extraModels: ['chat-basic', 'gpt-image-basic'],
    });
    const user = await signIn(context, 'empty-balance-user', 'empty-balance-password');
    const chatCount = context.upstream.count('/v1/chat/completions');
    const imageCount = context.upstream.count('/v1/images/generations');
    const chat = await api(context, user, 'POST', '/api/chat', {
      model: 'chat-basic', stream: false, messages: [{ role: 'user', content: '无余额' }],
    });
    const image = await api(context, user, 'POST', '/api/images/generations', {
      model: 'gpt-image-basic', prompt: '无余额', size: '1024x1024', count: 1,
    });
    assert.equal(chat.response.status, 402);
    assert.equal(chat.body.code, 'INSUFFICIENT_CREDITS');
    assert.equal(image.response.status, 402);
    assert.equal(image.body.code, 'INSUFFICIENT_CREDITS');
    assert.equal(context.upstream.count('/v1/chat/completions'), chatCount);
    assert.equal(context.upstream.count('/v1/images/generations'), imageCount);
  } finally {
    await context.close();
  }
});

test('concurrent requests reserve credits before upstream completion', async () => {
  const context = await fixture();
  try {
    const admin = await signIn(context);
    await createUser(context, admin, {
      username: 'concurrent-user', password: 'concurrent-user-password', credits: 1, extraModels: ['chat-basic'],
    });
    const user = await signIn(context, 'concurrent-user', 'concurrent-user-password');
    context.upstream.holdChat = true;
    const firstPromise = api(context, user, 'POST', '/api/chat', {
      model: 'chat-basic', stream: false, messages: [{ role: 'user', content: '第一个请求' }],
    });
    await waitFor(() => context.upstream.pendingChats.length === 1, '首个请求没有进入可控上游');

    const second = await api(context, user, 'POST', '/api/chat', {
      model: 'chat-basic', stream: false, messages: [{ role: 'user', content: '第二个请求' }],
    });
    assert.equal(second.response.status, 402);
    assert.equal(second.body.code, 'INSUFFICIENT_CREDITS');
    assert.equal(context.upstream.count('/v1/chat/completions'), 1);

    context.upstream.releaseChats();
    const first = await firstPromise;
    assert.equal(first.response.status, 200);
    assert.equal((await quota(context, user)).credits, 0);
  } finally {
    await context.close();
  }
});

test('model groups plus extra grants filter model listing and block forged chat/image requests', async () => {
  const context = await fixture();
  try {
    const admin = await signIn(context);
    const groups = await api(context, admin, 'PUT', '/api/admin/model-groups', {
      groups: [{ id: 'basic-access', name: '基础权限', modelIds: ['chat-basic', 'gpt-image-basic'] }],
    });
    assert.equal(groups.response.status, 200, JSON.stringify(groups.body));
    const created = await createUser(context, admin, {
      username: 'scoped-user', password: 'scoped-user-password', credits: 20,
      modelGroupId: 'basic-access', extraModels: ['chat-extra'],
    });
    assert.equal(created.modelGroupId, 'basic-access');
    assert.deepEqual(created.extraModels, ['chat-extra']);
    const user = await signIn(context, 'scoped-user', 'scoped-user-password');

    const listed = await api(context, user, 'GET', '/api/models');
    assert.equal(listed.response.status, 200);
    assert.deepEqual(listed.body.models.map((model) => model.id).sort(), ['chat-basic', 'chat-extra', 'gpt-image-basic']);

    const allowedExtra = await api(context, user, 'POST', '/api/chat', {
      model: 'chat-extra', stream: false, messages: [{ role: 'user', content: '额外授权模型' }],
    });
    assert.equal(allowedExtra.response.status, 200);
    const upstreamChats = context.upstream.count('/v1/chat/completions');
    const upstreamImages = context.upstream.count('/v1/images/generations');

    const forgedChat = await api(context, user, 'POST', '/api/chat', {
      model: 'chat-denied', stream: false, messages: [{ role: 'user', content: '伪造对话模型' }],
    });
    const forgedImage = await api(context, user, 'POST', '/api/images/generations', {
      model: 'gpt-image-denied', prompt: '伪造生图模型', size: '1024x1024', count: 1,
    });
    for (const result of [forgedChat, forgedImage]) {
      assert.equal(result.response.status, 403);
      assert.equal(result.body.code, 'MODEL_ACCESS_DENIED');
    }
    assert.equal(context.upstream.count('/v1/chat/completions'), upstreamChats);
    assert.equal(context.upstream.count('/v1/images/generations'), upstreamImages);
  } finally {
    await context.close();
  }
});

test('preferences, roles, and media are isolated by ordinary-user UID', async () => {
  const context = await fixture();
  try {
    const admin = await signIn(context);
    const first = await createUser(context, admin, {
      username: 'isolated-alice', password: 'isolated-alice-password', credits: 5, extraModels: ['chat-basic'],
    });
    const second = await createUser(context, admin, {
      username: 'isolated-bob', password: 'isolated-bob-password', credits: 5, extraModels: ['chat-basic'],
    });
    assert.deepEqual([first.uid, second.uid], ['0000000', '0000001']);
    const alice = await signIn(context, 'isolated-alice', 'isolated-alice-password');
    const bob = await signIn(context, 'isolated-bob', 'isolated-bob-password');

    const alicePreferences = {
      favoriteGroups: [{ id: 'alice-favorites', name: 'Alice 收藏', items: [{ model: 'chat-basic', mode: 'chat', label: 'Alice 模型' }] }],
      selected: { model: 'chat-basic', mode: 'chat' },
      modelContextLimits: { 'chat-basic': 131072 },
    };
    const savedPreferences = await api(context, alice, 'PUT', '/api/preferences', alicePreferences);
    assert.equal(savedPreferences.response.status, 200);
    const bobPreferences = await api(context, bob, 'GET', '/api/preferences');
    assert.equal(bobPreferences.response.status, 200);
    assert.deepEqual(bobPreferences.body.favoriteGroups, [{
      id: 'all-models', name: '全部模型',
      items: [{ modelId: 'chat-basic', model: 'chat-basic', mode: 'chat', label: 'chat-basic' }],
    }]);
    assert.deepEqual((await api(context, alice, 'GET', '/api/preferences')).body.favoriteGroups, savedPreferences.body.favoriteGroups);

    const aliceRoles = {
      version: 1,
      folders: [{ id: 'alice-folder', name: 'Alice 文件夹', roles: [{ id: 'alice-role', name: 'Alice 专家', description: '', systemPrompt: '仅属于 Alice。' }] }],
    };
    assert.equal((await api(context, alice, 'PUT', '/api/roles', aliceRoles)).response.status, 200);
    assert.deepEqual((await api(context, bob, 'GET', '/api/roles')).body, { version: 1, folders: [] });
    const forgedRole = await api(context, bob, 'POST', '/api/chat', {
      model: 'chat-basic', roleId: 'alice-role', stream: false, messages: [{ role: 'user', content: '尝试使用他人角色' }],
    });
    assert.equal(forgedRole.response.status, 400);
    assert.equal(forgedRole.body.code, 'ROLE_NOT_FOUND');

    const uploaded = await api(context, alice, 'POST', '/api/uploads', tinyPng(4, 4), {
      'Content-Type': 'image/png',
      'X-File-Name': encodeURIComponent('alice.png'),
    });
    assert.equal(uploaded.response.status, 201);
    const mediaUrl = uploaded.body.attachment.url;
    assert.equal((await api(context, alice, 'GET', mediaUrl)).response.status, 200);
    assert.equal((await api(context, bob, 'GET', mediaUrl)).response.status, 404);
    const forgedAttachment = await api(context, bob, 'POST', '/api/chat', {
      model: 'chat-basic', stream: false,
      messages: [{ role: 'user', content: '尝试读取他人附件', attachmentIds: [uploaded.body.attachment.id] }],
    });
    assert.equal(forgedAttachment.response.status, 404);
    assert.equal(context.upstream.count('/v1/chat/completions'), 0);
  } finally {
    await context.close();
  }
});

test('ordinary users with at most twenty available models receive every model as their initial favorites', async () => {
  const context = await fixture();
  try {
    const admin = await signIn(context);
    const user = await createUser(context, admin, {
      username: 'all-favorites-user', password: 'all-favorites-password', credits: 1,
      extraModels: ['chat-basic', 'chat-extra', 'gpt-image-basic'],
    });
    const signedIn = await signIn(context, user.username, 'all-favorites-password');
    const preferences = await api(context, signedIn, 'GET', '/api/preferences');
    assert.equal(preferences.response.status, 200, JSON.stringify(preferences.body));
    assert.deepEqual(preferences.body.favoriteGroups.map((group) => group.name), ['全部模型']);
    assert.deepEqual(preferences.body.favoriteGroups[0].items.map((item) => [item.modelId, item.mode]), [
      ['chat-basic', 'chat'], ['chat-extra', 'chat'], ['gpt-image-basic', 'image'],
    ]);
    const reloaded = await api(context, signedIn, 'GET', '/api/preferences');
    assert.deepEqual(reloaded.body.favoriteGroups, preferences.body.favoriteGroups);
  } finally {
    await context.close();
  }
});
