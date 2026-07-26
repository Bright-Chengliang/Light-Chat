import test from 'node:test';
import assert from 'node:assert/strict';
import { NewApiClient, testing } from '../lib/newapi-client.mjs';
import { createFakeNewApi, tinyJpeg, tinyPng } from './helpers.mjs';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function parseMultipart(request) {
  assert.match(request.contentType, /^multipart\/form-data; boundary=/);
  return new Response(request.rawBody, { headers: { 'Content-Type': request.contentType } }).formData();
}

test('model capability mapping exposes Gemini Flash and gpt-image-2 edit support', () => {
  const image2 = testing.modelSummary('gpt-image-2');
  assert.deepEqual(image2.modes, ['image']);
  assert.equal(image2.inputImages, true);
  assert.equal(image2.imageOptions.supportsEdits, true);
  assert.equal(image2.imageOptions.maxReferenceImages, 8);
  assert.deepEqual(image2.imageOptions.sizes, ['1024x1024', '1536x1024', '1536x1152', '1792x1024', '1152x1536', '1024x1536', '1024x1792']);
  const dalle = testing.modelSummary('dall-e-3');
  assert.equal(dalle.imageOptions.supportsEdits, false);
  assert.deepEqual(dalle.imageOptions.sizes, ['1024x1024', '1024x1536', '1536x1024', '1536x1152', '1792x1024']);
  const flash = testing.modelSummary('gemini-3.1-flash-image');
  assert.deepEqual(flash.modes, ['chat', 'image']);
  assert.equal(flash.outputImages, true);
  assert.equal(flash.inputImages, true);
  assert.equal(flash.imageOptions.defaultSize, '1792x1024');
  assert.equal(flash.imageOptions.defaultQuality, 'high');
  assert.deepEqual(flash.imageOptions.sizes, ['1024x1024', '1536x1024', '1536x1152', '1792x1024', '1152x1536', '1024x1536', '1024x1792']);
});

test('chat first-token watchdog stops after the first generated token', async () => {
  const beforeFirstToken = testing.createLinkedController(undefined, 20);
  await wait(35);
  assert.equal(beforeFirstToken.signal.aborted, true);
  beforeFirstToken.dispose();

  const afterFirstToken = testing.createLinkedController(undefined, 20);
  afterFirstToken.markStarted();
  await wait(35);
  assert.equal(afterFirstToken.signal.aborted, false);
  afterFirstToken.dispose();
});

test('Gemini Flash Images requests preserve every selected canvas size', async () => {
  const fake = await createFakeNewApi({ imageMime: 'jpeg' });
  try {
    const client = new NewApiClient({ apiKey: 'test-api-key', baseUrl: fake.baseUrl });
    const prompt = '  保留首尾空格  ';
    for (const size of ['1024x1024', '1536x1024', '1536x1152', '1792x1024', '1152x1536', '1024x1536', '1024x1792']) {
      const images = await client.generateImages({ model: 'gemini-3.1-flash-image', prompt, size, quality: 'high', count: 1 });
      assert.equal(images[0].mimeType, 'image/jpeg');
      assert.equal(images[0].buffer[0], 0xff);
      assert.equal(images[0].buffer[1], 0xd8);
      const request = fake.requests.findLast((entry) => entry.url === '/v1/images/generations');
      assert.deepEqual(JSON.parse(request.bodyText), {
        model: 'gemini-3.1-flash-image', prompt, n: 1, size, quality: 'high', response_format: 'b64_json',
      });
    }
  } finally {
    await fake.close();
  }
});

test('gpt-image-2 uses Responses without forcing tool_choice and retains references', async () => {
  const fake = await createFakeNewApi();
  try {
    const client = new NewApiClient({ apiKey: 'test-api-key', baseUrl: fake.baseUrl });
    const prompt = '历史设定：月华白与琥珀金。当前请求：开始生成';
    const images = await client.editImages({
      model: 'gpt-image-2', prompt, references: [{ buffer: tinyPng(3, 2), mimeType: 'image/png' }], size: '1024x1024', quality: 'low', count: 1,
    });
    assert.equal(images.length, 1);
    const request = fake.requests.find((entry) => entry.url === '/v1/responses');
    const body = JSON.parse(request.bodyText);
    assert.equal(body.model, 'gpt-5.4-mini');
    assert.equal(body.tool_choice, undefined);
    assert.equal(body.tools[0].type, 'image_generation');
    assert.equal(body.tools[0].model, 'gpt-image-2');
    assert.equal(body.input[0].content[0].text, prompt);
    assert.match(body.input[0].content[1].image_url, /^data:image\/png;base64,/);
  } finally {
    await fake.close();
  }
});

test('gpt-image-2 keeps a valid text-only Responses result instead of treating it as an image protocol error', async () => {
  const fake = await createFakeNewApi({ responseText: '抱歉，我不能生成该图片，但可以提供安全替代方案。' });
  try {
    const client = new NewApiClient({ apiKey: 'test-api-key', baseUrl: fake.baseUrl });
    const result = await client.generateImages({ model: 'gpt-image-2', prompt: 'draw', size: '1024x1024', quality: 'high', count: 1 });
    assert.equal(result.length, 0);
    assert.equal(result.text, '抱歉，我不能生成该图片，但可以提供安全替代方案。');
  } finally { await fake.close(); }
});

test('NewAPI client parses Gemini markdown data images without exposing base64 as text', async () => {
  const fake = await createFakeNewApi();
  try {
    const client = new NewApiClient({ apiKey: 'test-api-key', baseUrl: fake.baseUrl });
    const result = await client.chat({ model: 'gemini-test-image', messages: [{ role: 'user', content: 'draw' }] });
    assert.equal(result.text, '你好，图片如下：');
    assert.equal(result.images.length, 1);
    assert.equal(result.images[0].mimeType, 'image/png');
    assert.equal(result.text.includes('base64'), false);
    assert.deepEqual(result.usage, { promptTokens: 1234, completionTokens: 56, totalTokens: 1290 });
    const upstream = fake.requests.find((request) => request.url === '/v1/chat/completions');
    assert.deepEqual(JSON.parse(upstream.bodyText).stream_options, { include_usage: true });
  } finally {
    await fake.close();
  }
});

test('Gemini Flash multimodal chat keeps each selected aspect ratio on the configured NewAPI route', async () => {
  const gateway = await createFakeNewApi();
  try {
    const client = new NewApiClient({
      apiKey: 'test-api-key',
      baseUrl: gateway.baseUrl,
    });
    const expectedAspectRatios = {
      '1024x1024': '1:1', '1536x1024': '3:2', '1536x1152': '4:3', '1792x1024': '16:9',
      '1152x1536': '3:4', '1024x1536': '2:3', '1024x1792': '9:16',
    };
    for (const [imageSize, aspectRatio] of Object.entries(expectedAspectRatios)) {
      const result = await client.chat({
        model: 'gemini-3.1-flash-image',
        messages: [{ role: 'user', content: [{ type: 'text', text: '融合两张图' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } }] }],
        imageSize,
        stream: true,
      });
      assert.equal(result.images.length, 1);
      const gatewayRequest = gateway.requests.findLast((request) => request.url === '/v1/chat/completions');
      assert.ok(gatewayRequest);
      assert.equal(gatewayRequest.authorization, 'Bearer test-api-key');
      assert.equal(JSON.parse(gatewayRequest.bodyText).stream, false);
      assert.equal(JSON.parse(gatewayRequest.bodyText).stream_options, undefined);
      assert.equal(JSON.parse(gatewayRequest.bodyText).size, imageSize);
      assert.deepEqual(JSON.parse(gatewayRequest.bodyText).extra_body, { google: { image_config: { aspect_ratio: aspectRatio } } });
      const imagePart = JSON.parse(gatewayRequest.bodyText).messages[0].content[1];
      assert.deepEqual(Object.keys(imagePart.image_url), ['url']);
    }
  } finally {
    await gateway.close();
  }
});

test('gpt-image-2 single-image edits use Responses image input and preserve scalar fields', async () => {
  const fake = await createFakeNewApi();
  try {
    const client = new NewApiClient({ apiKey: 'test-api-key', baseUrl: fake.baseUrl });
    const prompt = '  保留主体，背景改成白色  ';
    const source = tinyPng(7, 5);
    const images = await client.editImages({
      model: 'gpt-image-2', prompt, references: [{ buffer: source, mimeType: 'image/png' }], size: '1536x1024', quality: 'high', count: 1,
    });
    assert.equal(images[0].mimeType, 'image/png');
    const body = JSON.parse(fake.requests.find((entry) => entry.url === '/v1/responses').bodyText);
    assert.equal(body.tool_choice, undefined);
    assert.equal(body.tools[0].action, 'edit');
    assert.equal(body.tools[0].model, 'gpt-image-2');
    assert.equal(body.tools[0].size, '1536x1024');
    assert.equal(body.tools[0].quality, 'high');
    assert.equal(body.input[0].content[0].text, prompt);
    assert.equal(body.input[0].content[1].image_url, `data:image/png;base64,${source.toString('base64')}`);
  } finally {
    await fake.close();
  }
});

test('gpt-image-2 multi-image edits retain all references and a PNG mask on Responses', async () => {
  const fake = await createFakeNewApi({ imageMime: 'jpeg' });
  try {
    const client = new NewApiClient({ apiKey: 'test-api-key', baseUrl: fake.baseUrl });
    const first = tinyPng(3, 2); const second = tinyJpeg(4, 3); const mask = tinyPng(3, 2);
    const images = await client.editImages({
      model: 'gpt-image-2', prompt: 'edit',
      references: [{ buffer: first, mimeType: 'image/png' }, { buffer: second, mimeType: 'image/jpeg' }],
      mask: { buffer: mask, mimeType: 'image/png' }, size: '1024x1024', quality: 'medium', count: 1,
    });
    assert.equal(images[0].mimeType, 'image/jpeg');
    const body = JSON.parse(fake.requests.find((entry) => entry.url === '/v1/responses').bodyText);
    assert.equal(body.input[0].content.length, 3);
    assert.equal(body.input[0].content[1].image_url, `data:image/png;base64,${first.toString('base64')}`);
    assert.equal(body.input[0].content[2].image_url, `data:image/jpeg;base64,${second.toString('base64')}`);
    assert.equal(body.tools[0].input_image_mask.image_url, `data:image/png;base64,${mask.toString('base64')}`);
  } finally {
    await fake.close();
  }
});

test('image editing refuses remote URL results instead of backend-fetching them', async () => {
  const fake = await createFakeNewApi({ imageUrlOnly: true });
  try {
    const client = new NewApiClient({ apiKey: 'test-api-key', baseUrl: fake.baseUrl });
    await assert.rejects(
      client.editImages({ model: 'gpt-image-2', prompt: 'edit', references: [{ buffer: tinyPng(), mimeType: 'image/png' }], size: '1024x1024', quality: 'high', count: 1 }),
      (error) => error.code === 'REMOTE_IMAGE_REJECTED',
    );
    assert.equal(fake.requests.some((request) => request.url === '/private.png'), false);
  } finally {
    await fake.close();
  }
});

test('image generation refuses remote URL results instead of backend-fetching them', async () => {
  const fake = await createFakeNewApi({ imageUrlOnly: true });
  try {
    const client = new NewApiClient({ apiKey: 'test-api-key', baseUrl: fake.baseUrl });
    await assert.rejects(
      client.generateImages({ model: 'gpt-image-2', prompt: 'draw', size: '1024x1024', count: 1 }),
      (error) => error.code === 'REMOTE_IMAGE_REJECTED',
    );
    assert.equal(fake.requests.some((request) => request.url === '/private.png'), false);
  } finally {
    await fake.close();
  }
});
