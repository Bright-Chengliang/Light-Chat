import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createChatApp, workflowImagePromptCandidates } from '../lib/app.mjs';
import { createFakeNewApi, listen, login, session, tinyJpeg, tinyPng, cookieFrom } from './helpers.mjs';

const WORKFLOW_ROLES = {
  version: 1,
  folders: [{
    id: 'workflow-roles',
    name: '工作流',
    roles: [
      { id: 'role-mrsmkx9c-2293', name: '高级角色设定图提示词架构师', description: '', systemPrompt: '将用户需求整理成完整的角色设定图绘图提示词。' },
      { id: 'role-mrqi90jc-7jmq', name: '史诗叙事海报生成大师v3', description: '', systemPrompt: '将用户需求整理成完整的史诗叙事海报绘图提示词。' },
    ],
  }],
};

async function fixture({ imageUpscaler = null, fakeOptions = {} } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'chat-app-'));
  await mkdir(join(root, 'public'), { recursive: true });
  await mkdir(join(root, '.data'), { recursive: true });
  await Promise.all([
    writeFile(join(root, 'public', 'login.html'), '<!doctype html><title>login</title>'),
    writeFile(join(root, 'public', 'app.html'), '<!doctype html><title>app</title>'),
    writeFile(join(root, '.data', 'roles.json'), JSON.stringify(WORKFLOW_ROLES)),
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
    pdfTextExtractor: { extract: async () => '[Page 1]\nLeft column first.\nRight column second.' },
    imageUpscaler,
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

async function authenticated(context) {
  const initial = await session(context.baseUrl);
  const signedIn = await login(context.baseUrl, initial);
  assert.equal(signedIn.response.status, 200);
  return signedIn;
}

async function uploadFile(context, signedIn, { buffer, mimeType, fileName }) {
  const response = await fetch(`${context.baseUrl}/api/uploads`, {
    method: 'POST',
    headers: {
      Cookie: signedIn.cookie,
      Origin: context.baseUrl,
      'X-CSRF-Token': signedIn.body.csrfToken,
      'Content-Type': mimeType,
      'X-File-Name': encodeURIComponent(fileName),
    },
    body: buffer,
  });
  return { response, body: await response.json() };
}

async function postJson(context, signedIn, pathname, body) {
  const response = await fetch(`${context.baseUrl}${pathname}`, {
    method: 'POST',
    headers: { Cookie: signedIn.cookie, Origin: context.baseUrl, 'X-CSRF-Token': signedIn.body.csrfToken, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { response, body: await response.json() };
}

async function parseMultipart(request) {
  return new Response(request.rawBody, { headers: { 'Content-Type': request.contentType } }).formData();
}

test('packaged workflow uses the selected Gemini Flash image model and saves the result', async () => {
  const context = await fixture();
  try {
    const signedIn = await authenticated(context);
    const listed = await fetch(`${context.baseUrl}/api/workflows`, { headers: { Cookie: signedIn.cookie } });
    const workflows = await listed.json();
    assert.equal(listed.status, 200);
    assert.equal(workflows.workflows.some((workflow) => workflow.id === 'image-prompt-architect'), true);

    const result = await postJson(context, signedIn, '/api/workflows/run', {
      workflowId: 'image-prompt-architect',
      prompt: '一只站在暖色窗边的橘猫，电影感光线',
      imageModel: 'gemini-3.1-flash-image',
      size: '1024x1024',
      quality: 'high',
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.body.images.length, 1);
    assert.match(result.body.images[0].url, /^\/api\/media\/[A-Za-z0-9_-]{32}$/);
    const chatRequest = context.fake.requests.find((request) => request.url === '/v1/chat/completions');
    const imageRequest = context.fake.requests.find((request) => request.url === '/v1/images/generations');
    assert.equal(JSON.parse(chatRequest.bodyText).model, 'claude-sonnet-4-5');
    assert.equal(JSON.parse(chatRequest.bodyText).messages[0].role, 'system');
    assert.equal(JSON.parse(chatRequest.bodyText).messages[0].content, WORKFLOW_ROLES.folders[0].roles[0].systemPrompt);
    assert.equal(JSON.parse(imageRequest.bodyText).model, 'gemini-3.1-flash-image');
    assert.equal(JSON.parse(imageRequest.bodyText).prompt, '你好，图片如下：');
    assert.notEqual(JSON.parse(imageRequest.bodyText).prompt, '一只站在暖色窗边的橘猫，电影感光线');
    const quota = await fetch(`${context.baseUrl}/api/quota`, { headers: { Cookie: signedIn.cookie } });
    const quotaBody = await quota.json();
    assert.equal(quotaBody.chatCalls, 1);
    assert.equal(quotaBody.imageCalls, 1);
    assert.equal(quotaBody.usagePoints, 2);
  } finally {
    await context.close();
  }
});

test('packaged workflow delegates gpt-image-2 generation to the shared image client', async () => {
  const context = await fixture();
  try {
    const signedIn = await authenticated(context);
    const result = await postJson(context, signedIn, '/api/workflows/run', {
      workflowId: 'image-prompt-architect',
      prompt: '冰雪女皇的电影级角色设定图',
      imageModel: 'gpt-image-2',
      size: '1792x1024',
      quality: 'high',
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.body.images.length, 1);
    const imageRequest = context.fake.requests.find((request) => request.url === '/v1/responses');
    const body = JSON.parse(imageRequest.bodyText);
    assert.equal(body.model, 'gpt-5.4-mini');
    assert.equal(body.tools[0].model, 'gpt-image-2');
    assert.equal(body.tool_choice, 'required');
    assert.equal(body.input[0].content[0].text, '你好，图片如下：');
    assert.notEqual(body.input[0].content[0].text, '冰雪女皇的电影级角色设定图');
  } finally {
    await context.close();
  }
});

test('administrator-defined workflow nodes persist privately and run role plus temporary prompt stages in order', async () => {
  const context = await fixture();
  try {
    const signedIn = await authenticated(context);
    const definition = {
      version: 1,
      workflows: [{
        id: 'temporary-chain', name: '临时节点链路', description: '管理员自定义的多节点生图流程', enabled: true,
        nodes: [
          { id: 'brief', type: 'temporary', model: 'chat-test', inputFrom: 'user', inputTemplate: '整理需求：{{input}}', systemPrompt: '把用户需求改写为简短创作简报。', output: { mode: 'full' } },
          { id: 'architect', type: 'role', roleId: 'role-mrsmkx9c-2293', model: 'claude-sonnet-4-5', inputFrom: 'brief', inputTemplate: '依据简报生成完整绘图提示词：{{input}}', output: { mode: 'full' } },
          { id: 'image', type: 'image', model: 'gemini-3.1-flash-image', promptFrom: 'architect', output: { mode: 'between', startMarker: '[[绘图提示词]]', endMarker: '[[结束]]' }, size: '1024x1024', quality: 'high', allowUserModelOverride: false, allowUserSizeOverride: false, allowUserQualityOverride: false },
        ],
      }],
    };
    const saved = await fetch(`${context.baseUrl}/api/admin/workflows`, {
      method: 'PUT',
      headers: { Cookie: signedIn.cookie, Origin: context.baseUrl, 'X-CSRF-Token': signedIn.body.csrfToken, 'Content-Type': 'application/json' },
      body: JSON.stringify(definition),
    });
    assert.equal(saved.status, 200, await saved.text());
    const internal = await fetch(`${context.baseUrl}/api/admin/workflows`, { headers: { Cookie: signedIn.cookie } });
    const internalBody = await internal.json();
    assert.equal(internalBody.workflows[0].nodes[0].systemPrompt, '把用户需求改写为简短创作简报。');
    const listed = await fetch(`${context.baseUrl}/api/workflows`, { headers: { Cookie: signedIn.cookie } });
    const publicBody = await listed.json();
    assert.equal(publicBody.workflows.length, 1);
    assert.equal(publicBody.workflows[0].nodes, undefined);
    assert.equal(publicBody.workflows[0].imageModel, 'gemini-3.1-flash-image');

    const result = await postJson(context, signedIn, '/api/workflows/run', {
      workflowId: 'temporary-chain', prompt: '极地探险家少女', imageModel: 'gpt-image-2', size: '1792x1024', quality: 'low',
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.body.images.length, 1);
    const chats = context.fake.requests.filter((request) => request.url === '/v1/chat/completions').map((request) => JSON.parse(request.bodyText));
    assert.equal(chats.length, 2);
    assert.equal(chats[0].model, 'chat-test');
    assert.equal(chats[0].messages[0].content, '把用户需求改写为简短创作简报。');
    assert.equal(chats[0].messages[1].content, '整理需求：极地探险家少女');
    assert.equal(chats[1].model, 'claude-sonnet-4-5');
    assert.equal(chats[1].messages[0].content, WORKFLOW_ROLES.folders[0].roles[0].systemPrompt);
    assert.equal(chats[1].messages[1].content, '依据简报生成完整绘图提示词：你好，图片如下：');
    const imageRequest = context.fake.requests.find((request) => request.url === '/v1/images/generations');
    assert.equal(JSON.parse(imageRequest.bodyText).model, 'gemini-3.1-flash-image');
    assert.equal(JSON.parse(imageRequest.bodyText).prompt, '你好，图片如下：'); // Missing markers fall back to the model response, never the user input.
  } finally {
    await context.close();
  }
});

test('node-graph workflows merge multiple upstream outputs before the next role and final image', async () => {
  const context = await fixture();
  try {
    const signedIn = await authenticated(context);
    const definition = {
      version: 2,
      workflows: [{
        id: 'diamond-graph', name: '菱形节点图', description: '并行整理后合并为专业绘图提示词', enabled: true,
        nodes: [
          { id: 'brief', type: 'temporary', model: 'chat-test', systemPrompt: '整理主体。', inputTemplate: '主体：{{input}}', inputMerge: 'plain', output: { mode: 'full' }, position: { x: 140, y: 120 } },
          { id: 'style', type: 'temporary', model: 'chat-test', systemPrompt: '整理风格。', inputTemplate: '风格：{{input}}', inputMerge: 'plain', output: { mode: 'full' }, position: { x: 140, y: 420 } },
          { id: 'merge', type: 'merge', mergeMode: 'template', separator: '\n\n', template: '主体设定：{{brief}}\n风格设定：{{style}}', position: { x: 500, y: 260 } },
          { id: 'architect', type: 'role', roleId: 'role-mrsmkx9c-2293', model: 'claude-sonnet-4-5', inputTemplate: '综合为最终绘图提示词：{{input}}', inputMerge: 'plain', output: { mode: 'full' }, position: { x: 820, y: 260 } },
          { id: 'image', type: 'image', model: 'gemini-3.1-flash-image', output: { mode: 'full' }, size: '1024x1024', quality: 'high', allowUserModelOverride: false, allowUserSizeOverride: false, allowUserQualityOverride: false, position: { x: 1_180, y: 260 } },
        ],
        edges: [
          { id: 'user-brief', from: 'user', to: 'brief', inputKey: 'user', order: 0 },
          { id: 'user-style', from: 'user', to: 'style', inputKey: 'user', order: 0 },
          { id: 'brief-merge', from: 'brief', to: 'merge', inputKey: 'brief', order: 0 },
          { id: 'style-merge', from: 'style', to: 'merge', inputKey: 'style', order: 1 },
          { id: 'merge-architect', from: 'merge', to: 'architect', inputKey: 'merged', order: 0 },
          { id: 'architect-image', from: 'architect', to: 'image', inputKey: 'prompt', order: 0 },
        ],
      }],
    };
    const saved = await fetch(`${context.baseUrl}/api/admin/workflows`, {
      method: 'PUT',
      headers: { Cookie: signedIn.cookie, Origin: context.baseUrl, 'X-CSRF-Token': signedIn.body.csrfToken, 'Content-Type': 'application/json' },
      body: JSON.stringify(definition),
    });
    assert.equal(saved.status, 200, await saved.text());
    const privateDefinition = await (await fetch(`${context.baseUrl}/api/admin/workflows`, { headers: { Cookie: signedIn.cookie } })).json();
    assert.equal(privateDefinition.version, 2);
    assert.equal(privateDefinition.workflows[0].edges.length, 6);
    const publicDefinition = await (await fetch(`${context.baseUrl}/api/workflows`, { headers: { Cookie: signedIn.cookie } })).json();
    assert.equal(publicDefinition.workflows[0].edges, undefined);

    const result = await postJson(context, signedIn, '/api/workflows/run', { workflowId: 'diamond-graph', prompt: '冰原女探险家', imageModel: 'gpt-image-2', size: '1792x1024', quality: 'low' });
    assert.equal(result.response.status, 200);
    const chats = context.fake.requests.filter((request) => request.url === '/v1/chat/completions').map((request) => JSON.parse(request.bodyText));
    assert.equal(chats.length, 3);
    assert.equal(chats[0].messages[1].content, '主体：冰原女探险家');
    assert.equal(chats[1].messages[1].content, '风格：冰原女探险家');
    assert.equal(chats[2].model, 'claude-sonnet-4-5');
    assert.equal(chats[2].messages[1].content, '综合为最终绘图提示词：主体设定：你好，图片如下：\n风格设定：你好，图片如下：');
    const imageRequest = context.fake.requests.find((request) => request.url === '/v1/images/generations');
    assert.equal(JSON.parse(imageRequest.bodyText).model, 'gemini-3.1-flash-image');
    assert.equal(JSON.parse(imageRequest.bodyText).prompt, '你好，图片如下：');
  } finally {
    await context.close();
  }
});

test('packaged workflow streams an immediate keep-alive response for remote clients', async () => {
  const context = await fixture();
  try {
    const signedIn = await authenticated(context);
    const response = await fetch(`${context.baseUrl}/api/workflows/run`, {
      method: 'POST',
      headers: {
        Cookie: signedIn.cookie,
        Origin: context.baseUrl,
        'X-CSRF-Token': signedIn.body.csrfToken,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({
        workflowId: 'image-prompt-architect',
        prompt: '一位在月光下登场的冒险者角色设定图',
        imageModel: 'gemini-3.1-flash-image',
        size: '1024x1024',
        quality: 'high',
      }),
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') || '', /text\/event-stream/);
    const stream = await response.text();
    assert.match(stream, /event: meta/);
    assert.match(stream, /event: image/);
    assert.match(stream, /event: done/);
  } finally {
    await context.close();
  }
});

test('packaged workflow supports a short-lived job request with polling for long remote generations', async () => {
  const context = await fixture();
  try {
    const signedIn = await authenticated(context);
    const started = await fetch(`${context.baseUrl}/api/workflows/run`, {
      method: 'POST',
      headers: {
        Cookie: signedIn.cookie,
        Origin: context.baseUrl,
        'X-CSRF-Token': signedIn.body.csrfToken,
        'Content-Type': 'application/json',
        Prefer: 'respond-async',
      },
      body: JSON.stringify({
        workflowId: 'image-prompt-architect',
        prompt: '一位在月光下登场的冒险者角色设定图',
        imageModel: 'gemini-3.1-flash-image',
        size: '1024x1024',
        quality: 'high',
      }),
    });
    assert.equal(started.status, 202);
    const queued = await started.json();
    assert.match(queued.jobId, /^[0-9a-f-]{36}$/i);

    let job;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const response = await fetch(`${context.baseUrl}/api/workflows/jobs/${queued.jobId}`, { headers: { Cookie: signedIn.cookie } });
      assert.equal(response.status, 200);
      job = await response.json();
      if (job.status === 'completed') break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(job.status, 'completed');
    assert.equal(job.images.length, 1);
  } finally {
    await context.close();
  }
});
test('workflow prompt processing uses only the poster Chinese prompt and keeps persona prompts whole', () => {
  const fullPosterResponse = '中文版：\n```markdown\n史诗神祇海报，熔岩与雷霆，强烈电影光。\n```\n\n英文版：\n```markdown\nAn epic deity poster with lava and lightning.\n```';
  const poster = workflowImagePromptCandidates(fullPosterResponse, 'epic-poster-v3');
  assert.equal(poster.primary, '史诗神祇海报，熔岩与雷霆，强烈电影光。');
  assert.doesNotMatch(poster.primary, /epic deity/i);
  assert.equal(poster.fallback, fullPosterResponse);

  const personaResponse = '**核心生成指令：** 电影级角色设定图。\n\n**设计元素：** 冰晶、王冠、月光。';
  const persona = workflowImagePromptCandidates(personaResponse, 'image-prompt-architect');
  assert.equal(persona.primary, personaResponse);
  assert.equal(persona.fallback, '');

  assert.deepEqual(workflowImagePromptCandidates('', 'epic-poster-v3'), { primary: '', fallback: '' });
});

test('conversation titles use Gemini Flash and normalize its concise title response', async () => {
  const context = await fixture({ fakeOptions: { chatResponseText: '标题：极地探险家少女设定图' } });
  try {
    const signedIn = await authenticated(context);
    const response = await fetch(`${context.baseUrl}/api/conversations/title`, {
      method: 'POST',
      headers: { Cookie: signedIn.cookie, Origin: context.baseUrl, 'X-CSRF-Token': signedIn.body.csrfToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: '银白短发、冰晶罗盘和防寒装备的极地探险家少女' }),
    });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.title, '极地探险家少女设定图');
    assert.equal(body.model, 'gemini-3.5-flash-low-fan');
    const request = context.fake.requests.find((item) => item.url === '/v1/chat/completions');
    assert.equal(JSON.parse(request.bodyText).model, 'gemini-3.5-flash-low-fan');
  } finally {
    await context.close();
  }
});

test('poster workflow retries once with the untouched role response when the Chinese prompt request fails', async () => {
  const fullPosterResponse = '中文版：\n```markdown\n史诗神祇海报，熔岩与雷霆，强烈电影光。\n```\n\n英文版：\n```markdown\nAn epic deity poster with lava and lightning.\n```';
  const context = await fixture({ fakeOptions: { chatResponseText: fullPosterResponse, failImageGenerationAttempts: 1 } });
  try {
    const signedIn = await authenticated(context);
    const result = await postJson(context, signedIn, '/api/workflows/run', {
      workflowId: 'epic-poster-v3', prompt: '原神', imageModel: 'gemini-3.1-flash-image', size: '1024x1024', quality: 'high',
    });
    assert.equal(result.response.status, 200);
    const attempts = context.fake.requests.filter((request) => request.url === '/v1/images/generations').map((request) => JSON.parse(request.bodyText).prompt);
    assert.deepEqual(attempts, ['史诗神祇海报，熔岩与雷霆，强烈电影光。', fullPosterResponse]);
  } finally {
    await context.close();
  }
});
test('authentication uses HttpOnly Strict cookies, CSRF, and protects model listing', async () => {
  const context = await fixture();
  try {
    const anonymousModels = await fetch(`${context.baseUrl}/api/models`);
    assert.equal(anonymousModels.status, 401);
    const csp = anonymousModels.headers.get('content-security-policy');
    assert.match(csp, /object-src 'none'/);
    assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
    const initial = await session(context.baseUrl);
    const cookieHeaders = initial.response.headers.getSetCookie();
    const issued = cookieHeaders.find((value) => value.startsWith('chat_session=') && !value.startsWith('chat_session=;'));
    assert.match(issued, /HttpOnly/);
    assert.match(issued, /SameSite=Strict/);

    const missingCsrf = await fetch(`${context.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { Cookie: initial.cookie, Origin: context.baseUrl, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'test-admin', password: 'temporary-test-password' }),
    });
    assert.equal(missingCsrf.status, 403);

    const signedIn = await login(context.baseUrl, { ...initial, remember: true });
    assert.match(signedIn.response.headers.getSetCookie().find((value) => value.startsWith('chat_session=') && !value.startsWith('chat_session=;')), /Max-Age=2592000(?:;|$)/);
    assert.equal(signedIn.body.uid, '00000');
    const authenticatedSession = await session(context.baseUrl, signedIn.cookie);
    assert.equal(authenticatedSession.body.authenticated, true);
    assert.equal('newApiConfigured' in authenticatedSession.body, false);
    assert.doesNotMatch(JSON.stringify(authenticatedSession.body), /new[ -]?api|3002|3006|127\.0\.0\.1|localhost/i);
    const status = await fetch(`${context.baseUrl}/api/status`, { headers: { Cookie: signedIn.cookie } });
    const statusPayload = await status.json();
    assert.equal(statusPayload.ready, true);
    assert.equal('newApiConfigured' in statusPayload, false);
    assert.doesNotMatch(JSON.stringify(statusPayload), /new[ -]?api|3002|3006|127\.0\.0\.1|localhost/i);
    const models = await fetch(`${context.baseUrl}/api/models`, { headers: { Cookie: signedIn.cookie } });
    assert.equal(models.status, 200);
    const payload = await models.json();
    assert.equal(payload.models.some((model) => model.id === 'gpt-image-2' && model.modes[0] === 'image'), true);
    assert.equal(JSON.stringify(payload).includes('test-api-key'), false);
  } finally {
    await context.close();
  }
});

test('remembered login remains authenticated after the Light-Chat service restarts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chat-app-remember-'));
  await mkdir(join(root, 'public'), { recursive: true });
  await Promise.all([
    writeFile(join(root, 'public', 'login.html'), '<!doctype html><title>login</title>'),
    writeFile(join(root, 'public', 'app.html'), '<!doctype html><title>app</title>'),
  ]);
  const fake = await createFakeNewApi();
  let app = null;
  try {
    const options = {
      rootDir: root, apiKey: 'test-api-key', bootstrapUsername: 'test-admin',
      bootstrapPassword: 'temporary-test-password', sessionSecret: 'test-session-secret-that-is-long-enough',
      port: 0, newApiBaseUrl: fake.baseUrl,
    };
    app = await createChatApp(options);
    const firstBaseUrl = await listen(app.server);
    const initial = await session(firstBaseUrl);
    const signedIn = await login(firstBaseUrl, { ...initial, remember: true });
    assert.equal(signedIn.response.status, 200);
    await app.close(); app = null;

    app = await createChatApp(options);
    const secondBaseUrl = await listen(app.server);
    const restored = await session(secondBaseUrl, signedIn.cookie);
    assert.equal(restored.body.authenticated, true);
    assert.equal(restored.body.uid, '00000');
  } finally {
    if (app) await app.close();
    await fake.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('the application page is gated while the login page remains public', async () => {
  const context = await fixture();
  try {
    const appPage = await fetch(`${context.baseUrl}/app`, { redirect: 'manual' });
    assert.equal(appPage.status, 303);
    assert.equal(appPage.headers.get('location'), '/');
    const loginPage = await fetch(`${context.baseUrl}/`);
    assert.equal(loginPage.status, 200);
    assert.match(await loginPage.text(), /<title>login<\/title>/);
    const signedIn = await authenticated(context);
    const authenticatedApp = await fetch(`${context.baseUrl}/app`, { headers: { Cookie: signedIn.cookie } });
    assert.equal(authenticatedApp.status, 200);
    assert.match(await authenticatedApp.text(), /<title>app<\/title>/);
  } finally {
    await context.close();
  }
});

test('multimodal upload, chat image extraction, and authenticated media work end-to-end', async () => {
  const context = await fixture();
  try {
    const signedIn = await authenticated(context);
    const upload = await fetch(`${context.baseUrl}/api/uploads`, {
      method: 'POST',
      headers: {
        Cookie: signedIn.cookie,
        Origin: context.baseUrl,
        'X-CSRF-Token': signedIn.body.csrfToken,
        'Content-Type': 'image/png',
        'X-File-Name': encodeURIComponent('test.png'),
      },
      body: tinyPng(8, 8),
    });
    assert.equal(upload.status, 201);
    const attachment = (await upload.json()).attachment;

    const chat = await fetch(`${context.baseUrl}/api/chat`, {
      method: 'POST',
      headers: {
        Cookie: signedIn.cookie,
        Origin: context.baseUrl,
        'X-CSRF-Token': signedIn.body.csrfToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gemini-test-image',
        messages: [{ role: 'user', content: '看看这张图', attachmentIds: [attachment.id] }],
      }),
    });
    assert.equal(chat.status, 200);
    const events = await chat.text();
    assert.match(events, /event: delta/);
    assert.match(events, /event: image/);
    assert.match(events, /event: usage/);
    assert.doesNotMatch(events, /data:image\/png;base64/);
    const imagePayload = JSON.parse(events.match(/event: image\ndata: ([^\n]+)/)[1]);

    const anonymousMedia = await fetch(`${context.baseUrl}${imagePayload.url}`);
    assert.equal(anonymousMedia.status, 401);
    const media = await fetch(`${context.baseUrl}${imagePayload.url}`, { headers: { Cookie: signedIn.cookie } });
    assert.equal(media.status, 200);
    assert.equal(media.headers.get('content-type'), 'image/png');

    const upstreamChat = context.fake.requests.find((request) => request.url === '/v1/chat/completions');
    assert.match(upstreamChat.bodyText, /image_url/);
    assert.deepEqual(JSON.parse(upstreamChat.bodyText).stream_options, { include_usage: true });
    assert.equal(upstreamChat.authorization, 'Bearer test-api-key');
  } finally {
    await context.close();
  }
});

test('recent media lists uploaded and generated files newest first for the signed-in account', async () => {
  const context = await fixture();
  try {
    const signedIn = await authenticated(context);
    const upload = await uploadFile(context, signedIn, { buffer: tinyPng(4, 4), mimeType: 'image/png', fileName: 'reference.png' });
    assert.equal(upload.response.status, 201);
    const generated = await postJson(context, signedIn, '/api/images/generations', { model: 'gpt-image-2', prompt: 'recent output', size: '1024x1024', count: 1 });
    assert.equal(generated.response.status, 200);

    const response = await fetch(`${context.baseUrl}/api/media/recent`, { headers: { Cookie: signedIn.cookie } });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.files.length, 2);
    assert.deepEqual(payload.files.map((item) => item.kind), ['output', 'upload']);
    assert.equal(payload.files[1].fileName, 'reference.png');
    assert.ok(payload.files[0].createdAt >= payload.files[1].createdAt);
    assert.match(payload.files[0].url, /^\/api\/media\/[A-Za-z0-9_-]{32}$/);
  } finally {
    await context.close();
  }
});

test('favorite media persists per account and only returns owned authenticated files', async () => {
  const context = await fixture();
  try {
    const signedIn = await authenticated(context);
    const upload = await uploadFile(context, signedIn, { buffer: tinyPng(4, 4), mimeType: 'image/png', fileName: 'favorite-reference.png' });
    const generated = await postJson(context, signedIn, '/api/images/generations', { model: 'gpt-image-2', prompt: 'favorite output', size: '1024x1024', count: 1 });
    assert.equal(upload.response.status, 201); assert.equal(generated.response.status, 200);
    const preferences = await fetch(`${context.baseUrl}/api/preferences`, { headers: { Cookie: signedIn.cookie } }).then((response) => response.json());
    const favoriteIds = [generated.body.images[0].id, upload.body.attachment.id];
    const saved = await fetch(`${context.baseUrl}/api/preferences`, {
      method: 'PUT',
      headers: { Cookie: signedIn.cookie, Origin: context.baseUrl, 'X-CSRF-Token': signedIn.body.csrfToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ favoriteGroups: preferences.favoriteGroups, selected: preferences.selected, modelContextLimits: preferences.modelContextLimits, favoriteMediaIds: favoriteIds }),
    });
    assert.equal(saved.status, 200);
    assert.deepEqual((await saved.json()).favoriteMediaIds, favoriteIds);
    const listed = await fetch(`${context.baseUrl}/api/media/favorites`, { headers: { Cookie: signedIn.cookie } });
    assert.equal(listed.status, 200);
    const payload = await listed.json();
    assert.deepEqual(payload.files.map((item) => item.id), favoriteIds);
    assert.ok(payload.files.every((item) => /^\/api\/media\/[A-Za-z0-9_-]{32}$/.test(item.url)));
  } finally {
    await context.close();
  }
});

test('only unsent uploads occupy the eight-file pending attachment allowance', async () => {
  const context = await fixture();
  try {
    const signedIn = await authenticated(context);
    const uploads = [];
    for (let index = 0; index < 8; index += 1) {
      const upload = await uploadFile(context, signedIn, {
        buffer: tinyPng(4 + index, 4),
        mimeType: 'image/png',
        fileName: `pending-${index}.png`,
      });
      assert.equal(upload.response.status, 201);
      uploads.push(upload.body.attachment);
    }
    const blocked = await uploadFile(context, signedIn, { buffer: tinyPng(), mimeType: 'image/png', fileName: 'blocked.png' });
    assert.equal(blocked.response.status, 413);

    const chat = await postJson(context, signedIn, '/api/chat', {
      model: 'gemini-test-image',
      messages: [{ role: 'user', content: '保存这些附件', attachmentIds: uploads.map((item) => item.id) }],
      stream: false,
    });
    assert.equal(chat.response.status, 200);

    const next = await uploadFile(context, signedIn, { buffer: tinyPng(), mimeType: 'image/png', fileName: 'next.png' });
    assert.equal(next.response.status, 201);
  } finally {
    await context.close();
  }
});

test('conversation context keeps the newest images when historical uploads exceed the attachment limit', async () => {
  const context = await fixture();
  try {
    const signedIn = await authenticated(context);
    const uploads = [];
    for (let index = 0; index < 5; index += 1) {
      const upload = await uploadFile(context, signedIn, {
        buffer: tinyPng(5 + index, 5),
        mimeType: 'image/png',
        fileName: `history-${index}.png`,
      });
      assert.equal(upload.response.status, 201);
      uploads.push(upload.body.attachment);
    }
    const firstTurn = await postJson(context, signedIn, '/api/chat', {
      model: 'gemini-test-image',
      stream: false,
      messages: [{ role: 'user', content: '第一轮图片', attachmentIds: uploads.map((item) => item.id) }],
    });
    assert.equal(firstTurn.response.status, 200);
    for (let index = 5; index < 10; index += 1) {
      const upload = await uploadFile(context, signedIn, {
        buffer: tinyPng(5 + index, 5),
        mimeType: 'image/png',
        fileName: `history-${index}.png`,
      });
      assert.equal(upload.response.status, 201);
      uploads.push(upload.body.attachment);
    }
    const chat = await postJson(context, signedIn, '/api/chat', {
      model: 'gemini-test-image',
      stream: false,
      messages: [
        { role: 'user', content: '第一轮图片', attachmentIds: uploads.slice(0, 5).map((item) => item.id) },
        { role: 'assistant', content: '继续处理。' },
        { role: 'user', content: '保留最新图片', attachmentIds: uploads.slice(5).map((item) => item.id) },
      ],
    });
    assert.equal(chat.response.status, 200);
    const upstream = context.fake.requests.findLast((request) => request.url === '/v1/chat/completions');
    const messages = JSON.parse(upstream.bodyText).messages;
    const imageParts = messages.flatMap((message) => Array.isArray(message.content) ? message.content.filter((part) => part.type === 'image_url') : []);
    assert.equal(imageParts.length, 8);
    assert.equal(messages[0].content.some((part) => part.type === 'text' && part.text === '第一轮图片'), true);
    assert.equal(messages.at(-1).content.some((part) => part.type === 'text' && part.text === '保留最新图片'), true);
  } finally {
    await context.close();
  }
});

test('dedicated image generation returns only opaque authenticated URLs', async () => {
  const context = await fixture();
  try {
    const signedIn = await authenticated(context);
    const generated = await fetch(`${context.baseUrl}/api/images/generations`, {
      method: 'POST',
      headers: {
        Cookie: signedIn.cookie,
        Origin: context.baseUrl,
        'X-CSRF-Token': signedIn.body.csrfToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: 'gpt-image-2', prompt: '安静的书房', size: '1024x1024', count: 1 }),
    });
    assert.equal(generated.status, 200);
    const payload = await generated.json();
  assert.match(payload.images[0].url, /^\/api\/media\/[A-Za-z0-9_-]{32}$/);
    assert.equal(JSON.stringify(payload).includes('base64'), false);
    const upstream = context.fake.requests.find((request) => request.url === '/v1/responses');
    const body = JSON.parse(upstream.bodyText);
    assert.equal(body.tool_choice, undefined);
    assert.equal(body.tools[0].model, 'gpt-image-2');
  } finally {
    await context.close();
  }
});

test('dedicated image generation keeps the browser connection alive with SSE until the generated media is saved', async () => {
  const context = await fixture();
  try {
    const signedIn = await authenticated(context);
    const generated = await fetch(`${context.baseUrl}/api/images/generations`, {
      method: 'POST',
      headers: {
        Cookie: signedIn.cookie,
        Origin: context.baseUrl,
        'X-CSRF-Token': signedIn.body.csrfToken,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({ model: 'gpt-image-2', prompt: '保持连接直到图片准备完毕', size: '1024x1024', count: 1 }),
    });
    assert.equal(generated.status, 200);
    assert.match(generated.headers.get('content-type') || '', /text\/event-stream/);
    const stream = await generated.text();
    assert.match(stream, /event: meta/);
    assert.match(stream, /event: image/);
    assert.match(stream, /event: done/);
    assert.match(stream, /"url":"\/api\/media\/[A-Za-z0-9_-]{32}"/);
  } finally {
    await context.close();
  }
});

test('local image upscaler only accepts owned images and returns an authenticated result URL', async () => {
  const calls = [];
  const context = await fixture({ imageUpscaler: { upscale: async (buffer, options) => { calls.push(options); return buffer; } } });
  try {
    const signedIn = await authenticated(context);
    const upload = await uploadFile(context, signedIn, { buffer: tinyPng(4, 3), mimeType: 'image/png', fileName: 'source.png' });
    const result = await postJson(context, signedIn, '/api/images/upscale', { imageId: upload.body.attachment.id, width: 3840, height: 2560, mode: 'text-safe' });
    assert.equal(result.response.status, 200);
    assert.match(result.body.image.url, /^\/api\/media\/[A-Za-z0-9_-]{32}$/);
    assert.deepEqual(calls, [{ width: 3840, height: 2560, mode: 'text-safe' }]);
    const invalid = await postJson(context, signedIn, '/api/images/upscale', { imageId: upload.body.attachment.id, width: 8000, height: 2560, mode: 'detail' });
    assert.equal(invalid.response.status, 400);
  } finally { await context.close(); }
});

test('long image prompts are forwarded intact instead of being rejected by an arbitrary character limit', async () => {
  const context = await fixture();
  try {
    const signedIn = await authenticated(context);
    const prompt = `Detailed image direction:\n${'light, texture, composition, typography; '.repeat(2500)}`;
    assert.ok(prompt.length > 20_000);

    const generated = await postJson(context, signedIn, '/api/images/generations', {
      model: 'gpt-image-2', prompt, size: '1024x1024', count: 1,
    });

    assert.equal(generated.response.status, 200);
    const upstream = context.fake.requests.find((request) => request.url === '/v1/responses');
    assert.equal(JSON.parse(upstream.bodyText).input[0].content[0].text, prompt);
  } finally {
    await context.close();
  }
});

test('chat accepts a long single message within the model token limit and rejects only the configured context overflow', async () => {
  const context = await fixture();
  try {
    const signedIn = await authenticated(context);
    const longButValid = 'abcd'.repeat(20_000);
    const accepted = await fetch(`${context.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { Cookie: signedIn.cookie, Origin: context.baseUrl, 'X-CSRF-Token': signedIn.body.csrfToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'chat-test', stream: false, messages: [{ role: 'user', content: longButValid }] }),
    });
    assert.equal(accepted.status, 200);
    await accepted.json();
    const forwarded = context.fake.requests.findLast((request) => request.url === '/v1/chat/completions');
    assert.equal(JSON.parse(forwarded.bodyText).messages[0].content, longButValid);

    const upstreamCount = context.fake.requests.length;
    const overflow = await fetch(`${context.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { Cookie: signedIn.cookie, Origin: context.baseUrl, 'X-CSRF-Token': signedIn.body.csrfToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'chat-test', stream: false, messages: [{ role: 'user', content: '界'.repeat(262_145) }] }),
    });
    assert.equal(overflow.status, 400);
    const failure = await overflow.json();
    assert.equal(failure.code, 'CONTEXT_LIMIT_EXCEEDED');
    assert.match(failure.error, /262145\/262144 token/);
    assert.equal(context.fake.requests.length, upstreamCount);
  } finally {
    await context.close();
  }
});

test('chat trims the oldest complete history when accumulated context exceeds the configured model limit', async () => {
  const context = await fixture();
  try {
    const signedIn = await authenticated(context);
    const saved = await fetch(`${context.baseUrl}/api/preferences`, {
      method: 'PUT',
      headers: { Cookie: signedIn.cookie, Origin: context.baseUrl, 'X-CSRF-Token': signedIn.body.csrfToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        favoriteGroups: [{ id: 'chat', name: '对话', items: [{ modelId: 'chat-test', model: 'chat-test', mode: 'chat', label: 'chat-test' }] }],
        selected: { modelId: 'chat-test', model: 'chat-test', mode: 'chat' },
        modelContextLimits: { 'chat-test': 1024 },
      }),
    });
    assert.equal(saved.status, 200);

    const recentUser = 'c'.repeat(800);
    const recentAssistant = 'd'.repeat(800);
    const latestUser = '保留最新问题';
    const response = await fetch(`${context.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { Cookie: signedIn.cookie, Origin: context.baseUrl, 'X-CSRF-Token': signedIn.body.csrfToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'chat-test', stream: false,
        messages: [
          { role: 'user', content: 'a'.repeat(2400) },
          { role: 'assistant', content: 'b'.repeat(2400) },
          { role: 'user', content: recentUser },
          { role: 'assistant', content: recentAssistant },
          { role: 'user', content: latestUser },
        ],
      }),
    });
    assert.equal(response.status, 200);
    await response.json();
    const forwarded = context.fake.requests.findLast((request) => request.url === '/v1/chat/completions');
    assert.deepEqual(JSON.parse(forwarded.bodyText).messages, [
      { role: 'user', content: recentUser },
      { role: 'assistant', content: recentAssistant },
      { role: 'user', content: latestUser },
    ]);
  } finally {
    await context.close();
  }
});

test('empty image prompts return a specific validation error before reaching the upstream service', async () => {
  const context = await fixture();
  try {
    const signedIn = await authenticated(context);
    const before = context.fake.requests.length;
    const result = await postJson(context, signedIn, '/api/images/generations', {
      model: 'gpt-image-2', prompt: '   ', size: '1024x1024', count: 1,
    });

    assert.equal(result.response.status, 400);
    assert.deepEqual(result.body, { error: '请输入生图提示词', code: 'INVALID_PROMPT' });
    assert.equal(context.fake.requests.length, before);
  } finally {
    await context.close();
  }
});

test('image prompt validation follows the saved per-model context limit', async () => {
  const context = await fixture();
  try {
    const signedIn = await authenticated(context);
    const models = await fetch(`${context.baseUrl}/api/models`, { headers: { Cookie: signedIn.cookie } }).then((response) => response.json());
    const favorite = models.models.find((model) => model.id === 'gpt-image-2');
    assert.ok(favorite);
    const saved = await fetch(`${context.baseUrl}/api/preferences`, {
      method: 'PUT',
      headers: { Cookie: signedIn.cookie, Origin: context.baseUrl, 'X-CSRF-Token': signedIn.body.csrfToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        favoriteGroups: [{ id: 'images', name: '生图', items: [{ modelId: favorite.id, model: favorite.id, mode: 'image', label: favorite.id }] }],
        selected: { modelId: favorite.id, model: favorite.id, mode: 'image' },
        modelContextLimits: { [favorite.id]: 1024 },
      }),
    });
    assert.equal(saved.status, 200);

    const withinEnglishBudget = await postJson(context, signedIn, '/api/images/generations', {
      model: favorite.id, prompt: 'a'.repeat(4096), size: '1024x1024', count: 1,
    });
    assert.equal(withinEnglishBudget.response.status, 200);

    const beforeInvalid = context.fake.requests.filter((request) => request.url === '/v1/images/generations').length;
    for (const [prompt, expectedEstimate] of [['a'.repeat(4100), 1025], ['图'.repeat(1025), 1025]]) {
      const result = await postJson(context, signedIn, '/api/images/generations', {
        model: favorite.id, prompt, size: '1024x1024', count: 1,
      });
      assert.equal(result.response.status, 400);
      assert.equal(result.body.code, 'CONTEXT_LIMIT_EXCEEDED');
      assert.match(result.body.error, new RegExp(`${expectedEstimate}/1024 token`));
    }
    assert.equal(context.fake.requests.filter((request) => request.url === '/v1/images/generations').length, beforeInvalid);
  } finally {
    await context.close();
  }
});

test('gpt-image-2 edits forward current uploads and historical output images through Responses', async () => {
  const context = await fixture();
  try {
    const signedIn = await authenticated(context);
    const upload = await uploadFile(context, signedIn, { buffer: tinyPng(8, 6), mimeType: 'image/png', fileName: 'reference.png' });
    assert.equal(upload.response.status, 201);
    const generated = await postJson(context, signedIn, '/api/images/generations', { model: 'gpt-image-2', prompt: '原始构图', size: '1024x1024', count: 1 });
    assert.equal(generated.response.status, 200);

    const prompt = '  保持构图，把主体改成蓝色  ';
    const edited = await postJson(context, signedIn, '/api/images/edits', {
      model: 'gpt-image-2', prompt, imageIds: [upload.body.attachment.id, generated.body.images[0].id], size: '1536x1024', quality: 'high', count: 1,
    });
    assert.equal(edited.response.status, 200);
    assert.match(edited.body.images[0].url, /^\/api\/media\/[A-Za-z0-9_-]{32}$/);
    assert.equal(JSON.stringify(edited.body).includes('base64'), false);

    const upstream = context.fake.requests.findLast((request) => request.url === '/v1/responses');
    const body = JSON.parse(upstream.bodyText);
    assert.equal(body.tool_choice, undefined);
    assert.equal(body.tools[0].action, 'edit');
    assert.equal(body.input[0].content.length, 3);
    assert.equal(body.input[0].content[0].text, prompt);

    const anonymous = await fetch(`${context.baseUrl}${edited.body.images[0].url}`);
    assert.equal(anonymous.status, 401);
    const media = await fetch(`${context.baseUrl}${edited.body.images[0].url}`, { headers: { Cookie: signedIn.cookie } });
    assert.equal(media.status, 200);
    assert.equal(media.headers.get('content-type'), 'image/png');
  } finally {
    await context.close();
  }
});

test('gpt-image-2 accepts a first-turn text prompt with multiple uploaded reference images', async () => {
  const context = await fixture();
  try {
    const signedIn = await authenticated(context);
    const first = await uploadFile(context, signedIn, { buffer: tinyPng(12, 8), mimeType: 'image/png', fileName: 'subject.png' });
    const second = await uploadFile(context, signedIn, { buffer: tinyJpeg(10, 10), mimeType: 'image/jpeg', fileName: 'style.jpg' });
    assert.equal(first.response.status, 201);
    assert.equal(second.response.status, 201);

    const prompt = '保留第一张图的主体，采用第二张图的配色和光影。';
    const edited = await postJson(context, signedIn, '/api/images/edits', {
      model: 'gpt-image-2', prompt, imageIds: [first.body.attachment.id, second.body.attachment.id], size: '1024x1024', quality: 'high', count: 1,
    });
    assert.equal(edited.response.status, 200);
    assert.equal(edited.body.images.length, 1);

    const upstream = context.fake.requests.findLast((request) => request.url === '/v1/responses');
    const body = JSON.parse(upstream.bodyText);
    assert.equal(body.tools[0].model, 'gpt-image-2');
    assert.equal(body.tools[0].action, 'edit');
    assert.equal(body.input[0].content.length, 3);
    assert.equal(body.input[0].content[0].text, prompt);
  } finally {
    await context.close();
  }
});

test('image edits reject missing, unsupported, non-image, foreign, and invalid-mask references before upstream', async () => {
  const context = await fixture();
  try {
    const signedIn = await authenticated(context);
    const valid = await uploadFile(context, signedIn, { buffer: tinyPng(), mimeType: 'image/png', fileName: 'valid.png' });
    const jpeg = await uploadFile(context, signedIn, { buffer: tinyJpeg(), mimeType: 'image/jpeg', fileName: 'mask.jpg' });
    const pdf = await uploadFile(context, signedIn, { buffer: Buffer.from('%PDF-1.4\n%%EOF\n'), mimeType: 'application/pdf', fileName: 'notes.pdf' });
    const foreign = await context.app.stores.mediaStore.save(tinyPng(), { sessionId: '0000000', kind: 'output' });
    assert.equal(valid.response.status, 201); assert.equal(jpeg.response.status, 201); assert.equal(pdf.response.status, 201);

    const cases = [
      { body: { model: 'gpt-image-2', prompt: 'edit', imageIds: [] }, status: 400 },
      { body: { model: 'gemini-3.1-flash-image', prompt: 'edit', imageIds: [valid.body.attachment.id] }, status: 400 },
      { body: { model: 'gpt-image-2', prompt: 'edit', imageIds: [pdf.body.attachment.id] }, status: 400 },
      { body: { model: 'gpt-image-2', prompt: 'edit', imageIds: [foreign.id] }, status: 404 },
      { body: { model: 'gpt-image-2', prompt: 'edit', imageIds: [valid.body.attachment.id], maskId: jpeg.body.attachment.id }, status: 400 },
    ];
    for (const entry of cases) {
      const result = await postJson(context, signedIn, '/api/images/edits', entry.body);
      assert.equal(result.response.status, entry.status);
    }
    assert.equal(context.fake.requests.filter((request) => request.url === '/v1/images/edits').length, 0);
  } finally {
    await context.close();
  }
});

test('Gemini Flash image generation uses model defaults and preserves the prompt', async () => {
  const context = await fixture();
  try {
    const signedIn = await authenticated(context);
    const prompt = '  暖色闪电图标  ';
    const generated = await fetch(`${context.baseUrl}/api/images/generations`, {
      method: 'POST',
      headers: {
        Cookie: signedIn.cookie,
        Origin: context.baseUrl,
        'X-CSRF-Token': signedIn.body.csrfToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: 'gemini-3.1-flash-image', prompt }),
    });
    assert.equal(generated.status, 200);
    await generated.json();
    const upstream = context.fake.requests.find((request) => request.url === '/v1/images/generations');
    assert.deepEqual(JSON.parse(upstream.bodyText), {
      model: 'gemini-3.1-flash-image', prompt, n: 1, size: '16:9', quality: 'high', response_format: 'b64_json',
    });
    const quota = await fetch(`${context.baseUrl}/api/quota`, { headers: { Cookie: signedIn.cookie } });
    assert.equal((await quota.json()).usagePoints, 1);

    const firstReference = await uploadFile(context, signedIn, { buffer: tinyPng(9, 7), mimeType: 'image/png', fileName: 'first.png' });
    const secondReference = await uploadFile(context, signedIn, { buffer: tinyJpeg(8, 8), mimeType: 'image/jpeg', fileName: 'second.jpg' });
    const continued = await fetch(`${context.baseUrl}/api/chat`, {
      method: 'POST',
      headers: {
        Cookie: signedIn.cookie,
        Origin: context.baseUrl,
        'X-CSRF-Token': signedIn.body.csrfToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gemini-3.1-flash-image',
        stream: false,
        imageSize: '1536x1152',
        messages: [{ role: 'user', content: '融合两张参考图生成新图片', attachmentIds: [firstReference.body.attachment.id, secondReference.body.attachment.id] }],
      }),
    });
    assert.equal(continued.status, 200);
    const continuedUpstream = context.fake.requests.findLast((request) => request.url === '/v1/chat/completions');
    assert.deepEqual(JSON.parse(continuedUpstream.bodyText).extra_body, { google: { image_config: { aspect_ratio: '4:3' } } });
    const continuedPayload = await continued.json();
    assert.equal(continuedPayload.images.length, 1);
    const continuedMessages = JSON.parse(continuedUpstream.bodyText).messages;
    assert.equal(continuedMessages.length, 1);
    const imageParts = continuedMessages[0].content.filter((part) => part.type === 'image_url');
    assert.equal(imageParts.length, 2);
    assert.equal(imageParts.every((part) => Object.keys(part.image_url).length === 1 && typeof part.image_url.url === 'string'), true);
    assert.equal(continuedMessages[0].content.some((part) => part.type === 'text' && part.text === '融合两张参考图生成新图片'), true);

    const beforeInvalid = context.fake.requests.length;
    const invalid = await fetch(`${context.baseUrl}/api/images/generations`, {
      method: 'POST',
      headers: {
        Cookie: signedIn.cookie,
        Origin: context.baseUrl,
        'X-CSRF-Token': signedIn.body.csrfToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: 'gemini-3.1-flash-image', prompt: 'x', size: '1024x1536', quality: 'low' }),
    });
    assert.equal(invalid.status, 400);
    assert.equal(context.fake.requests.length, beforeInvalid);
  } finally {
    await context.close();
  }
});

test('Gemini Flash maps every supported portrait image size to the intended aspect ratio', async () => {
  const context = await fixture();
  try {
    const signedIn = await authenticated(context);
    const expectedRatios = { '1152x1536': '3:4', '1024x1536': '2:3', '1024x1792': '9:16' };
    for (const [size, aspectRatio] of Object.entries(expectedRatios)) {
      const generated = await postJson(context, signedIn, '/api/images/generations', {
        model: 'gemini-3.1-flash-image', prompt: `竖图 ${size}`, size, quality: 'high', count: 1,
      });
      assert.equal(generated.response.status, 200);
      const upstream = context.fake.requests.findLast((request) => request.url === '/v1/images/generations');
      assert.equal(JSON.parse(upstream.bodyText).size, aspectRatio);
    }
  } finally {
    await context.close();
  }
});

test('gpt-image-2 forwards the configured portrait size choices unchanged', async () => {
  const context = await fixture();
  try {
    const signedIn = await authenticated(context);
    for (const size of ['1152x1536', '1024x1536', '1024x1792']) {
      const generated = await postJson(context, signedIn, '/api/images/generations', {
        model: 'gpt-image-2', prompt: `竖图 ${size}`, size, quality: 'low', count: 1,
      });
      assert.equal(generated.response.status, 200);
      const upstream = context.fake.requests.findLast((request) => request.url === '/v1/responses');
      assert.equal(JSON.parse(upstream.bodyText).tools[0].size, size);
    }
  } finally {
    await context.close();
  }
});

test('PDF documents are converted locally to ordered text before the non-streaming upstream request', async () => {
  const context = await fixture();
  try {
    const signedIn = await authenticated(context);
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n');
    const upload = await fetch(`${context.baseUrl}/api/uploads`, {
      method: 'POST',
      headers: {
        Cookie: signedIn.cookie,
        Origin: context.baseUrl,
        'X-CSRF-Token': signedIn.body.csrfToken,
        'Content-Type': 'application/pdf',
        'X-File-Name': encodeURIComponent('brief.pdf'),
      },
      body: pdf,
    });
    assert.equal(upload.status, 201);
    const attachment = (await upload.json()).attachment;
    assert.equal(attachment.isImage, false);
    assert.equal(attachment.fileName, 'brief.pdf');

    const chat = await fetch(`${context.baseUrl}/api/chat`, {
      method: 'POST',
      headers: {
        Cookie: signedIn.cookie,
        Origin: context.baseUrl,
        'X-CSRF-Token': signedIn.body.csrfToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'chat-test',
        stream: false,
        messages: [{ role: 'user', content: '概括附件', attachmentIds: [attachment.id] }],
      }),
    });
    assert.equal(chat.status, 200);
    assert.match(chat.headers.get('content-type'), /application\/json/);
    const payload = await chat.json();
    assert.match(payload.text, /你好/);
    assert.equal(payload.stream, false);
    assert.deepEqual(payload.usage, { promptTokens: 1234, completionTokens: 56, totalTokens: 1290 });

    const upstream = context.fake.requests.findLast((request) => request.url === '/v1/chat/completions');
    assert.match(upstream.bodyText, /"stream":false/);
    assert.match(upstream.bodyText, /PDF attachment converted locally: brief\.pdf/);
    assert.match(upstream.bodyText, /Left column first/);
    assert.match(upstream.bodyText, /Right column second/);
    assert.doesNotMatch(upstream.bodyText, /"type":"file"|data:application\/pdf;base64/);
  } finally {
    await context.close();
  }
});

test('favorite model groups persist validated modes and stale models are rejected', async () => {
  const context = await fixture();
  try {
    const signedIn = await authenticated(context);
    const saved = await fetch(`${context.baseUrl}/api/settings`, {
      method: 'PUT',
      headers: {
        Cookie: signedIn.cookie,
        Origin: context.baseUrl,
        'X-CSRF-Token': signedIn.body.csrfToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        favoriteGroups: [{
          id: 'daily-models',
          name: '常用模型',
          items: [
            { model: 'chat-test', mode: 'chat', label: '文字助手' },
            { model: 'gpt-image-2', mode: 'image', label: '生图' },
          ],
        }],
        selected: { model: 'chat-test', mode: 'chat' },
        modelContextLimits: { 'chat-test': 131072 },
      }),
    });
    assert.equal(saved.status, 200);
    const payload = await saved.json();
    assert.equal(payload.favoriteGroups[0].items.length, 2);

    const loaded = await fetch(`${context.baseUrl}/api/settings`, { headers: { Cookie: signedIn.cookie } });
    const loadedPayload = await loaded.json();
    assert.deepEqual(loadedPayload.favoriteGroups, payload.favoriteGroups);
    assert.deepEqual(loadedPayload.modelContextLimits, { 'chat-test': 131072 });
    assert.equal(loadedPayload.defaultContextTokens, 262144);

    const stale = await fetch(`${context.baseUrl}/api/chat`, {
      method: 'POST',
      headers: {
        Cookie: signedIn.cookie,
        Origin: context.baseUrl,
        'X-CSRF-Token': signedIn.body.csrfToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: 'not-in-allowlist', messages: [{ role: 'user', content: 'hello' }] }),
    });
    assert.equal(stale.status, 400);
    assert.equal(context.fake.requests.some((request) => request.url === '/v1/chat/completions'), false);
  } finally {
    await context.close();
  }
});

test('role folders persist order and inject only server-stored system prompts', async () => {
  const context = await fixture();
  try {
    const signedIn = await authenticated(context);
    const library = {
      version: 1,
      folders: [
        ...WORKFLOW_ROLES.folders,
        { id: 'writing', name: '写作', roles: [{ id: 'editor-role', name: '编辑专家', description: '精炼表达', systemPrompt: '你是编辑专家。\n保持准确。' }] },
        { id: 'coding', name: '编程', roles: [{ id: 'review-role', name: '审查专家', description: '', systemPrompt: '只审查代码，不执行代码。' }] },
      ],
    };
    const saved = await fetch(`${context.baseUrl}/api/roles`, {
      method: 'PUT',
      headers: {
        Cookie: signedIn.cookie,
        Origin: context.baseUrl,
        'X-CSRF-Token': signedIn.body.csrfToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(library),
    });
    assert.equal(saved.status, 200);
    assert.deepEqual(await saved.json(), library);
    const loaded = await fetch(`${context.baseUrl}/api/roles`, { headers: { Cookie: signedIn.cookie } });
    assert.deepEqual(await loaded.json(), library);

    const chat = await fetch(`${context.baseUrl}/api/chat`, {
      method: 'POST',
      headers: {
        Cookie: signedIn.cookie,
        Origin: context.baseUrl,
        'X-CSRF-Token': signedIn.body.csrfToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: 'chat-test', roleId: 'editor-role', stream: false, messages: [{ role: 'user', content: '修改这句话' }] }),
    });
    assert.equal(chat.status, 200);
    const upstream = context.fake.requests.findLast((request) => request.url === '/v1/chat/completions');
    const messages = JSON.parse(upstream.bodyText).messages;
    assert.deepEqual(messages[0], { role: 'system', content: '你是编辑专家。\n保持准确。' });
    assert.deepEqual(messages.at(-1), { role: 'user', content: '修改这句话' });

    const beforeUnknown = context.fake.requests.filter((request) => request.url === '/v1/chat/completions').length;
    const unknown = await fetch(`${context.baseUrl}/api/chat`, {
      method: 'POST',
      headers: {
        Cookie: signedIn.cookie,
        Origin: context.baseUrl,
        'X-CSRF-Token': signedIn.body.csrfToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: 'chat-test', roleId: 'missing-role', messages: [{ role: 'user', content: 'hello' }] }),
    });
    assert.equal(unknown.status, 400);
    assert.equal(context.fake.requests.filter((request) => request.url === '/v1/chat/completions').length, beforeUnknown);
  } finally {
    await context.close();
  }
});

test('changing password requires the original password and revokes the old session', async () => {
  const context = await fixture();
  try {
    const signedIn = await authenticated(context);
    const rejected = await fetch(`${context.baseUrl}/api/account`, {
      method: 'PUT',
      headers: {
        Cookie: signedIn.cookie,
        Origin: context.baseUrl,
        'X-CSRF-Token': signedIn.body.csrfToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ username: 'test-admin', currentPassword: 'wrong-password', newPassword: 'replacement-test-password' }),
    });
    assert.equal(rejected.status, 401);

    const changed = await fetch(`${context.baseUrl}/api/account`, {
      method: 'PUT',
      headers: {
        Cookie: signedIn.cookie,
        Origin: context.baseUrl,
        'X-CSRF-Token': signedIn.body.csrfToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ username: 'test-admin', currentPassword: 'temporary-test-password', newPassword: 'replacement-test-password' }),
    });
    assert.equal(changed.status, 200);
    const rotatedCookie = cookieFrom(changed);
    const oldStatus = await fetch(`${context.baseUrl}/api/status`, { headers: { Cookie: signedIn.cookie } });
    assert.equal(oldStatus.status, 401);
    const newStatus = await fetch(`${context.baseUrl}/api/status`, { headers: { Cookie: rotatedCookie } });
    assert.equal(newStatus.status, 200);
  } finally {
    await context.close();
  }
});
