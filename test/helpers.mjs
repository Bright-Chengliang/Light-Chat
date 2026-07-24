import { createServer } from 'node:http';
import { once } from 'node:events';

export function tinyPng(width = 1, height = 1) {
  const buffer = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write('IHDR', 12, 'ascii');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  buffer[24] = 8;
  buffer[25] = 6;
  return buffer;
}

export function tinyJpeg(width = 1, height = 1) {
  return Buffer.from([
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x04, 0x00, 0x00,
    0xff, 0xc0, 0x00, 0x11, 0x08,
    (height >>> 8) & 0xff, height & 0xff,
    (width >>> 8) & 0xff, width & 0xff,
    0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00,
    0xff, 0xd9,
  ]);
}

export async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

export async function createFakeNewApi({ imageUrlOnly = false, imageMime = 'png', responseText = '', chatResponseText = '', failImageGenerationAttempts = 0 } = {}) {
  const pngBase64 = tinyPng().toString('base64');
  const generatedBase64 = (imageMime === 'jpeg' ? tinyJpeg() : tinyPng()).toString('base64');
  const requests = [];
  let remainingImageGenerationFailures = failImageGenerationAttempts;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const rawBody = Buffer.concat(chunks);
    const bodyText = rawBody.toString('utf8');
    requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization, contentType: req.headers['content-type'] || '', headers: { ...req.headers }, rawBody, bodyText });
    if (req.headers.authorization !== 'Bearer test-api-key') {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'unauthorized' } }));
      return;
    }
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'chat-test' }, { id: 'claude-sonnet-4-5' }, { id: 'gemini-3.5-flash-low-fan' }, { id: 'gpt-image-2' }, { id: 'gemini-test-image' }, { id: 'gemini-3.1-flash-image' }] }));
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const chunks = chatResponseText ? [chatResponseText] : ['你好，图片如下：', `![image](data:image/png;base64,${pngBase64})`];
      for (const content of chunks) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 1234, completion_tokens: 56, total_tokens: 1290 } })}\n\n`);
      res.end('data: [DONE]\n\n');
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/responses') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ output: responseText ? [{ type: 'message', content: [{ type: 'output_text', text: responseText }] }] : imageUrlOnly ? [{ type: 'image_generation_call', url: 'http://127.0.0.1/private.png' }] : [{ type: 'image_generation_call', result: generatedBase64 }] }));
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/images/generations' && remainingImageGenerationFailures > 0) {
      remainingImageGenerationFailures -= 1;
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'forced image generation failure' } }));
      return;
    }
    if (req.method === 'POST' && ['/v1/images/generations', '/v1/images/edits'].includes(req.url)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: imageUrlOnly ? [{ url: 'http://127.0.0.1/private.png' }] : [{ b64_json: generatedBase64 }] }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const baseUrl = await listen(server);
  return {
    server,
    baseUrl: `${baseUrl}/v1`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

export function cookieFrom(response, name = 'chat_session') {
  const values = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie') || ''];
  const target = values.findLast((value) => value.startsWith(`${name}=`) && !value.startsWith(`${name}=;`));
  if (!target) throw new Error(`missing ${name} cookie`);
  return target.split(';', 1)[0];
}

export async function session(baseUrl, cookie) {
  const response = await fetch(`${baseUrl}/api/session`, {
    headers: cookie ? { Cookie: cookie } : {},
  });
  return { response, body: await response.json(), cookie: cookie || cookieFrom(response) };
}

export async function login(baseUrl, { cookie, csrfToken, body: sessionBody, username = 'test-admin', password = 'temporary-test-password', remember = false }) {
  const csrf = csrfToken || sessionBody?.csrfToken;
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: {
      Cookie: cookie,
      Origin: baseUrl,
      'X-CSRF-Token': csrf,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ username, password, remember }),
  });
  const body = await response.json();
  return { response, body, cookie: response.ok ? cookieFrom(response) : cookie };
}
