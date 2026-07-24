import { publicError, readLimitedResponse } from './security.mjs';
import { decodeDataImage, inspectRaster, MAX_OUTPUT_IMAGE_BYTES } from './media-store.mjs';

const MODEL_CACHE_MS = 5 * 60 * 1000;
const MODEL_TIMEOUT_MS = 15_000;
const CHAT_FIRST_TOKEN_TIMEOUT_MS = 600_000;
const IMAGE_TIMEOUT_MS = 600_000;
const MAX_MODEL_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_CHAT_OUTPUT_CHARS = 24 * 1024 * 1024;
const MAX_IMAGE_RESPONSE_BYTES = 24 * 1024 * 1024;

function createLinkedController(parentSignal, timeoutMs) {
  const controller = new AbortController();
  let timeout = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
  let started = false;
  const abort = () => controller.abort(parentSignal?.reason);
  if (parentSignal?.aborted) abort();
  else parentSignal?.addEventListener('abort', abort, { once: true });
  return {
    signal: controller.signal,
    // Chat requests use this as a first-token watchdog. Once the upstream
    // produces useful output, the request may continue for as long as it
    // needs; user cancellation is still propagated through parentSignal.
    markStarted() {
      if (started) return;
      started = true;
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
    },
    dispose() {
      if (timeout) clearTimeout(timeout);
      timeout = null;
      parentSignal?.removeEventListener('abort', abort);
    },
  };
}

function imageEndpointModel(modelId) {
  const value = modelId.toLowerCase();
  return value === 'gpt-image-2'
    || value.startsWith('gpt-image-')
    || value.startsWith('dall-e-');
}

function usesResponsesImageRoute(modelId) {
  return modelId.trim().toLowerCase() === 'gpt-image-2';
}

function modelSummary(id) {
  const lower = id.toLowerCase();
  const dedicatedImage = imageEndpointModel(id);
  const supportsEdits = lower === 'gpt-image-2';
  const geminiFlashImage = lower === 'gemini-3.1-flash-image';
  const imageChat = geminiFlashImage || (!dedicatedImage && lower.includes('image'));
  const likelyVision = imageChat
    || lower.includes('vision')
    || lower.includes('-vl')
    || lower.includes('4o')
    || lower.includes('gemini')
    || lower.includes('claude');
  return {
    id,
    name: id,
    modes: geminiFlashImage ? ['chat', 'image'] : dedicatedImage ? ['image'] : ['chat'],
    suggestedMode: dedicatedImage || geminiFlashImage ? 'image' : 'chat',
    inputImages: supportsEdits || (!dedicatedImage && likelyVision),
    outputImages: dedicatedImage || imageChat,
    ...(geminiFlashImage ? {
      imageOptions: {
        defaultSize: '1792x1024',
        sizes: ['1024x1024', '1536x1024', '1536x1152', '1792x1024', '1152x1536', '1024x1536', '1024x1792'],
        defaultQuality: 'high',
        qualities: ['high'],
        maxCount: 1,
      },
    } : dedicatedImage ? {
      imageOptions: {
        defaultSize: '1536x1024',
        sizes: supportsEdits
          ? ['1024x1024', '1536x1024', '1536x1152', '1792x1024', '1152x1536', '1024x1536', '1024x1792']
          : ['1024x1024', '1024x1536', '1536x1024', '1536x1152', '1792x1024'],
        defaultQuality: 'high',
        qualities: ['low', 'medium', 'high', 'auto'],
        maxCount: 2,
        supportsEdits,
        maxReferenceImages: supportsEdits ? 8 : 0,
      },
    } : {}),
  };
}

function normalizeModelList(data) {
  if (!data || !Array.isArray(data.data) || data.data.length > 2000) {
    throw publicError(502, '模型列表格式无效', 'INVALID_MODEL_LIST');
  }
  const ids = new Set();
  for (const entry of data.data) {
    const id = typeof entry === 'string' ? entry : entry?.id;
    if (typeof id !== 'string' || id.length < 1 || id.length > 200 || /[\u0000-\u001f\u007f]/.test(id)) continue;
    ids.add(id);
  }
  if (ids.size === 0) throw publicError(502, '模型列表为空', 'EMPTY_MODEL_LIST');
  return [...ids].sort((a, b) => a.localeCompare(b, 'zh-CN')).map(modelSummary);
}

function textFromContent(content, explicitImages) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let text = '';
  for (const part of content) {
    if (typeof part === 'string') {
      text += part;
    } else if (typeof part?.text === 'string') {
      text += part.text;
    } else {
      const value = typeof part?.image_url === 'string' ? part.image_url : part?.image_url?.url;
      if (typeof value === 'string') explicitImages.push(value);
    }
  }
  return text;
}

function extractDelta(frame, explicitImages) {
  const choice = frame?.choices?.[0];
  const content = choice?.delta?.content ?? choice?.message?.content;
  const text = textFromContent(content, explicitImages);
  const reasoning = choice?.delta?.reasoning_content ?? choice?.delta?.reasoning ?? '';
  return {
    text,
    reasoning: typeof reasoning === 'string' ? reasoning : '',
  };
}

function normalizeUsage(value) {
  if (!value || typeof value !== 'object') return null;
  const token = (...candidates) => candidates.find((candidate) => Number.isSafeInteger(candidate) && candidate >= 0 && candidate <= 1_000_000_000_000);
  const promptTokens = token(value.prompt_tokens, value.input_tokens);
  const completionTokens = token(value.completion_tokens, value.output_tokens);
  let totalTokens = token(value.total_tokens);
  if (totalTokens === undefined && promptTokens !== undefined && completionTokens !== undefined) totalTokens = promptTokens + completionTokens;
  if (promptTokens === undefined && completionTokens === undefined && totalTokens === undefined) return null;
  return {
    ...(promptTokens === undefined ? {} : { promptTokens }),
    ...(completionTokens === undefined ? {} : { completionTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
  };
}

function extractMarkdownImages(text) {
  const images = [];
  const cleaned = text.replace(
    /!\[([^\]\r\n]{0,300})\]\((data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=\r\n]+)\)/g,
    (_match, alt, dataUri) => {
      images.push({ alt, dataUri });
      return '';
    },
  );
  return { text: cleaned.trim(), images };
}

class StreamingTextGuard {
  constructor() {
    this.buffer = '';
    this.maxBufferedImageChars = Math.ceil(MAX_OUTPUT_IMAGE_BYTES * 1.4) + 1024;
  }

  push(value, emit) {
    this.buffer += value;
    this.drain(emit, false);
  }

  finish(emit) {
    this.drain(emit, true);
    if (this.buffer) emit(this.buffer);
    this.buffer = '';
  }

  drain(emit, final) {
    while (this.buffer) {
      const start = this.buffer.indexOf('![');
      if (start === -1) {
        const keep = final ? 0 : Math.min(192, this.buffer.length);
        const ready = this.buffer.slice(0, this.buffer.length - keep);
        if (ready) emit(ready);
        this.buffer = this.buffer.slice(this.buffer.length - keep);
        return;
      }
      if (start > 0) {
        emit(this.buffer.slice(0, start));
        this.buffer = this.buffer.slice(start);
      }
      const closing = this.buffer.indexOf(')');
      if (closing === -1 && !final) {
        if (this.buffer.length > this.maxBufferedImageChars) throw publicError(502, '模型返回的图片过大', 'UPSTREAM_IMAGE_TOO_LARGE');
        return;
      }
      const candidate = closing === -1 ? this.buffer : this.buffer.slice(0, closing + 1);
      if (/^!\[[^\]\r\n]{0,300}\]\(data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=\r\n]+\)$/.test(candidate)) {
        this.buffer = this.buffer.slice(candidate.length);
        continue;
      }
      if (closing === -1) return;
      emit(this.buffer.slice(0, 2));
      this.buffer = this.buffer.slice(2);
    }
  }
}

function strictBase64Raster(value) {
  if (typeof value !== 'string' || value.length > Math.ceil(MAX_OUTPUT_IMAGE_BYTES / 3) * 4 + 4) {
    throw publicError(502, '模型返回的图片过大', 'UPSTREAM_IMAGE_TOO_LARGE');
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 === 1) {
    throw publicError(502, '模型返回的图片编码无效', 'INVALID_UPSTREAM_IMAGE');
  }
  const buffer = Buffer.from(value, 'base64');
  if (!buffer.length || buffer.length > MAX_OUTPUT_IMAGE_BYTES) {
    throw publicError(502, '模型返回的图片过大', 'UPSTREAM_IMAGE_TOO_LARGE');
  }
  if (buffer.toString('base64').replace(/=+$/, '') !== value.replace(/=+$/, '')) {
    throw publicError(502, '模型返回的图片编码无效', 'INVALID_UPSTREAM_IMAGE');
  }
  return { buffer, ...inspectRaster(buffer) };
}

function decodeImageResults(data, count, prompt) {
  if (!Array.isArray(data?.data) || data.data.length < 1 || data.data.length > count) {
    throw publicError(502, '生图结果格式无效', 'INVALID_UPSTREAM_RESPONSE');
  }
  return data.data.map((item) => {
    if (typeof item?.b64_json !== 'string') {
      // Never fetch or expose arbitrary upstream URLs.
      throw publicError(502, '生图服务未返回可安全展示的图片', 'REMOTE_IMAGE_REJECTED');
    }
    return {
      alt: typeof item.revised_prompt === 'string' ? item.revised_prompt.slice(0, 300) : prompt.slice(0, 300),
      ...strictBase64Raster(item.b64_json),
    };
  });
}

function decodeResponsesImageResults(data, count, prompt) {
  const output = Array.isArray(data?.output) ? data.output : [];
  const images = output
    .filter((item) => item?.type === 'image_generation_call')
    .map((item) => ({
      ...(typeof item.result === 'string' ? { b64_json: item.result } : {}),
      ...(typeof item.url === 'string' ? { url: item.url } : {}),
      revised_prompt: typeof item.revised_prompt === 'string' ? item.revised_prompt : prompt,
    }));
  const text = [
    typeof data?.output_text === 'string' ? data.output_text : '',
    ...output.flatMap((item) => item?.type === 'message' && Array.isArray(item.content)
      ? item.content.map((part) => typeof part?.text === 'string' ? part.text : typeof part?.refusal === 'string' ? part.refusal : '').filter(Boolean)
      : []),
  ].filter(Boolean).join('\n').trim();
  if (!images.length) {
    if (!text) throw publicError(502, '生图结果格式无效', 'INVALID_UPSTREAM_RESPONSE');
    const result = [];
    Object.defineProperty(result, 'text', { value: text, enumerable: false });
    return result;
  }
  const result = decodeImageResults({ data: images }, count, prompt);
  Object.defineProperty(result, 'text', { value: text, enumerable: false });
  return result;
}

function rasterDataUrl(raster) {
  if (!raster || !Buffer.isBuffer(raster.buffer)) {
    throw publicError(400, '参考图片无效', 'INVALID_REFERENCE_IMAGE');
  }
  const details = inspectRaster(raster.buffer);
  if (raster.mimeType && raster.mimeType !== details.mimeType) {
    throw publicError(400, '参考图片类型不一致', 'INVALID_REFERENCE_IMAGE');
  }
  return `data:${details.mimeType};base64,${raster.buffer.toString('base64')}`;
}

function appendRaster(form, field, raster, fileName) {
  if (!raster || !Buffer.isBuffer(raster.buffer)) {
    throw publicError(400, '参考图片无效', 'INVALID_REFERENCE_IMAGE');
  }
  const details = inspectRaster(raster.buffer);
  if (raster.mimeType && raster.mimeType !== details.mimeType) {
    throw publicError(400, '参考图片类型不一致', 'INVALID_REFERENCE_IMAGE');
  }
  form.append(field, new Blob([raster.buffer], { type: details.mimeType }), fileName);
  return raster.buffer.length;
}

export class NewApiClient {
  constructor({
    apiKey,
    baseUrl = 'http://127.0.0.1:3002/v1',
    fetchImpl = fetch,
  }) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.fetch = fetchImpl;
    this.modelCache = null;
  }

  headers(apiKey = this.apiKey) {
    return {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
  }

  async listModels({ force = false, signal } = {}) {
    if (!force && this.modelCache?.expiresAt > Date.now()) return this.modelCache.models;
    const linked = createLinkedController(signal, MODEL_TIMEOUT_MS);
    try {
      const response = await this.fetch(`${this.baseUrl}/models`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${this.apiKey}`, Accept: 'application/json' },
        redirect: 'error',
        signal: linked.signal,
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw publicError(502, '暂时无法加载模型列表', 'MODEL_SERVICE_UNAVAILABLE');
      }
      const raw = await readLimitedResponse(response, MAX_MODEL_RESPONSE_BYTES);
      let data;
      try { data = JSON.parse(raw.toString('utf8')); } catch { throw publicError(502, '模型列表格式无效', 'INVALID_MODEL_LIST'); }
      const models = normalizeModelList(data);
      this.modelCache = { models, expiresAt: Date.now() + MODEL_CACHE_MS, loadedAt: new Date().toISOString() };
      return models;
    } catch (error) {
      if (error?.code) throw error;
      if (linked.signal.aborted) throw publicError(504, '加载模型列表超时', 'MODEL_TIMEOUT');
      throw publicError(502, '暂时无法加载模型列表', 'MODEL_SERVICE_UNAVAILABLE');
    } finally {
      linked.dispose();
    }
  }

  async requireModel(modelId, mode, signal) {
    if (typeof modelId !== 'string') throw publicError(400, '请选择模型', 'MODEL_REQUIRED');
    let models = await this.listModels({ signal });
    let model = models.find((entry) => entry.id === modelId && entry.modes.includes(mode));
    if (!model) {
      models = await this.listModels({ force: true, signal });
      model = models.find((entry) => entry.id === modelId && entry.modes.includes(mode));
    }
    if (!model) throw publicError(400, '所选模型不可用，请刷新模型列表', 'MODEL_NOT_ALLOWED');
    return model;
  }

  async chat({ model, messages, temperature, maxTokens, stream = true, onDelta = () => {}, onReasoning = () => {}, signal }) {
    await this.requireModel(model, 'chat', signal);
    const geminiFlashChat = model.toLowerCase() === 'gemini-3.1-flash-image';
    const upstreamStream = geminiFlashChat ? false : stream;
    const linked = createLinkedController(signal, CHAT_FIRST_TOKEN_TIMEOUT_MS);
    try {
      const response = await this.fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { ...this.headers(), Accept: 'text/event-stream, application/json' },
        body: JSON.stringify({
          model,
          messages,
          stream: upstreamStream,
          ...(upstreamStream ? { stream_options: { include_usage: true } } : {}),
          ...(temperature === undefined ? {} : { temperature }),
          ...(maxTokens === undefined ? {} : { max_tokens: maxTokens }),
        }),
        redirect: 'error',
        signal: linked.signal,
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        const status = response.status === 429 ? 429 : 502;
        throw publicError(status, status === 429 ? '模型服务繁忙，请稍后再试' : '模型暂时无法响应', status === 429 ? 'UPSTREAM_RATE_LIMIT' : 'UPSTREAM_FAILED');
      }

      const explicitImages = [];
      let text = '';
      let reasoning = '';
      let usage = null;
      const textGuard = new StreamingTextGuard();
      const emitText = (value) => {
        if (stream && value) {
          linked.markStarted();
          onDelta(value);
        }
      };
      const contentType = response.headers.get('content-type') || '';
      if (!contentType.includes('text/event-stream')) {
        const raw = await readLimitedResponse(response, MAX_CHAT_OUTPUT_CHARS);
        let data;
        try { data = JSON.parse(raw.toString('utf8')); } catch { throw publicError(502, '模型返回格式无效', 'INVALID_UPSTREAM_RESPONSE'); }
        const extracted = extractDelta(data, explicitImages);
        usage = normalizeUsage(data?.usage) || normalizeUsage(data?.choices?.[0]?.usage);
        text = extracted.text;
        reasoning = extracted.reasoning;
        if (stream) {
          if (extracted.text) {
            linked.markStarted();
            textGuard.push(extracted.text, emitText);
          }
          textGuard.finish(emitText);
          if (extracted.reasoning) {
            linked.markStarted();
            onReasoning(extracted.reasoning);
          }
        }
      } else {
        if (!response.body) throw publicError(502, '模型没有返回内容', 'EMPTY_UPSTREAM_RESPONSE');
        const decoder = new TextDecoder();
        let buffer = '';
        let totalChars = 0;
        const processLine = (line) => {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) return;
          const payload = trimmed.slice(5).trim();
          if (!payload || payload === '[DONE]') return;
          let frame;
          try { frame = JSON.parse(payload); } catch { return; }
          usage = normalizeUsage(frame?.usage) || normalizeUsage(frame?.choices?.[0]?.usage) || usage;
          const extracted = extractDelta(frame, explicitImages);
          text += extracted.text;
          reasoning += extracted.reasoning;
          if (stream && extracted.text) {
            linked.markStarted();
            textGuard.push(extracted.text, emitText);
          }
          if (stream && extracted.reasoning) {
            linked.markStarted();
            onReasoning(extracted.reasoning);
          }
          totalChars += extracted.text.length + extracted.reasoning.length;
          if (totalChars > MAX_CHAT_OUTPUT_CHARS) throw publicError(502, '模型返回内容过大', 'UPSTREAM_TOO_LARGE');
        };
        for await (const chunk of response.body) {
          buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n');
          let newline;
          while ((newline = buffer.indexOf('\n')) >= 0) {
            processLine(buffer.slice(0, newline));
            buffer = buffer.slice(newline + 1);
          }
          if (buffer.length > MAX_CHAT_OUTPUT_CHARS) throw publicError(502, '模型返回内容过大', 'UPSTREAM_TOO_LARGE');
        }
        buffer += decoder.decode();
        if (buffer.trim()) processLine(buffer);
        if (stream) textGuard.finish(emitText);
      }

      const markdown = extractMarkdownImages(text);
      const images = markdown.images.map(({ alt, dataUri }) => ({ alt, ...decodeDataImage(dataUri) }));
      for (const dataUri of explicitImages) images.push({ alt: '', ...decodeDataImage(dataUri) });
      if (!markdown.text && images.length === 0) throw publicError(502, '模型没有返回可读内容', 'EMPTY_UPSTREAM_RESPONSE');
      return { text: markdown.text, reasoning: reasoning.trim(), images, usage };
    } catch (error) {
      if (error?.code) throw error;
      if (linked.signal.aborted) throw publicError(504, '模型响应超时', 'UPSTREAM_TIMEOUT');
      throw publicError(502, '模型暂时无法响应', 'UPSTREAM_FAILED');
    } finally {
      linked.dispose();
    }
  }

  async generateImages({ model, prompt, size, count, quality, signal }) {
    await this.requireModel(model, 'image', signal);
    if (usesResponsesImageRoute(model)) {
      return this.generateImagesViaResponses({ model, prompt, size, count, quality, signal });
    }
    const linked = createLinkedController(signal, IMAGE_TIMEOUT_MS);
    try {
      const response = await this.fetch(`${this.baseUrl}/images/generations`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ model, prompt, n: count, size, quality, response_format: 'b64_json' }),
        redirect: 'error',
        signal: linked.signal,
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        const status = response.status === 429 ? 429 : 502;
        throw publicError(status, status === 429 ? '生图服务繁忙，请稍后再试' : '生图服务暂时不可用', status === 429 ? 'UPSTREAM_RATE_LIMIT' : 'UPSTREAM_FAILED');
      }
      const raw = await readLimitedResponse(response, MAX_IMAGE_RESPONSE_BYTES);
      let data;
      try { data = JSON.parse(raw.toString('utf8')); } catch { throw publicError(502, '生图结果格式无效', 'INVALID_UPSTREAM_RESPONSE'); }
      return decodeImageResults(data, count, prompt);
    } catch (error) {
      if (error?.code) throw error;
      if (linked.signal.aborted) throw publicError(504, '生图响应超时', 'UPSTREAM_TIMEOUT');
      throw publicError(502, '生图服务暂时不可用', 'UPSTREAM_FAILED');
    } finally {
      linked.dispose();
    }
  }

  async editImages({ model, prompt, references, mask, size, count, quality, signal }) {
    const selectedModel = await this.requireModel(model, 'image', signal);
    const maxReferenceImages = selectedModel.imageOptions?.maxReferenceImages || 0;
    if (!selectedModel.imageOptions?.supportsEdits) {
      throw publicError(400, '所选模型不支持参考图编辑', 'IMAGE_EDITS_NOT_SUPPORTED');
    }
    if (!Array.isArray(references) || references.length < 1 || references.length > maxReferenceImages) {
      throw publicError(400, '参考图片数量无效', 'INVALID_REFERENCE_IMAGES');
    }
    if (usesResponsesImageRoute(model)) {
      return this.generateImagesViaResponses({ model, prompt, size, count, quality, references, mask, signal });
    }

    const form = new FormData();
    const field = references.length === 1 ? 'image' : 'image[]';
    references.forEach((reference, index) => {
      appendRaster(form, field, reference, `reference-${index + 1}.${reference.mimeType === 'image/jpeg' ? 'jpg' : reference.mimeType === 'image/webp' ? 'webp' : 'png'}`);
    });
    if (mask) {
      if (mask.mimeType !== 'image/png') throw publicError(400, '遮罩必须为 PNG 图片', 'INVALID_IMAGE_MASK');
      appendRaster(form, 'mask', mask, 'mask.png');
    }
    form.append('model', model);
    form.append('prompt', prompt);
    form.append('size', size);
    form.append('quality', quality);
    form.append('n', String(count));
    form.append('response_format', 'b64_json');

    const linked = createLinkedController(signal, IMAGE_TIMEOUT_MS);
    try {
      const response = await this.fetch(`${this.baseUrl}/images/edits`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}`, Accept: 'application/json' },
        body: form,
        redirect: 'error',
        signal: linked.signal,
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        const status = response.status === 429 ? 429 : 502;
        throw publicError(status, status === 429 ? '图片编辑服务繁忙，请稍后再试' : '图片编辑服务暂时不可用', status === 429 ? 'UPSTREAM_RATE_LIMIT' : 'UPSTREAM_FAILED');
      }
      const raw = await readLimitedResponse(response, MAX_IMAGE_RESPONSE_BYTES);
      let data;
      try { data = JSON.parse(raw.toString('utf8')); } catch { throw publicError(502, '图片编辑结果格式无效', 'INVALID_UPSTREAM_RESPONSE'); }
      return decodeImageResults(data, count, prompt);
    } catch (error) {
      if (error?.code) throw error;
      if (linked.signal.aborted) throw publicError(504, '图片编辑响应超时', 'UPSTREAM_TIMEOUT');
      throw publicError(502, '图片编辑服务暂时不可用', 'UPSTREAM_FAILED');
    } finally {
      linked.dispose();
    }
  }

  async generateImagesViaResponses({ model, prompt, size, count, quality, references = [], mask, signal }) {
    const content = [{ type: 'input_text', text: prompt }];
    for (const reference of references) {
      content.push({ type: 'input_image', image_url: rasterDataUrl(reference) });
    }
    const tool = {
      type: 'image_generation',
      action: references.length ? 'edit' : 'generate',
      model,
      size,
      quality,
      output_format: 'png',
    };
    if (mask) {
      if (mask.mimeType !== 'image/png') throw publicError(400, '遮罩必须为 PNG 图片', 'INVALID_IMAGE_MASK');
      tool.input_image_mask = { image_url: rasterDataUrl(mask) };
    }
    const linked = createLinkedController(signal, IMAGE_TIMEOUT_MS);
    try {
      const response = await this.fetch(`${this.baseUrl}/responses`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          model: 'gpt-5.4-mini',
          input: [{ type: 'message', role: 'user', content }],
          tools: [tool],
          stream: false,
          store: false,
        }),
        redirect: 'error',
        signal: linked.signal,
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        const status = response.status === 429 ? 429 : 502;
        throw publicError(status, status === 429 ? '生图服务繁忙，请稍后再试' : '生图服务暂时不可用', status === 429 ? 'UPSTREAM_RATE_LIMIT' : 'UPSTREAM_FAILED');
      }
      const raw = await readLimitedResponse(response, MAX_IMAGE_RESPONSE_BYTES);
      let data;
      try { data = JSON.parse(raw.toString('utf8')); } catch { throw publicError(502, '生图结果格式无效', 'INVALID_UPSTREAM_RESPONSE'); }
      return decodeResponsesImageResults(data, count, prompt);
    } catch (error) {
      if (error?.code) throw error;
      if (linked.signal.aborted) throw publicError(504, '生图响应超时', 'UPSTREAM_TIMEOUT');
      throw publicError(502, '生图服务暂时不可用', 'UPSTREAM_FAILED');
    } finally {
      linked.dispose();
    }
  }
}

export const testing = Object.freeze({
  createLinkedController,
  extractMarkdownImages,
  imageEndpointModel,
  usesResponsesImageRoute,
  modelSummary,
  normalizeUsage,
  normalizeModelList,
});
