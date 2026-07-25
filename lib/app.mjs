import { createServer } from 'node:http';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { AccountStore, JsonStore } from './account-store.mjs';
import { LoginLimiter } from './login-limiter.mjs';
import { LocalImageUpscaler } from './local-upscaler.mjs';
import { MAX_INPUT_FILE_BYTES, MediaStore } from './media-store.mjs';
import { NewApiClient } from './newapi-client.mjs';
import { PdfTextExtractor } from './pdf-text-extractor.mjs';
import { EMPTY_ROLE_LIBRARY, findRole, validateRoleLibrary } from './role-store.mjs';
import { SessionManager } from './session-manager.mjs';
import {
  publicError,
  readBody,
  readJson,
  sendJson,
  sendSse,
  setSecurityHeaders,
} from './security.mjs';

const MAX_JSON_BYTES = 16 * 1024 * 1024;
const MAX_MESSAGES = 60;
const MAX_ATTACHMENTS = 8;
const MAX_CONTEXT_IMAGES = 12;
const MAX_CONTEXT_MEDIA_BYTES = 50 * 1024 * 1024;
const MAX_SESSION_UPLOAD_BYTES = 50 * 1024 * 1024;
const MAX_CONCURRENT_GLOBAL = 8;
const MAX_CONCURRENT_PER_SESSION = 4;
const MAX_ADMIN_CONVERSATIONS = 200;
const MAX_ADMIN_HISTORY_MESSAGES = 60;
const MAX_ADMIN_HISTORY_ATTACHMENTS = 8;
const MAX_ADMIN_HISTORY_VARIANTS = 8;
const MAX_ADMIN_HISTORY_DEPTH = 12;
const MAX_ADMIN_HISTORY_TEXT_CHARS = 4_000_000;
const DEFAULT_CONTEXT_TOKENS = 256 * 1024;
const MAX_CONFIGURED_CONTEXT_TOKENS = 16 * 1024 * 1024;
const MAX_LOCAL_UPSCALE_DIMENSION = 7680;
const MAX_LOCAL_UPSCALE_PIXELS = 32_000_000;
const SSE_HEARTBEAT_INTERVAL_MS = 5_000;
const WORKFLOW_JOB_TTL_MS = 30 * 60 * 1000;
const CONVERSATION_TITLE_MODEL = 'gemini-3.5-flash-low-fan';
const MAX_WORKFLOWS = 24;
const MAX_WORKFLOW_NODES = 16;
const MAX_WORKFLOW_EDGES = 48;
const ALLOWED_IMAGE_SIZES = new Set(['256x256', '512x512', '1024x1024', '1024x1536', '1152x1536', '1024x1792', '1536x1024', '1536x1152', '1792x1024', 'auto']);
const ALLOWED_IMAGE_QUALITIES = new Set(['low', 'medium', 'high', 'auto']);

const DEFAULT_WORKFLOW_DATA = Object.freeze({
  version: 2,
  workflows: [
    {
      id: 'image-prompt-architect', name: '人设图生图', description: '先整理提示词，再生成成品图片', enabled: true,
      nodes: [
        { id: 'architect', type: 'role', roleId: 'role-mrsmkx9c-2293', model: 'claude-sonnet-4-5', inputTemplate: '{{input}}', inputMerge: 'plain', output: { mode: 'full' }, position: { x: 300, y: 140 } },
        { id: 'image', type: 'image', model: 'gpt-image-2', output: { mode: 'full' }, size: '1792x1024', quality: 'high', allowUserModelOverride: true, allowUserSizeOverride: true, allowUserQualityOverride: true, position: { x: 720, y: 140 } },
      ],
      edges: [{ id: 'edge-user-architect', from: 'user', to: 'architect' }, { id: 'edge-architect-image', from: 'architect', to: 'image' }],
    },
    {
      id: 'epic-poster-v3', name: '史诗叙事海报生成', description: '将创意扩展为完整的叙事海报提示词并生成图片', enabled: true,
      nodes: [
        { id: 'poster-master', type: 'role', roleId: 'role-mrqi90jc-7jmq', model: 'claude-sonnet-4-5', inputTemplate: '{{input}}', inputMerge: 'plain', output: { mode: 'full' }, position: { x: 300, y: 140 } },
        { id: 'image', type: 'image', model: 'gpt-image-2', output: { mode: 'poster-chinese' }, size: '1792x1024', quality: 'high', allowUserModelOverride: true, allowUserSizeOverride: true, allowUserQualityOverride: true, position: { x: 720, y: 140 } },
      ],
      edges: [{ id: 'edge-user-poster', from: 'user', to: 'poster-master' }, { id: 'edge-poster-image', from: 'poster-master', to: 'image' }],
    },
  ],
});

const STATIC_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
});

function publicFailure(error) {
  const status = Number.isInteger(error?.status) ? error.status : 500;
  if (status >= 500) {
    const messages = {
      502: '模型服务暂时不可用',
      503: '当前服务繁忙，请稍后重试',
      504: '模型响应超时，请稍后重试',
    };
    return { status, error: messages[status] || '服务暂时不可用', code: error?.code || 'SERVER_ERROR' };
  }
  return { status, error: error?.publicMessage || error?.message || '请求无效', code: error?.code || 'REQUEST_FAILED' };
}

function isAllowedHost(host, allowedHosts, port) {
  if (typeof host !== 'string' || host.length > 255 || /[\s/@\\]/.test(host)) return false;
  const normalized = host.toLowerCase();
  if (allowedHosts.has(normalized)) return true;
  if (port === 0 && /^(?:127\.0\.0\.1|localhost):\d+$/.test(normalized)) return true;
  return false;
}

function requireSafeMutation(req, sessionManager, found) {
  const host = String(req.headers.host || '').toLowerCase();
  const origin = req.headers.origin;
  const scheme = sessionManager.isHttps(req) ? 'https' : 'http';
  if (typeof origin !== 'string' || origin !== `${scheme}://${host}`) {
    throw publicError(403, '拒绝跨站请求', 'ORIGIN_REJECTED');
  }
  if (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])) {
    throw publicError(403, '拒绝跨站请求', 'ORIGIN_REJECTED');
  }
  sessionManager.requireCsrf(req, found);
}

function validateFavoriteItems(value, models, maxItems = 20) {
  if (!Array.isArray(value) || value.length > maxItems) {
    throw publicError(400, '收藏模型格式无效', 'INVALID_FAVORITES');
  }
  const modelMap = new Map(models.map((model) => [model.id, model]));
  const seen = new Set();
  return value.map((entry) => {
    const modelId = entry?.modelId ?? entry?.model;
    if (!entry || typeof modelId !== 'string' || !['chat', 'image'].includes(entry.mode)) {
      throw publicError(400, '收藏模型组格式无效', 'INVALID_FAVORITES');
    }
    const model = modelMap.get(modelId);
    if (!model || !model.modes.includes(entry.mode)) {
      throw publicError(400, '收藏中包含不可用的模型', 'MODEL_NOT_ALLOWED');
    }
    const key = `${entry.mode}\0${modelId}`;
    if (seen.has(key)) throw publicError(400, '收藏模型不能重复', 'DUPLICATE_FAVORITE');
    seen.add(key);
    const label = entry.label === undefined || entry.label === ''
      ? modelId
      : String(entry.label).trim();
    if (!label || label.length > 40 || /[\u0000-\u001f\u007f]/.test(label)) {
      throw publicError(400, '收藏名称无效', 'INVALID_FAVORITE_LABEL');
    }
    return { modelId, model: modelId, mode: entry.mode, label };
  });
}

function validateModelContextLimits(value, models) {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw publicError(400, '模型上下文配置无效', 'INVALID_CONTEXT_LIMITS');
  }
  const entries = Object.entries(value);
  if (entries.length > models.length || entries.length > 2000) {
    throw publicError(400, '模型上下文配置过多', 'INVALID_CONTEXT_LIMITS');
  }
  const allowed = new Set(models.map((model) => model.id));
  const normalized = {};
  for (const [modelId, limit] of entries) {
    if (
      !allowed.has(modelId)
      || !Number.isInteger(limit)
      || limit < 1024
      || limit > MAX_CONFIGURED_CONTEXT_TOKENS
    ) {
      throw publicError(400, '模型上下文配置无效', 'INVALID_CONTEXT_LIMITS');
    }
    if (limit !== DEFAULT_CONTEXT_TOKENS) normalized[modelId] = limit;
  }
  return normalized;
}

function validateFavoriteMediaIds(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 120) throw publicError(400, '收藏图片列表无效', 'INVALID_FAVORITE_MEDIA');
  const ids = [];
  const seen = new Set();
  for (const id of value) {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(id) || seen.has(id)) throw publicError(400, '收藏图片列表无效', 'INVALID_FAVORITE_MEDIA');
    seen.add(id); ids.push(id);
  }
  return ids;
}

function validatePreferences(input, models) {
  if (!input || typeof input !== 'object') {
    throw publicError(400, '收藏模型组格式无效', 'INVALID_FAVORITES');
  }
  let favoriteGroups;
  if (Array.isArray(input.favoriteGroups)) {
    if (input.favoriteGroups.length > 12) throw publicError(400, '最多创建 12 个收藏组', 'INVALID_FAVORITES');
    const ids = new Set();
    favoriteGroups = input.favoriteGroups.map((group, index) => {
      const name = typeof group?.name === 'string' ? group.name.trim() : '';
      if (!name || name.length > 24 || /[\u0000-\u001f\u007f]/.test(name)) {
        throw publicError(400, '收藏组名称需为 1–24 位', 'INVALID_FAVORITES');
      }
      const id = typeof group.id === 'string' && /^[A-Za-z0-9_-]{3,48}$/.test(group.id)
        ? group.id
        : `group-${index + 1}`;
      if (ids.has(id)) throw publicError(400, '收藏组标识不能重复', 'INVALID_FAVORITES');
      ids.add(id);
      return { id, name, items: validateFavoriteItems(group.items, models) };
    });
  } else if (Array.isArray(input.favorites)) {
    favoriteGroups = input.favorites.length
      ? [{ id: 'favorites', name: '收藏', items: validateFavoriteItems(input.favorites, models, 12) }]
      : [];
  } else {
    throw publicError(400, '收藏模型组格式无效', 'INVALID_FAVORITES');
  }

  let selected = null;
  if (input.selected) {
    const normalized = validateFavoriteItems([input.selected], models, 1)[0];
    selected = { modelId: normalized.modelId, model: normalized.modelId, mode: normalized.mode };
  }
  return { version: 1, favoriteGroups, selected, modelContextLimits: validateModelContextLimits(input.modelContextLimits, models), favoriteMediaIds: validateFavoriteMediaIds(input.favoriteMediaIds) };
}

function preferencesPayload(preferences) {
  return {
    favoriteGroups: preferences.favoriteGroups,
    selected: preferences.selected,
    modelContextLimits: preferences.modelContextLimits || {},
    favoriteMediaIds: preferences.favoriteMediaIds || [],
    defaultContextTokens: DEFAULT_CONTEXT_TOKENS,
    favorites: preferences.favoriteGroups.flatMap((group) => group.items),
  };
}

function automaticFavoritesForModels(models) {
  return [{
    id: 'all-models',
    name: '全部模型',
    items: models.map((model) => {
      const mode = model.modes.includes(model.suggestedMode) ? model.suggestedMode : model.modes[0];
      return { modelId: model.id, model: model.id, mode, label: model.id };
    }),
  }];
}

function storedText(value, limit) {
  return typeof value === 'string' ? value.slice(0, limit) : '';
}

function storedTimestamp(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : Date.now();
}

function storedId(value, limit = 80) {
  const id = storedText(value, limit);
  return id && !/[\u0000-\u001f\u007f]/.test(id) ? id : '';
}

function normalizeStoredAttachment(value, depth = 0) {
  const id = storedText(value?.id, 64);
  if (!/^[A-Za-z0-9_-]{32}$/.test(id)) return null;
  const attachment = {
    id,
    url: `/api/media/${id}`,
    mimeType: storedText(value.mimeType, 120),
    fileName: storedText(value.fileName, 180),
    isImage: value.isImage !== false,
    alt: storedText(value.alt, 300),
    size: Number.isSafeInteger(value.size) && value.size >= 0 ? value.size : 0,
  };
  if (depth < 1 && attachment.isImage && Array.isArray(value.upscales)) {
    attachment.upscales = value.upscales.map((item) => normalizeStoredAttachment(item, depth + 1)).filter(Boolean).slice(0, 4);
  }
  return attachment;
}

function normalizeStoredUsage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const usage = {};
  for (const key of ['promptTokens', 'completionTokens', 'totalTokens']) {
    if (Number.isSafeInteger(value[key]) && value[key] >= 0 && value[key] <= 1_000_000_000_000) usage[key] = value[key];
  }
  return Object.keys(usage).length ? usage : null;
}

function normalizeStoredMessage(value, depth = 0) {
  if (!value || !['user', 'assistant'].includes(value.role)) return null;
  const variants = value.role === 'assistant' && Array.isArray(value.variants)
    ? value.variants.map((item) => normalizeStoredVariant(item, depth)).filter(Boolean).slice(0, MAX_ADMIN_HISTORY_VARIANTS)
    : [];
  const variantIndex = Number.isInteger(value.variantIndex) && value.variantIndex >= 0 && value.variantIndex < variants.length
    ? value.variantIndex
    : Math.max(0, variants.length - 1);
  return {
    id: storedId(value.id) || crypto.randomUUID(),
    role: value.role,
    content: storedText(value.content, MAX_ADMIN_HISTORY_TEXT_CHARS),
    reasoning: storedText(value.reasoning, MAX_ADMIN_HISTORY_TEXT_CHARS),
    modelId: storedText(value.modelId, 200),
    mode: ['chat', 'image'].includes(value.mode) ? value.mode : '',
    replyToId: value.role === 'assistant' ? storedId(value.replyToId) : '',
    attachments: Array.isArray(value.attachments) ? value.attachments.map((item) => normalizeStoredAttachment(item)).filter(Boolean).slice(0, MAX_ADMIN_HISTORY_ATTACHMENTS) : [],
    images: Array.isArray(value.images) ? value.images.map((item) => normalizeStoredAttachment(item)).filter(Boolean).slice(0, MAX_ADMIN_HISTORY_ATTACHMENTS) : [],
    usage: normalizeStoredUsage(value.usage),
    variants,
    variantIndex,
    createdAt: storedTimestamp(value.createdAt),
  };
}

function normalizeStoredVariant(value, depth = 0) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return {
    modelId: storedText(value.modelId, 200),
    mode: ['chat', 'image'].includes(value.mode) ? value.mode : 'chat',
    content: storedText(value.content, MAX_ADMIN_HISTORY_TEXT_CHARS),
    reasoning: storedText(value.reasoning, MAX_ADMIN_HISTORY_TEXT_CHARS),
    attachments: Array.isArray(value.attachments) ? value.attachments.map((item) => normalizeStoredAttachment(item)).filter(Boolean).slice(0, MAX_ADMIN_HISTORY_ATTACHMENTS) : [],
    images: Array.isArray(value.images) ? value.images.map((item) => normalizeStoredAttachment(item)).filter(Boolean).slice(0, MAX_ADMIN_HISTORY_ATTACHMENTS) : [],
    usage: normalizeStoredUsage(value.usage),
    createdAt: storedTimestamp(value.createdAt),
    continuation: depth < MAX_ADMIN_HISTORY_DEPTH && Array.isArray(value.continuation)
      ? value.continuation.map((item) => normalizeStoredMessage(item, depth + 1)).filter(Boolean).slice(0, MAX_ADMIN_HISTORY_MESSAGES)
      : [],
  };
}

function normalizeStoredConversation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !storedId(value.id) || !Array.isArray(value.messages)) return null;
  const messages = value.messages.map((item) => normalizeStoredMessage(item)).filter(Boolean).slice(0, MAX_ADMIN_HISTORY_MESSAGES);
  return {
    id: storedId(value.id),
    title: storedText(value.title, 80) || '新对话',
    titleCustomized: value.titleCustomized === true,
    createdAt: storedTimestamp(value.createdAt),
    updatedAt: storedTimestamp(value.updatedAt),
    roleId: /^[A-Za-z0-9_-]{3,64}$/.test(storedText(value.roleId, 64)) ? value.roleId : '',
    workflowId: /^[A-Za-z0-9_-]{3,64}$/.test(storedText(value.workflowId, 64)) ? value.workflowId : '',
    folderId: /^[A-Za-z0-9_-]{3,64}$/.test(storedText(value.folderId, 64)) ? value.folderId : '',
    copiedFromConversationId: storedId(value.copiedFromConversationId),
    favoriteOrder: Number.isSafeInteger(value.favoriteOrder) && value.favoriteOrder >= 0 && value.favoriteOrder < MAX_ADMIN_CONVERSATIONS ? value.favoriteOrder : null,
    lastRequest: value.lastRequest && typeof value.lastRequest === 'object' && ['chat', 'image'].includes(value.lastRequest.mode) && storedText(value.lastRequest.modelId, 200)
      ? { modelId: storedText(value.lastRequest.modelId, 200), mode: value.lastRequest.mode, imageSize: storedText(value.lastRequest.imageSize, 40), imageQuality: storedText(value.lastRequest.imageQuality, 20), stream: value.lastRequest.stream !== false }
      : null,
    messages,
  };
}

function normalizeAdminConversations(value) {
  const list = Array.isArray(value) ? value : value?.conversations;
  if (!Array.isArray(list) || list.length > MAX_ADMIN_CONVERSATIONS) throw publicError(400, '管理员会话记录格式无效', 'INVALID_CONVERSATION_HISTORY');
  const conversations = new Map();
  for (const item of list) {
    const conversation = normalizeStoredConversation(item);
    if (!conversation || conversations.has(conversation.id)) throw publicError(400, '管理员会话记录格式无效', 'INVALID_CONVERSATION_HISTORY');
    conversations.set(conversation.id, conversation);
  }
  return [...conversations.values()].sort((left, right) => right.updatedAt - left.updatedAt);
}

function mergeAdminConversations(serverConversations, incomingConversations) {
  const merged = new Map(serverConversations.map((conversation) => [conversation.id, conversation]));
  for (const conversation of incomingConversations) {
    const existing = merged.get(conversation.id);
    if (!existing || conversation.updatedAt >= existing.updatedAt) merged.set(conversation.id, conversation);
  }
  return [...merged.values()].sort((left, right) => right.updatedAt - left.updatedAt).slice(0, MAX_ADMIN_CONVERSATIONS);
}

function imageCreditCost(modelId) {
  return /gemini.*flash.*image/i.test(String(modelId || '')) ? 1 : 5;
}

function fencedPromptBlocks(value) {
  return [...value.matchAll(/```(?:markdown|text)?\s*\n([\s\S]*?)```/gi)]
    .map((match) => match[1].trim())
    .filter(Boolean);
}

function chineseCharacterCount(value) {
  return (value.match(/[\u3400-\u9fff]/g) || []).length;
}

function posterChinesePrompt(value) {
  const blocks = fencedPromptBlocks(value);
  const chineseBlock = blocks
    .map((block) => ({ block, chinese: chineseCharacterCount(block) }))
    .filter(({ chinese }) => chinese >= 12)
    .sort((left, right) => right.chinese - left.chinese)[0]?.block;
  if (chineseBlock) return chineseBlock;

  const labelled = /(?:^|\n)\s*(?:\*{0,2}(?:中文版|中文(?:绘图|生图)?提示词)\*{0,2}\s*[：:]?)([\s\S]*?)(?=\n\s*(?:\*{0,2}(?:英文版|英文(?:绘图|生图)?提示词)\*{0,2}\s*[：:]?)|$)/i.exec(value)?.[1]?.trim();
  return labelled && chineseCharacterCount(labelled) >= 12 ? labelled : '';
}

function workflowTextCandidates(value, output = {}) {
  const fullResponse = String(value || '').trim();
  if (!fullResponse) return { primary: '', fallback: '' };
  const mode = output?.mode || 'full';
  if (mode === 'full') return { primary: fullResponse, fallback: '' };
  if (mode === 'poster-chinese') {
    const primary = posterChinesePrompt(fullResponse) || fullResponse;
    return { primary, fallback: primary === fullResponse ? '' : fullResponse };
  }
  if (mode === 'between') {
    const start = String(output.startMarker || '');
    const end = String(output.endMarker || '');
    const startAt = fullResponse.indexOf(start);
    const from = startAt >= 0 ? startAt + start.length : -1;
    const endAt = from >= 0 ? fullResponse.indexOf(end, from) : -1;
    const extracted = from >= 0 && endAt > from ? fullResponse.slice(from, endAt).trim() : '';
    // A failed extraction must never fall back to the user's raw request. The
    // text model's complete response is the only safe fallback prompt.
    const primary = extracted || fullResponse;
    return { primary, fallback: extracted && extracted !== fullResponse ? fullResponse : '' };
  }
  return { primary: '', fallback: '' };
}

export function workflowImagePromptCandidates(chatText, workflowId = '') {
  return workflowTextCandidates(chatText, { mode: workflowId === 'epic-poster-v3' ? 'poster-chinese' : 'full' });
}

function workflowImageNode(workflow) { return workflow?.nodes?.find((node) => node.type === 'image') || null; }

function workflowSummary(workflow) {
  const image = workflowImageNode(workflow);
  return {
    id: workflow.id,
    name: workflow.name,
    description: workflow.description,
    defaultSize: image?.size || '1792x1024',
    defaultQuality: image?.quality || 'high',
    imageModel: image?.model || 'gpt-image-2',
    allowImageModelOverride: image?.allowUserModelOverride !== false,
    allowImageSizeOverride: image?.allowUserSizeOverride !== false,
    allowImageQualityOverride: image?.allowUserQualityOverride !== false,
  };
}

function workflowText(value, limit) { return typeof value === 'string' ? value.trim().slice(0, limit) : ''; }
function workflowIdentifier(value) { return typeof value === 'string' && /^[A-Za-z0-9_-]{3,64}$/.test(value) ? value : ''; }

function workflowPosition(value, index) {
  const fallback = { x: 300 + index * 360, y: 140 };
  const x = Number(value?.x); const y = Number(value?.y);
  return {
    x: Number.isFinite(x) ? Math.round(Math.min(3_000, Math.max(24, x))) : fallback.x,
    y: Number.isFinite(y) ? Math.round(Math.min(2_000, Math.max(24, y))) : fallback.y,
  };
}

function legacyWorkflowEdges(workflow, nodes) {
  if (Array.isArray(workflow?.edges)) return workflow.edges;
  return nodes.map((node, index) => ({
    id: `edge-${index + 1}`,
    from: node.type === 'image' ? node?.promptFrom : node?.inputFrom,
    to: node?.id,
  }));
}

function workflowTopologicalOrder(nodes, edges) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const indegree = new Map(nodes.map((node) => [node.id, 0]));
  const outgoing = new Map(nodes.map((node) => [node.id, []]));
  for (const edge of edges) {
    if (edge.from === 'user') continue;
    indegree.set(edge.to, (indegree.get(edge.to) || 0) + 1);
    outgoing.get(edge.from)?.push(edge.to);
  }
  const queue = nodes.filter((node) => indegree.get(node.id) === 0);
  const ordered = [];
  while (queue.length) {
    const node = queue.shift(); ordered.push(node);
    for (const target of outgoing.get(node.id) || []) {
      const next = (indegree.get(target) || 0) - 1;
      indegree.set(target, next);
      if (next === 0) queue.push(byId.get(target));
    }
  }
  return ordered.length === nodes.length ? ordered : null;
}

function workflowNodeInput(node, edges, outputs) {
  const parts = edges.filter((edge) => edge.to === node.id).sort((left, right) => left.order - right.order).map((edge) => ({ edge, value: outputs.get(edge.from) }));
  if (!parts.length || parts.some((part) => typeof part.value !== 'string')) return '';
  const combined = parts.map(({ value }) => value).join(node.separator || '\n\n');
  if (node.type === 'merge') {
    if (node.mergeMode !== 'template') return combined;
    const byKey = new Map(parts.map(({ edge, value }) => [edge.inputKey, value]));
    return node.template.replace(/\{\{([A-Za-z0-9_-]+)\}\}/g, (_match, key) => key === 'all' ? combined : (byKey.get(key) || '')).trim();
  }
  if (parts.length === 1) return parts[0].value;
  return node.inputMerge === 'labeled'
    ? parts.map(({ edge, value }) => `【${edge.from === 'user' ? '用户原始输入' : edge.from}】\n${value}`).join('\n\n')
    : parts.map(({ value }) => value).join('\n\n');
}

function validateWorkflowOutput(value) {
  const mode = value?.mode === undefined ? 'full' : value?.mode;
  if (!['full', 'poster-chinese', 'between'].includes(mode)) throw publicError(400, '工作流输出提取方式无效', 'INVALID_WORKFLOW');
  const startMarker = workflowText(value?.startMarker, 120);
  const endMarker = workflowText(value?.endMarker, 120);
  if (mode === 'between' && (!startMarker || !endMarker || startMarker === endMarker)) throw publicError(400, '标记提取需要不同的开始与结束标记', 'INVALID_WORKFLOW');
  return { mode, ...(mode === 'between' ? { startMarker, endMarker } : {}) };
}

function validateWorkflowDefinitions(input, models, roleLibrary) {
  const list = Array.isArray(input) ? input : input?.workflows;
  if (!Array.isArray(list) || list.length < 1 || list.length > MAX_WORKFLOWS) throw publicError(400, '工作流配置格式无效', 'INVALID_WORKFLOW');
  const ids = new Set();
  const modelMap = new Map(models.map((model) => [model.id, model]));
  return list.map((workflow) => {
    const id = workflowIdentifier(workflow?.id);
    const name = workflowText(workflow?.name, 60);
    const description = workflowText(workflow?.description, 220);
    const nodes = Array.isArray(workflow?.nodes) ? workflow.nodes : [];
    if (!id || ids.has(id) || !name || !description || nodes.length < 2 || nodes.length > MAX_WORKFLOW_NODES) throw publicError(400, '工作流配置格式无效', 'INVALID_WORKFLOW');
    ids.add(id);
    const nodeIds = new Set();
    const normalizedNodes = nodes.map((node, index) => {
      const nodeId = workflowIdentifier(node?.id);
      const type = node?.type;
      if (!nodeId || nodeId === 'user' || nodeIds.has(nodeId) || !['role', 'temporary', 'merge', 'image'].includes(type)) throw publicError(400, '工作流节点配置无效', 'INVALID_WORKFLOW_NODE');
      nodeIds.add(nodeId);
      if (type === 'image') {
        const model = modelMap.get(node?.model);
        const size = node?.size;
        const quality = node?.quality;
        if (!model?.modes.includes('image') || !ALLOWED_IMAGE_SIZES.has(size) || !ALLOWED_IMAGE_QUALITIES.has(quality)) throw publicError(400, '生图节点配置无效', 'INVALID_WORKFLOW_NODE');
        const options = model.imageOptions || {};
        if (Array.isArray(options.sizes) && !options.sizes.includes(size)) throw publicError(400, '生图节点尺寸无效', 'INVALID_WORKFLOW_NODE');
        if (Array.isArray(options.qualities) && !options.qualities.includes(quality)) throw publicError(400, '生图节点质量无效', 'INVALID_WORKFLOW_NODE');
        return {
          id: nodeId, type, model: model.id, output: validateWorkflowOutput(node.output), size, quality, position: workflowPosition(node.position, index),
          allowUserModelOverride: node.allowUserModelOverride !== false,
          allowUserSizeOverride: node.allowUserSizeOverride !== false,
          allowUserQualityOverride: node.allowUserQualityOverride !== false,
        };
      }
      if (type === 'merge') {
        const mergeMode = node?.mergeMode === 'template' ? 'template' : 'join';
        const separator = workflowText(node?.separator, 1_000) || '\n\n';
        const template = workflowText(node?.template, 4_000);
        if (mergeMode === 'template' && !template) throw publicError(400, '模板合并节点必须填写模板', 'INVALID_WORKFLOW_NODE');
        return { id: nodeId, type, mergeMode, separator, template, position: workflowPosition(node.position, index) };
      }
      const model = modelMap.get(node?.model);
      const inputTemplate = workflowText(node?.inputTemplate, 4_000) || '{{input}}';
      const inputMerge = node?.inputMerge === 'labeled' ? 'labeled' : 'plain';
      if (!model?.modes.includes('chat')) throw publicError(400, '文本节点配置无效', 'INVALID_WORKFLOW_NODE');
      const common = { id: nodeId, type, model: model.id, inputTemplate, inputMerge, output: validateWorkflowOutput(node.output), position: workflowPosition(node.position, index) };
      if (type === 'role') {
        const roleId = workflowIdentifier(node?.roleId);
        if (!roleId || !findRole(roleLibrary, roleId)) throw publicError(400, '工作流引用的角色卡不存在', 'WORKFLOW_ROLE_NOT_FOUND');
        return { ...common, roleId };
      }
      const systemPrompt = workflowText(node?.systemPrompt, 120_000);
      if (!systemPrompt) throw publicError(400, '临时节点必须填写系统提示词', 'INVALID_WORKFLOW_NODE');
      return { ...common, systemPrompt };
    });
    const imageNodes = normalizedNodes.filter((node) => node.type === 'image');
    if (imageNodes.length !== 1) throw publicError(400, '工作流必须且只能包含一个最终生图节点', 'INVALID_WORKFLOW_NODE');
    const rawEdges = legacyWorkflowEdges(workflow, nodes);
    if (!Array.isArray(rawEdges) || rawEdges.length < 1 || rawEdges.length > MAX_WORKFLOW_EDGES) throw publicError(400, '工作流连线数量无效', 'INVALID_WORKFLOW_EDGE');
    const edgeIds = new Set(); const pairIds = new Set();
    const edges = rawEdges.map((edge, index) => {
      const edgeId = workflowIdentifier(edge?.id) || `edge-${index + 1}`;
      const from = edge?.from === 'user' ? 'user' : workflowIdentifier(edge?.from);
      const to = workflowIdentifier(edge?.to);
      if (!from || !to || edgeIds.has(edgeId) || pairIds.has(`${from}\0${to}`) || !nodeIds.has(to) || (from !== 'user' && !nodeIds.has(from)) || from === to) throw publicError(400, '工作流连线无效', 'INVALID_WORKFLOW_EDGE');
      const source = from === 'user' ? null : normalizedNodes.find((node) => node.id === from);
      const target = normalizedNodes.find((node) => node.id === to);
      if (source?.type === 'image' || !target) throw publicError(400, '生图节点不能作为后续节点输入', 'INVALID_WORKFLOW_EDGE');
      edgeIds.add(edgeId); pairIds.add(`${from}\0${to}`);
      return { id: edgeId, from, to, inputKey: workflowIdentifier(edge?.inputKey) || from, order: Number.isSafeInteger(edge?.order) && edge.order >= 0 && edge.order < MAX_WORKFLOW_NODES ? edge.order : index };
    });
    const incoming = new Map(normalizedNodes.map((node) => [node.id, 0]));
    for (const edge of edges) incoming.set(edge.to, (incoming.get(edge.to) || 0) + 1);
    if ([...incoming.values()].some((count) => count === 0)) throw publicError(400, '每个节点都需要至少一条输入连线', 'INVALID_WORKFLOW_EDGE');
    for (const node of normalizedNodes) {
      const inputEdges = edges.filter((edge) => edge.to === node.id);
      if (node.type !== 'merge' && inputEdges.length > 1) throw publicError(400, '角色卡、临时节点和生图节点各只能有一条输入连线，请使用合并节点', 'INVALID_WORKFLOW_EDGE');
      if (node.type === 'merge') {
        const inputKeys = inputEdges.map((edge) => edge.inputKey);
        if (new Set(inputKeys).size !== inputKeys.length) throw publicError(400, '合并节点的输入引用名称不能重复', 'INVALID_WORKFLOW_EDGE');
        if (node.mergeMode === 'template') {
          const referencedKeys = [...node.template.matchAll(/\{\{([A-Za-z0-9_-]+)\}\}/g)].map((match) => match[1]).filter((key) => key !== 'all');
          if (referencedKeys.some((key) => !inputKeys.includes(key))) throw publicError(400, '合并模板引用了不存在的输入名称', 'INVALID_WORKFLOW_NODE');
        }
      }
    }
    if (edges.some((edge) => edge.from === imageNodes[0].id)) throw publicError(400, '最终生图节点不能有输出连线', 'INVALID_WORKFLOW_EDGE');
    const order = workflowTopologicalOrder(normalizedNodes, edges);
    if (!order || order.at(-1)?.id !== imageNodes[0].id) throw publicError(400, '工作流连线存在环路或最终节点错误', 'INVALID_WORKFLOW_EDGE');
    const reachable = new Set(['user']);
    for (let changed = true; changed;) {
      changed = false;
      for (const edge of edges) if (reachable.has(edge.from) && !reachable.has(edge.to)) { reachable.add(edge.to); changed = true; }
    }
    if (normalizedNodes.some((node) => !reachable.has(node.id))) throw publicError(400, '工作流存在未连接到用户输入的节点', 'INVALID_WORKFLOW_EDGE');
    const feedsImage = new Set([imageNodes[0].id]);
    for (let changed = true; changed;) {
      changed = false;
      for (const edge of edges) if (feedsImage.has(edge.to) && edge.from !== 'user' && !feedsImage.has(edge.from)) { feedsImage.add(edge.from); changed = true; }
    }
    if (normalizedNodes.some((node) => !feedsImage.has(node.id))) throw publicError(400, '工作流存在未连接到最终生图节点的节点', 'INVALID_WORKFLOW_EDGE');
    if (!normalizedNodes.some((node) => node.type === 'role' || node.type === 'temporary')) throw publicError(400, '工作流至少需要一个角色卡或临时提示词节点', 'INVALID_WORKFLOW_NODE');
    return { id, name, description, enabled: workflow?.enabled !== false, nodes: normalizedNodes, edges };
  });
}

function applyWorkflowInputTemplate(template, input, userPrompt) {
  return String(template || '{{input}}')
    .replaceAll('{{input}}', input)
    .replaceAll('{{userPrompt}}', userPrompt)
    .trim();
}

function imageRequestOptions(body, selectedModel) {
  const imageOptions = selectedModel.imageOptions || {};
  const count = body.count === undefined ? 1 : Number(body.count);
  const size = body.size === undefined ? (imageOptions.defaultSize || '1024x1024') : body.size;
  const quality = body.quality === undefined ? (imageOptions.defaultQuality || 'high') : body.quality;
  const supportedSizes = Array.isArray(imageOptions.sizes) ? imageOptions.sizes : [...ALLOWED_IMAGE_SIZES];
  const supportedQualities = Array.isArray(imageOptions.qualities) ? imageOptions.qualities : [...ALLOWED_IMAGE_QUALITIES];
  const maxCount = Number.isInteger(imageOptions.maxCount) ? imageOptions.maxCount : 2;
  if (
    !ALLOWED_IMAGE_SIZES.has(size)
    || !supportedSizes.includes(size)
    || !ALLOWED_IMAGE_QUALITIES.has(quality)
    || !supportedQualities.includes(quality)
    || !Number.isInteger(count)
    || count < 1
    || count > maxCount
  ) {
    throw publicError(400, '生图参数无效', 'INVALID_IMAGE_OPTIONS');
  }
  return { count, size, quality };
}

function estimateTextTokens(value) {
  let asciiChars = 0;
  let nonAsciiChars = 0;
  for (const character of value) {
    if (character.codePointAt(0) <= 0x7f) asciiChars += 1;
    else nonAsciiChars += 1;
  }
  return Math.ceil(asciiChars / 4) + nonAsciiChars;
}

function modelContextLimit(preferences, modelId) {
  return preferences.modelContextLimits?.[modelId] || DEFAULT_CONTEXT_TOKENS;
}

function requireImagePrompt(body) {
  if (typeof body?.prompt !== 'string' || !body.prompt.trim()) {
    throw publicError(400, '请输入生图提示词', 'INVALID_PROMPT');
  }
  return body.prompt;
}

function generatedConversationTitle(value) {
  return String(value || '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/^\s*(?:标题|title)\s*[：:]\s*/i, '')
    .replace(/^[“”"'`]+|[“”"'`]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

function requirePromptWithinContext(prompt, contextLimit) {
  const estimatedTokens = estimateTextTokens(prompt);
  if (estimatedTokens > contextLimit) {
    throw publicError(
      400,
      `生图提示词预计占用 ${estimatedTokens}/${contextLimit} token，请精简提示词或调整该模型的上下文上限`,
      'CONTEXT_LIMIT_EXCEEDED',
    );
  }
}

async function validateConversation(messages, mediaStore, pdfTextExtractor, sessionId, systemPrompt = '', contextLimit = DEFAULT_CONTEXT_TOKENS) {
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > MAX_MESSAGES) {
    throw publicError(400, '对话记录数量无效', 'INVALID_MESSAGES');
  }
  const systemTokens = estimateTextTokens(systemPrompt);
  const normalized = [];
  for (const message of messages) {
    if (!message || !['user', 'assistant'].includes(message.role)) {
      throw publicError(400, '对话角色无效', 'INVALID_MESSAGES');
    }
    const content = typeof message.content === 'string' ? message.content : '';
    if (/\0/.test(content)) throw publicError(400, '单条消息格式无效', 'INVALID_MESSAGES');
    const ids = message.attachmentIds === undefined ? [] : message.attachmentIds;
    const imageIds = message.imageIds === undefined ? [] : message.imageIds;
    if (!Array.isArray(ids) || ids.length > MAX_ATTACHMENTS || ids.some((id) => typeof id !== 'string') || (message.role !== 'user' && ids.length > 0)) {
      throw publicError(400, '文件附件格式无效', 'INVALID_ATTACHMENTS');
    }
    if (!Array.isArray(imageIds) || imageIds.length > MAX_CONTEXT_IMAGES || imageIds.some((id) => typeof id !== 'string')) {
      throw publicError(400, '历史图片格式无效', 'INVALID_ATTACHMENTS');
    }
    if (!content.trim() && ids.length === 0 && imageIds.length === 0) throw publicError(400, '消息不能为空', 'EMPTY_MESSAGE');
    normalized.push({ role: message.role, content, ids, imageIds, pdfTexts: new Map(), estimatedTokens: estimateTextTokens(content) });
  }
  if (normalized.at(-1).role !== 'user') throw publicError(400, '最后一条消息必须来自用户', 'INVALID_MESSAGES');

  const attachmentReferences = [];
  const imageReferences = [];
  for (const [index, message] of normalized.entries()) {
    const isLatestMessage = index === normalized.length - 1;
    // Historical files may have been removed by an older cleanup policy, so omit
    // only those stale references. A newly submitted missing or foreign ID remains
    // a 404 instead of silently turning the request into a text-only prompt.
    message.ids = message.ids.filter((id) => {
      const record = mediaStore.get(id, sessionId, { kind: 'upload' });
      if (!record && isLatestMessage) throw publicError(404, '附件不存在或已过期', 'MEDIA_NOT_FOUND');
      return Boolean(record);
    });
    message.imageIds = message.imageIds.filter((id) => {
      const record = mediaStore.get(id, sessionId, { kind: 'output' });
      if (!record && isLatestMessage) throw publicError(404, '附件不存在或已过期', 'MEDIA_NOT_FOUND');
      return Boolean(record);
    });
    message.ids.forEach((id, attachmentIndex) => {
      const record = mediaStore.get(id, sessionId, { kind: 'upload' });
      attachmentReferences.push({ message, index: attachmentIndex, isImage: record?.isImage === true });
    });
    message.imageIds.forEach((id, imageIndex) => imageReferences.push({ message, index: imageIndex }));
  }
  let attachmentCount = attachmentReferences.length;
  for (const reference of attachmentReferences) {
    if (attachmentCount <= MAX_ATTACHMENTS) break;
    if (!reference.isImage || reference.message.ids[reference.index] === null) continue;
    reference.message.ids[reference.index] = null;
    attachmentCount -= 1;
  }
  for (const message of normalized) message.ids = message.ids.filter((id) => id !== null);
  if (attachmentCount > MAX_ATTACHMENTS) throw publicError(400, '每次最多携带 8 个附件', 'TOO_MANY_ATTACHMENTS');

  for (const message of normalized) {
    for (const id of message.ids) {
      const record = mediaStore.get(id, sessionId, { kind: 'upload' });
      if (record?.mimeType !== 'application/pdf') continue;
      const text = await pdfTextExtractor.extract(record);
      message.pdfTexts.set(id, text);
      message.estimatedTokens += estimateTextTokens(text);
    }
  }

  let contextImageCount = imageReferences.length;
  for (const reference of imageReferences) {
    if (contextImageCount <= MAX_CONTEXT_IMAGES) break;
    if (reference.message.imageIds[reference.index] === null) continue;
    reference.message.imageIds[reference.index] = null;
    contextImageCount -= 1;
  }
  for (const message of normalized) message.imageIds = message.imageIds.filter((id) => id !== null);

  const latest = normalized.at(-1);
  if (systemTokens + latest.estimatedTokens > contextLimit) {
    throw publicError(400, `本次消息与系统提示词预计占用 ${systemTokens + latest.estimatedTokens}/${contextLimit} token，请精简本次输入或调整该模型的上下文上限`, 'CONTEXT_LIMIT_EXCEEDED');
  }

  let retainedStart = normalized.length - 1;
  let retainedTokens = systemTokens + latest.estimatedTokens;
  for (let index = normalized.length - 2; index >= 0; index -= 1) {
    if (retainedTokens + normalized[index].estimatedTokens > contextLimit) break;
    retainedStart = index;
    retainedTokens += normalized[index].estimatedTokens;
  }
  while (retainedStart < normalized.length - 1 && normalized[retainedStart].role === 'assistant') retainedStart += 1;

  let contextMediaBytes = 0;
  let retainedAttachmentCount = 0;
  let retainedContextImageCount = 0;
  const upstream = systemPrompt ? [{ role: 'system', content: systemPrompt }] : [];
  for (const message of normalized.slice(retainedStart)) {
    const { content, ids, imageIds } = message;
    retainedAttachmentCount += ids.length;
    retainedContextImageCount += imageIds.length;
    if (retainedAttachmentCount > MAX_ATTACHMENTS) throw publicError(400, '每次最多携带 8 个附件', 'TOO_MANY_ATTACHMENTS');
    if (retainedContextImageCount > MAX_CONTEXT_IMAGES) throw publicError(400, '历史上下文最多携带 12 张图片', 'TOO_MANY_ATTACHMENTS');
    if (ids.length === 0 && imageIds.length === 0) {
      upstream.push({ role: message.role, content });
      continue;
    }
    const parts = [];
    if (content.trim()) parts.push({ type: 'text', text: content });
    for (const id of ids) {
      const { record, buffer } = await mediaStore.read(id, sessionId, { kind: 'upload' });
      contextMediaBytes += buffer.length;
      if (record.isImage) {
        const dataUri = `data:${record.mimeType};base64,${buffer.toString('base64')}`;
        parts.push({ type: 'image_url', image_url: { url: dataUri } });
      } else if (record.mimeType === 'application/pdf') {
        const pdfText = message.pdfTexts.get(id);
        parts.push({ type: 'text', text: `[PDF attachment converted locally: ${record.fileName}]\n--- BEGIN PDF TEXT ---\n${pdfText}\n--- END PDF TEXT ---` });
      } else {
        const dataUri = `data:${record.mimeType};base64,${buffer.toString('base64')}`;
        parts.push({ type: 'file', file: { filename: record.fileName, file_data: dataUri } });
      }
    }
    for (const id of imageIds) {
      const { record, buffer } = await mediaStore.read(id, sessionId);
      if (!record.isImage) throw publicError(400, '历史引用中包含非图片附件', 'INVALID_ATTACHMENTS');
      contextMediaBytes += buffer.length;
      const dataUri = `data:${record.mimeType};base64,${buffer.toString('base64')}`;
      parts.push({ type: 'image_url', image_url: { url: dataUri } });
    }
    if (contextMediaBytes > MAX_CONTEXT_MEDIA_BYTES) throw publicError(413, '历史图片总大小超过 50 MB', 'CONTEXT_MEDIA_TOO_LARGE');
    upstream.push({ role: message.role, content: parts });
  }
  return upstream;
}

function chunkText(text, maxChars = 180) {
  const chunks = [];
  let offset = 0;
  while (offset < text.length) {
    let end = Math.min(text.length, offset + maxChars);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end -= 1;
    chunks.push(text.slice(offset, end));
    offset = end;
  }
  return chunks;
}

export async function createChatApp({
  rootDir,
  publicDir = join(rootDir, 'public'),
  dataDir = join(rootDir, '.data'),
  apiKey,
  bootstrapUsername,
  bootstrapPassword,
  sessionSecret,
  port = 3020,
  trustProxy = false,
  allowedHosts: configuredHosts = [],
  newApiBaseUrl = 'http://127.0.0.1:3002/v1',
  fetchImpl = fetch,
  pdfTextExtractor: configuredPdfTextExtractor = null,
  imageUpscaler: configuredImageUpscaler = null,
} = {}) {
  if (!rootDir || !apiKey || !bootstrapUsername || !bootstrapPassword || !sessionSecret) {
    throw new Error('缺少必要的服务端配置');
  }
  await mkdir(dataDir, { recursive: true });
  const accountStore = new AccountStore(join(dataDir, 'account.json'));
  await accountStore.initialize(bootstrapUsername, bootstrapPassword);
  const loginLimiter = new LoginLimiter(join(dataDir, 'login-rate-limits.json'));
  await loginLimiter.initialize();
  const preferencesStore = new JsonStore(join(dataDir, 'preferences.json'), { version: 1, favoriteGroups: [], selected: null, modelContextLimits: {}, favoriteMediaIds: [] });
  const rolesStore = new JsonStore(join(dataDir, 'roles.json'), EMPTY_ROLE_LIBRARY);
  const workflowsStore = new JsonStore(join(dataDir, 'workflows.json'), structuredClone(DEFAULT_WORKFLOW_DATA));
  const adminConversationStore = new JsonStore(join(dataDir, 'conversations-00000.json'), { version: 1, conversations: [] });
  let preferences = await preferencesStore.load();
  if (preferences?.version === 1 && Array.isArray(preferences.favorites) && !Array.isArray(preferences.favoriteGroups)) {
    preferences = await preferencesStore.save({
      version: 1,
      favoriteGroups: preferences.favorites.length
        ? [{ id: 'favorites', name: '收藏', items: preferences.favorites }]
        : [],
      selected: null,
      modelContextLimits: {}, favoriteMediaIds: [],
    });
  }
  if (preferences?.version !== 1 || !Array.isArray(preferences.favoriteGroups)) {
    preferences = await preferencesStore.save({ version: 1, favoriteGroups: [], selected: null, modelContextLimits: {}, favoriteMediaIds: [] });
  } else if (!preferences.modelContextLimits || typeof preferences.modelContextLimits !== 'object' || Array.isArray(preferences.modelContextLimits) || !Array.isArray(preferences.favoriteMediaIds)) {
    preferences = await preferencesStore.save({ ...preferences, modelContextLimits: preferences.modelContextLimits && typeof preferences.modelContextLimits === 'object' && !Array.isArray(preferences.modelContextLimits) ? preferences.modelContextLimits : {}, favoriteMediaIds: Array.isArray(preferences.favoriteMediaIds) ? preferences.favoriteMediaIds : [] });
  }
  let roleLibrary = validateRoleLibrary(await rolesStore.load());
  let adminConversationData;
  try {
    adminConversationData = { version: 1, conversations: normalizeAdminConversations(await adminConversationStore.load()) };
  } catch {
    adminConversationData = { version: 1, conversations: [] };
    await adminConversationStore.save(adminConversationData);
  }
  const preferenceEntries = new Map([['00000', { store: preferencesStore, value: preferences }]]);
  const roleEntries = new Map([['00000', { store: rolesStore, value: roleLibrary }]]);
  let workflowData;
  async function preferencesFor(uid) {
    if (preferenceEntries.has(uid)) return preferenceEntries.get(uid).value;
    const store = new JsonStore(join(dataDir, `preferences-${uid}.json`), { version: 1, favoriteGroups: [], selected: null, modelContextLimits: {}, favoriteMediaIds: [] });
    let value = await store.load();
    if (value?.version !== 1 || !Array.isArray(value.favoriteGroups)) value = await store.save({ version: 1, favoriteGroups: [], selected: null, modelContextLimits: {}, favoriteMediaIds: [] });
    if (!value.modelContextLimits || typeof value.modelContextLimits !== 'object' || Array.isArray(value.modelContextLimits) || !Array.isArray(value.favoriteMediaIds)) value = await store.save({ ...value, modelContextLimits: value.modelContextLimits && typeof value.modelContextLimits === 'object' && !Array.isArray(value.modelContextLimits) ? value.modelContextLimits : {}, favoriteMediaIds: Array.isArray(value.favoriteMediaIds) ? value.favoriteMediaIds : [] });
    preferenceEntries.set(uid, { store, value }); return value;
  }
  async function savePreferencesFor(uid, value) {
    await preferencesFor(uid); const entry = preferenceEntries.get(uid); entry.value = await entry.store.save(value); return entry.value;
  }
  async function rolesFor(uid) {
    if (roleEntries.has(uid)) return roleEntries.get(uid).value;
    const store = new JsonStore(join(dataDir, `roles-${uid}.json`), EMPTY_ROLE_LIBRARY);
    const value = validateRoleLibrary(await store.load()); roleEntries.set(uid, { store, value }); return value;
  }
  async function saveRolesFor(uid, value) {
    if (uid === '00000' && workflowData) {
      const roleIds = new Set(value.folders.flatMap((folder) => folder.roles.map((role) => role.id)));
      const missing = workflowData.workflows.flatMap((workflow) => workflow.nodes).find((node) => node.type === 'role' && !roleIds.has(node.roleId));
      if (missing) throw publicError(400, '该角色卡仍被工作流引用，请先在工作流管理中替换或删除对应节点', 'WORKFLOW_ROLE_IN_USE');
    }
    await rolesFor(uid); const entry = roleEntries.get(uid); entry.value = await entry.store.save(value); return entry.value;
  }
  const sessionManager = new SessionManager({ secret: sessionSecret, trustProxy, storagePath: join(dataDir, 'sessions.json') });
  await sessionManager.initialize();
  const mediaStore = new MediaStore(join(dataDir, 'media'), { defaultOwnerId: accountStore.uid });
  await mediaStore.initialize();
  async function recoverAdminConversationMedia(conversations) {
    let recovered = 0;
    const recoverCollection = async (items, kind) => {
      for (const item of items || []) {
        if (item?.isImage !== true || mediaStore.get(item.id, accountStore.uid)) continue;
        const source = await mediaStore.findRecoverableImage(item, accountStore.uid);
        if (await mediaStore.restoreImageAlias(item.id, source, { sessionId: accountStore.uid, kind, alt: item.alt, fileName: item.fileName })) recovered += 1;
        if (Array.isArray(item?.upscales)) await recoverCollection(item.upscales, 'output');
      }
    };
    const recoverMessage = async (message) => {
      await recoverCollection(message?.attachments, 'upload');
      await recoverCollection(message?.images, 'output');
      for (const variant of message?.variants || []) {
        await recoverCollection(variant.attachments, 'upload');
        await recoverCollection(variant.images, 'output');
        for (const continuation of variant.continuation || []) await recoverMessage(continuation);
      }
    };
    for (const conversation of conversations) for (const message of conversation.messages || []) await recoverMessage(message);
    return recovered;
  }
  await recoverAdminConversationMedia(adminConversationData.conversations);
  const newApi = new NewApiClient({ apiKey, baseUrl: newApiBaseUrl, fetchImpl });
  const upstreamModels = await newApi.listModels();
  try {
    const saved = await workflowsStore.load();
    workflowData = await workflowsStore.save({ version: 2, workflows: validateWorkflowDefinitions(saved, upstreamModels, roleLibrary) });
  } catch {
    workflowData = structuredClone(DEFAULT_WORKFLOW_DATA);
    await workflowsStore.save(workflowData);
  }
  const pdfTextExtractor = configuredPdfTextExtractor || new PdfTextExtractor({ scriptPath: join(rootDir, 'scripts', 'pdf-to-text.py') });
  const imageUpscaler = configuredImageUpscaler || new LocalImageUpscaler({ rootDir });
  const allowedHosts = new Set([
    `127.0.0.1:${port}`,
    `localhost:${port}`,
    `[::1]:${port}`,
    'chat.example.com',
    ...configuredHosts.map((value) => String(value).toLowerCase()),
  ]);
  const activePerSession = new Map();
  const workflowJobs = new Map();
  let activeGlobal = 0;
  let adminMutationQueue = Promise.resolve();
  let adminConversationQueue = Promise.resolve();
  const auditPath = join(dataDir, 'admin-audit.jsonl');

  async function runAdminMutation(task) {
    const run = adminMutationQueue.then(task);
    adminMutationQueue = run.catch(() => {});
    return run;
  }

  async function mergeAndSaveAdminConversations(incoming) {
    const task = adminConversationQueue.then(async () => {
      const merged = mergeAdminConversations(adminConversationData.conversations, incoming);
      await recoverAdminConversationMedia(merged);
      adminConversationData = await adminConversationStore.save({ version: 1, conversations: merged });
      return adminConversationData;
    });
    adminConversationQueue = task.catch(() => {});
    return task;
  }

  async function readAdminConversations() {
    await adminConversationQueue;
    await recoverAdminConversationMedia(adminConversationData.conversations);
    return { version: 1, conversations: adminConversationData.conversations.map((conversation) => structuredClone(conversation)) };
  }

  async function auditAdminAction(action, actorUid, targetUid = null, details = {}) {
    const safeDetails = Object.fromEntries(Object.entries(details).filter(([, value]) => ['string', 'number', 'boolean'].includes(typeof value)));
    try {
      await appendFile(auditPath, `${JSON.stringify({ at: new Date().toISOString(), action, actorUid, targetUid, details: safeDetails })}\n`, { encoding: 'utf8', mode: 0o600 });
    } catch { console.error('管理员审计日志写入失败'); }
  }

  function requireActiveAccount(req) {
    const found = sessionManager.require(req);
    const user = accountStore.getPublicUser(found.session.uid);
    if (!user || user.disabled) {
      sessionManager.invalidate(found);
      throw publicError(401, '登录已失效', 'AUTH_REQUIRED');
    }
    return { ...found, user };
  }

  function requireAdministrator(req) {
    const found = requireActiveAccount(req);
    if (found.user.role !== 'admin') throw publicError(403, '仅管理员可执行此操作', 'ADMIN_REQUIRED');
    return found;
  }

  async function modelsForUser(uid, { force = false } = {}) {
    const models = await newApi.listModels({ force });
    const allowed = accountStore.allowedModelIds(uid);
    return allowed === null ? models : models.filter((model) => allowed.has(model.id));
  }

  async function saveWorkflowDefinitions(value) {
    const models = await newApi.listModels({ force: true });
    const workflows = validateWorkflowDefinitions(value, models, roleLibrary);
    workflowData = await workflowsStore.save({ version: 2, workflows });
    return workflowData;
  }

  function publicWorkflowList() {
    return workflowData.workflows.filter((workflow) => workflow.enabled).map(workflowSummary);
  }

  function requireModelAccess(uid, modelId) {
    if (!accountStore.canUseModel(uid, modelId)) throw publicError(403, '当前账号没有使用该模型的权限', 'MODEL_ACCESS_DENIED');
  }

  function reserve(sessionId) {
    const current = activePerSession.get(sessionId) || 0;
    if (current >= MAX_CONCURRENT_PER_SESSION || activeGlobal >= MAX_CONCURRENT_GLOBAL) {
      throw publicError(503, '当前服务繁忙，请稍后重试', 'CONCURRENCY_LIMIT');
    }
    activePerSession.set(sessionId, current + 1);
    activeGlobal += 1;
    return () => {
      const next = Math.max(0, (activePerSession.get(sessionId) || 1) - 1);
      if (next === 0) activePerSession.delete(sessionId);
      else activePerSession.set(sessionId, next);
      activeGlobal = Math.max(0, activeGlobal - 1);
    };
  }

  function pruneWorkflowJobs() {
    const now = Date.now();
    for (const [id, job] of workflowJobs) {
      if (job.updatedAt + WORKFLOW_JOB_TTL_MS <= now) workflowJobs.delete(id);
    }
  }

  async function executeWorkflow({ workflow, userPrompt, imageModel, size, quality, userUid, sessionId, signal, onImage = () => {} }) {
    const imageNode = workflowImageNode(workflow);
    const executionOrder = workflowTopologicalOrder(workflow.nodes, workflow.edges || []);
    const textNodes = (executionOrder || []).filter((node) => node.type === 'role' || node.type === 'temporary');
    if (!imageNode || !executionOrder || !textNodes.length) throw publicError(500, '工作流缺少可执行节点', 'INVALID_WORKFLOW');
    const chatQuotas = [];
    let imageQuota;
    try {
      for (const _node of textNodes) chatQuotas.push(accountStore.reserveQuota(userUid, 'chat'));
      imageQuota = accountStore.reserveQuota(userUid, 'image', imageCreditCost(imageModel));
    } catch (error) {
      for (const quota of chatQuotas) quota.rollback();
      throw error;
    }
    let release;
    try { release = reserve(sessionId); } catch (error) { for (const quota of chatQuotas) quota.rollback(); imageQuota.rollback(); throw error; }
    let startedChatNodes = 0;
    let imageStarted = false;
    try {
      // Workflow text nodes intentionally reuse the ordinary role-card chat
      // path. A temporary node differs only by holding its own server-side
      // system prompt instead of a referenced role card.
      const adminRoles = await rolesFor('00000');
      const outputs = new Map([['user', userPrompt]]);
      for (const node of executionOrder) {
        if (node.type === 'image') continue;
        const source = workflowNodeInput(node, workflow.edges, outputs);
        if (typeof source !== 'string') throw publicError(500, '工作流节点输入不存在', 'WORKFLOW_INPUT_MISSING');
        if (node.type === 'merge') { outputs.set(node.id, source); continue; }
        const role = node.type === 'role' ? findRole(adminRoles, node.roleId) : null;
        if (node.type === 'role' && !role) throw publicError(500, '工作流配置的角色不存在', 'WORKFLOW_ROLE_NOT_FOUND');
        const systemPrompt = node.type === 'role' ? role.systemPrompt : node.systemPrompt;
        const nodeInput = applyWorkflowInputTemplate(node.inputTemplate, source, userPrompt);
        const chatContextLimit = modelContextLimit(await preferencesFor(userUid), node.model);
        const chatMessages = await validateConversation(
          [{ role: 'user', content: nodeInput }],
          mediaStore,
          pdfTextExtractor,
          userUid,
          systemPrompt,
          chatContextLimit,
        );
        startedChatNodes += 1;
        const chat = await newApi.chat({ model: node.model, messages: chatMessages, stream: false, signal });
        const output = workflowTextCandidates(chat.text, node.output).primary;
        if (!output) throw publicError(422, '工作流文本节点未返回可用结果', 'WORKFLOW_NODE_OUTPUT_EMPTY');
        outputs.set(node.id, output);
      }
      const promptCandidates = workflowTextCandidates(workflowNodeInput(imageNode, workflow.edges, outputs), imageNode.output);
      if (!promptCandidates.primary) {
        throw publicError(422, '角色提示词生成失败，未返回可用绘图提示词', 'WORKFLOW_PROMPT_EMPTY');
      }
      const imageContextLimit = modelContextLimit(await preferencesFor(userUid), imageModel);
      requirePromptWithinContext(promptCandidates.primary, imageContextLimit);
      imageStarted = true;
      let generated;
      try {
        generated = await newApi.generateImages({ model: imageModel, prompt: promptCandidates.primary, size, count: 1, quality, forceTool: true, signal });
      } catch (primaryError) {
        if (!promptCandidates.fallback) throw primaryError;
        requirePromptWithinContext(promptCandidates.fallback, imageContextLimit);
        generated = await newApi.generateImages({ model: imageModel, prompt: promptCandidates.fallback, size, count: 1, quality, forceTool: true, signal });
      }
      if (!generated.length) throw publicError(502, '生图模型未返回图片', 'WORKFLOW_IMAGE_EMPTY');
      const images = [];
      for (const image of generated) {
        const saved = await mediaStore.save(image.buffer, { sessionId: userUid, kind: 'output', alt: workflow.name });
        images.push(saved);
        onImage(saved);
      }
      for (const quota of chatQuotas) await quota.commit();
      await imageQuota.commit();
      return { workflow: { id: workflow.id, name: workflow.name }, images };
    } catch (error) {
      if (signal?.aborted) {
        for (let index = 0; index < chatQuotas.length; index += 1) {
          if (index < startedChatNodes) await chatQuotas[index].commit(); else chatQuotas[index].rollback();
        }
        if (imageStarted) await imageQuota.commit(); else imageQuota.rollback();
      } else {
        for (const quota of chatQuotas) quota.rollback();
        imageQuota.rollback();
      }
      throw error;
    } finally {
      release();
    }
  }

  async function runWorkflowJob(job, request) {
    job.status = 'running';
    job.updatedAt = Date.now();
    try {
      const result = await executeWorkflow(request);
      job.status = 'completed';
      job.images = result.images;
    } catch (error) {
      const failure = publicFailure(error);
      job.status = 'failed';
      job.error = failure.error;
      job.code = failure.code;
    }
    job.updatedAt = Date.now();
  }

  async function serveStatic(req, res, pathname) {
    const staticMap = {
      '/styles.css': 'styles.css',
      '/login.css': 'login.css',
      '/app.css': 'app.css',
      '/login.js': 'login.js',
      '/app.js': 'app.js',
      '/favicon.svg': 'favicon.svg',
      '/manifest.webmanifest': 'manifest.webmanifest',
    };
    const katexAsset = /^\/vendor\/katex\/(katex\.min\.(?:css|js)|auto-render\.min\.js|fonts\/KaTeX_[A-Za-z0-9-]+\.woff2)$/.exec(pathname);
    const fileName = staticMap[pathname] || (katexAsset ? `vendor/katex/${katexAsset[1]}` : null);
    if (!fileName) return false;
    try {
      const content = await readFile(join(publicDir, fileName));
      res.writeHead(200, {
        'Content-Type': STATIC_TYPES[extname(fileName)],
        'Cache-Control': 'no-store',
      });
      if (req.method === 'HEAD') res.end();
      else res.end(content);
    } catch (error) {
      if (error?.code === 'ENOENT') sendJson(res, 404, { error: '页面资源不存在', code: 'NOT_FOUND' });
      else sendJson(res, 500, { error: '页面资源读取失败', code: 'STATIC_FAILED' });
    }
    return true;
  }

  async function serveHtml(req, res, fileName) {
    const content = await readFile(join(publicDir, fileName));
    res.writeHead(200, { 'Content-Type': STATIC_TYPES['.html'], 'Cache-Control': 'no-store' });
    if (req.method === 'HEAD') res.end();
    else res.end(content);
  }

  const server = createServer(async (req, res) => {
    const forwardedHttps = sessionManager.isHttps(req);
    setSecurityHeaders(req, res, { forwardedHttps });
    try {
      if (!isAllowedHost(req.headers.host, allowedHosts, port)) {
        throw publicError(421, '请求主机无效', 'HOST_REJECTED');
      }
      let pathname;
      try { pathname = new URL(req.url, 'http://localhost').pathname; } catch { throw publicError(400, '请求地址无效', 'INVALID_URL'); }

      if ((req.method === 'GET' || req.method === 'HEAD') && await serveStatic(req, res, pathname)) return;
      if ((req.method === 'GET' || req.method === 'HEAD') && ['/', '/index.html', '/login.html'].includes(pathname)) {
        const found = sessionManager.find(req);
        if (found?.session.authenticated && accountStore.isActive(found.session.uid)) {
          res.writeHead(303, { Location: '/app', 'Cache-Control': 'no-store' });
          res.end();
        } else {
          await serveHtml(req, res, 'login.html');
        }
        return;
      }
      if ((req.method === 'GET' || req.method === 'HEAD') && ['/app', '/app.html'].includes(pathname)) {
        const found = sessionManager.find(req);
        if (!found?.session.authenticated || !accountStore.isActive(found.session.uid)) {
          res.writeHead(303, { Location: '/', 'Cache-Control': 'no-store' });
          res.end();
        } else {
          await serveHtml(req, res, 'app.html');
        }
        return;
      }
      if (req.method === 'GET' && pathname === '/healthz') {
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === 'GET' && (pathname === '/api/session' || pathname === '/api/login/bootstrap')) {
        let found = sessionManager.find(req);
        let created;
        if (found?.session.authenticated && !accountStore.isActive(found.session.uid)) { sessionManager.invalidate(found); found = null; }
        if (!found) {
          created = sessionManager.create(req);
          found = { token: created.token, session: created.session };
          res.setHeader('Set-Cookie', [...sessionManager.clearCookieHeaders(), created.cookie]);
        }
        const sessionUser = found.session.authenticated ? accountStore.getPublicUser(found.session.uid) : null;
        const sessionPayload = {
          authenticated: found.session.authenticated,
          username: found.session.authenticated ? found.session.username : null,
          uid: found.session.authenticated ? (found.session.uid || accountStore.uid) : null,
          role: sessionUser?.role || null,
          credits: sessionUser?.credits ?? null,
          usagePoints: sessionUser?.usagePoints ?? 0,
          csrfToken: found.session.csrfToken,
          csrf: found.session.csrfToken,
        };
        sendJson(res, 200, pathname === '/api/login/bootstrap'
          ? { ...sessionPayload, csrf: found.session.csrfToken }
          : sessionPayload);
        return;
      }

      if (req.method === 'POST' && (pathname === '/api/auth/login' || pathname === '/api/login')) {
        const found = sessionManager.find(req);
        if (!found) throw publicError(403, '登录页面已过期，请刷新后重试', 'PREAUTH_REQUIRED');
        requireSafeMutation(req, sessionManager, found);
        const body = await readJson(req, 16 * 1024);
        const ip = sessionManager.clientIp(req);
        if (!ip) throw publicError(400, '无法确认访客地址', 'INVALID_CLIENT_IP');
        const keys = sessionManager.rateKeys(ip, body?.username || '');
        const rates = keys.map((key) => loginLimiter.state(key));
        const rate = rates.find((entry) => entry.blocked) || { blocked: false, retryAfter: 0 };
        if (rate.blocked) {
          sendJson(res, 429, { error: '登录尝试过多，请稍后再试', code: 'LOGIN_RATE_LIMITED' }, { 'Retry-After': String(rate.retryAfter) });
          return;
        }
        const account = await accountStore.authenticateAccount(body?.username, body?.password);
        if (!account) {
          const nextStates = await Promise.all(keys.map((key) => loginLimiter.failure(key)));
          const next = nextStates.find((entry) => entry.blocked) || nextStates[0];
          if (next.blocked) {
            sendJson(res, 429, { error: '登录尝试过多，请稍后再试', code: 'LOGIN_RATE_LIMITED' }, { 'Retry-After': String(next.retryAfter) });
          } else {
            sendJson(res, 401, { error: '用户名或密码不正确', code: 'INVALID_CREDENTIALS' });
          }
          return;
        }
        await Promise.all(keys.map((key) => loginLimiter.success(key)));
        const rotated = sessionManager.rotate(req, found, {
          authenticated: true,
          username: account.username,
          uid: account.uid,
          remember: body?.remember === true,
        });
        res.setHeader('Set-Cookie', [...sessionManager.clearCookieHeaders(), rotated.cookie]);
        sendJson(res, 200, {
          authenticated: true,
          username: rotated.session.username,
          uid: rotated.session.uid,
          role: account.role,
          credits: account.credits,
          usagePoints: account.usagePoints,
          csrfToken: rotated.session.csrfToken,
        });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/auth/logout') {
        const found = requireActiveAccount(req);
        requireSafeMutation(req, sessionManager, found);
        sessionManager.invalidate(found);
        const created = sessionManager.create(req);
        res.setHeader('Set-Cookie', [...sessionManager.clearCookieHeaders(), created.cookie]);
        sendJson(res, 200, { authenticated: false, csrfToken: created.session.csrfToken });
        return;
      }

      if (req.method === 'PUT' && pathname === '/api/account') {
        const found = requireActiveAccount(req);
        requireSafeMutation(req, sessionManager, found);
        const body = await readJson(req, 16 * 1024);
        const changed = await accountStore.changeCredentials({
          ...(body || {}),
          uid: found.user.uid,
          username: body?.username ?? body?.currentUsername,
        });
        sessionManager.invalidateUid(found.user.uid);
        const rotated = sessionManager.create(req, { authenticated: true, username: changed.username, uid: changed.uid });
        res.setHeader('Set-Cookie', [...sessionManager.clearCookieHeaders(), rotated.cookie]);
        sendJson(res, 200, { username: changed.username, uid: changed.uid, role: changed.role, credits: changed.credits, csrfToken: rotated.session.csrfToken });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/status') {
        const found = requireActiveAccount(req);
        sendJson(res, 200, { ready: true, username: found.user.username, uid: found.user.uid, role: found.user.role, credits: found.user.credits, usagePoints: found.user.usagePoints });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/quota') {
        const found = requireActiveAccount(req);
        sendJson(res, 200, { uid: found.user.uid, role: found.user.role, credits: found.user.credits, usagePoints: found.user.usagePoints, chatCalls: found.user.chatCalls, imageCalls: found.user.imageCalls, costs: { chat: 1, image: 5, geminiFlashImage: 1 } });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/admin/users') {
        requireAdministrator(req);
        sendJson(res, 200, { users: accountStore.listUsers(), total: accountStore.listUsers().length, revision: accountStore.data.revision });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/admin/users') {
        const found = requireAdministrator(req); requireSafeMutation(req, sessionManager, found);
        const body = await readJson(req, 32 * 1024);
        const models = await newApi.listModels();
        if (Array.isArray(body?.extraModels) && body.extraModels.some((modelId) => !models.some((model) => model.id === modelId))) throw publicError(400, '用户权限包含未知模型', 'MODEL_NOT_ALLOWED');
        const user = await runAdminMutation(async () => {
          const created = await accountStore.createUser(body || {}); await auditAdminAction('user.create', found.user.uid, created.uid); return created;
        });
        sendJson(res, 201, { user, revision: accountStore.data.revision });
        return;
      }

      const adminUserMatch = /^\/api\/admin\/users\/(\d{5}|\d{7})(?:\/(status|recharge|model-access))?$/.exec(pathname);
      if (adminUserMatch) {
        const found = requireAdministrator(req); requireSafeMutation(req, sessionManager, found);
        const [, uid, action] = adminUserMatch;
        if (req.method === 'DELETE' && !action) {
          await runAdminMutation(async () => { await accountStore.deleteUser(uid); sessionManager.invalidateUid(uid); await auditAdminAction('user.delete', found.user.uid, uid); }); sendJson(res, 200, { deleted: true, uid, revision: accountStore.data.revision }); return;
        }
        if (req.method === 'PUT' && action === 'status') {
          const body = await readJson(req, 8 * 1024); const user = await runAdminMutation(async () => { const updated = await accountStore.setUserDisabled(uid, body?.disabled === true); sessionManager.invalidateUid(uid); await auditAdminAction(body?.disabled === true ? 'user.disable' : 'user.enable', found.user.uid, uid); return updated; }); sendJson(res, 200, { user, revision: accountStore.data.revision }); return;
        }
        if (req.method === 'POST' && action === 'recharge') {
          const body = await readJson(req, 8 * 1024); const points = Number(body?.points); const user = await runAdminMutation(async () => { const updated = await accountStore.rechargeUser(uid, points); await auditAdminAction('user.recharge', found.user.uid, uid, { points }); return updated; }); sendJson(res, 200, { user, revision: accountStore.data.revision }); return;
        }
        if (req.method === 'PUT' && action === 'model-access') {
          const body = await readJson(req, 64 * 1024); const models = await newApi.listModels();
          const user = await runAdminMutation(async () => { const updated = await accountStore.setUserModelAccess(uid, body || {}, models.map((model) => model.id)); await auditAdminAction('user.model-access', found.user.uid, uid, { modelGroupId: updated.modelGroupId || '', extraModelCount: updated.extraModels.length }); return updated; }); sendJson(res, 200, { user, revision: accountStore.data.revision }); return;
        }
      }

      if (req.method === 'GET' && pathname === '/api/admin/model-groups') {
        requireAdministrator(req); sendJson(res, 200, { groups: accountStore.listModelGroups(), revision: accountStore.data.revision }); return;
      }

      if (req.method === 'PUT' && pathname === '/api/admin/model-groups') {
        const found = requireAdministrator(req); requireSafeMutation(req, sessionManager, found);
        const body = await readJson(req, 256 * 1024); const models = await newApi.listModels();
        const groups = await runAdminMutation(async () => { const saved = await accountStore.saveModelGroups(body?.groups, models.map((model) => model.id)); await auditAdminAction('model-groups.save', found.user.uid, null, { groupCount: saved.length }); return saved; }); sendJson(res, 200, { groups, revision: accountStore.data.revision }); return;
      }

      if (req.method === 'GET' && pathname === '/api/models') {
        const found = requireActiveAccount(req);
        const force = new URL(req.url, 'http://localhost').searchParams.get('refresh') === '1';
        const models = await modelsForUser(found.user.uid, { force });
        sendJson(res, 200, { models, loadedAt: new Date().toISOString() });
        return;
      }

      if (req.method === 'GET' && (pathname === '/api/preferences' || pathname === '/api/settings')) {
        const found = requireActiveAccount(req);
        let userPreferences = await preferencesFor(found.user.uid);
        if (found.user.role === 'user' && !userPreferences.favoriteGroups.length) {
          const availableModels = await modelsForUser(found.user.uid);
          if (availableModels.length > 0 && availableModels.length <= 20) {
            userPreferences = await savePreferencesFor(found.user.uid, {
              ...userPreferences,
              favoriteGroups: automaticFavoritesForModels(availableModels),
            });
          }
        }
        sendJson(res, 200, preferencesPayload(userPreferences));
        return;
      }

      if (req.method === 'PUT' && (pathname === '/api/preferences' || pathname === '/api/settings')) {
        const found = requireActiveAccount(req);
        requireSafeMutation(req, sessionManager, found);
        const body = await readJson(req, 64 * 1024);
        const models = await modelsForUser(found.user.uid);
        const currentPreferences = await preferencesFor(found.user.uid);
        const savedPreferences = await savePreferencesFor(found.user.uid, validatePreferences({ ...body, favoriteMediaIds: body?.favoriteMediaIds === undefined ? currentPreferences.favoriteMediaIds : body.favoriteMediaIds }, models));
        sendJson(res, 200, preferencesPayload(savedPreferences));
        return;
      }

      if (req.method === 'GET' && pathname === '/api/roles') {
        const found = requireActiveAccount(req);
        sendJson(res, 200, await rolesFor(found.user.uid));
        return;
      }

      if (req.method === 'GET' && pathname === '/api/workflows') {
        requireActiveAccount(req);
        sendJson(res, 200, { workflows: publicWorkflowList() });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/admin/workflows') {
        requireAdministrator(req);
        sendJson(res, 200, structuredClone(workflowData));
        return;
      }

      if (req.method === 'PUT' && pathname === '/api/admin/workflows') {
        const found = requireAdministrator(req);
        requireSafeMutation(req, sessionManager, found);
        const body = await readJson(req, MAX_JSON_BYTES);
        const saved = await saveWorkflowDefinitions(body);
        await auditAdminAction('workflows.save', found.user.uid, null, { workflowCount: saved.workflows.length });
        sendJson(res, 200, structuredClone(saved));
        return;
      }

      const workflowJobMatch = /^\/api\/workflows\/jobs\/([0-9a-f-]{36})$/i.exec(pathname);
      if (req.method === 'GET' && workflowJobMatch) {
        const found = requireActiveAccount(req);
        pruneWorkflowJobs();
        const job = workflowJobs.get(workflowJobMatch[1]);
        if (!job || job.userUid !== found.user.uid) throw publicError(404, '工作流任务不存在或已过期', 'WORKFLOW_JOB_NOT_FOUND');
        sendJson(res, 200, {
          jobId: job.id,
          status: job.status,
          workflow: job.workflow,
          ...(job.status === 'completed' ? { images: job.images } : {}),
          ...(job.status === 'failed' ? { error: job.error, code: job.code } : {}),
        });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/workflows/run') {
        const found = requireActiveAccount(req);
        requireSafeMutation(req, sessionManager, found);
        const body = await readJson(req, MAX_JSON_BYTES);
        const workflow = workflowData.workflows.find((item) => item.id === body?.workflowId && item.enabled);
        const userPrompt = typeof body?.prompt === 'string' ? body.prompt.trim() : '';
        if (!workflow || !userPrompt || userPrompt.length > 12_000) throw publicError(400, '工作流输入无效', 'INVALID_WORKFLOW_INPUT');
        const imageNode = workflowImageNode(workflow);
        if (!imageNode) throw publicError(500, '工作流缺少生图节点', 'INVALID_WORKFLOW');
        const imageModel = imageNode.allowUserModelOverride && typeof body?.imageModel === 'string' ? body.imageModel : imageNode.model;
        if (typeof imageModel !== 'string') throw publicError(400, '请选择生图模型', 'MODEL_REQUIRED');
        requireModelAccess(found.user.uid, imageModel);
        const selectedImageModel = await newApi.requireModel(imageModel, 'image');
        await Promise.all(workflow.nodes.filter((node) => node.type === 'role' || node.type === 'temporary').map((node) => newApi.requireModel(node.model, 'chat')));
        const { count, size, quality } = imageRequestOptions({
          size: imageNode.allowUserSizeOverride ? body?.size : imageNode.size,
          quality: imageNode.allowUserQualityOverride ? body?.quality : imageNode.quality,
          count: 1,
        }, selectedImageModel);
        const workflowRequest = { workflow, userPrompt, imageModel, size, quality, userUid: found.user.uid, sessionId: found.session.id };
        if (String(req.headers.prefer || '').includes('respond-async')) {
          pruneWorkflowJobs();
          const now = Date.now();
          const job = {
            id: crypto.randomUUID(),
            userUid: found.user.uid,
            status: 'queued',
            workflow: { id: workflow.id, name: workflow.name },
            images: [],
            error: '',
            code: '',
            createdAt: now,
            updatedAt: now,
          };
          workflowJobs.set(job.id, job);
          setImmediate(() => { void runWorkflowJob(job, workflowRequest); });
          sendJson(res, 202, { jobId: job.id, status: job.status, workflow: job.workflow });
          return;
        }
        const controller = new AbortController();
        let clientCancelled = false;
        const abort = () => { if (!res.writableEnded) { clientCancelled = true; controller.abort(); } };
        req.once('aborted', abort);
        res.once('close', abort);
        const stream = String(req.headers.accept || '').includes('text/event-stream');
        const heartbeat = stream
          ? setInterval(() => { if (!res.writableEnded) res.write(': keep-alive\n\n'); }, SSE_HEARTBEAT_INTERVAL_MS)
          : null;
        heartbeat?.unref?.();
        if (stream) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-store, no-transform',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
          });
          res.flushHeaders?.();
          sendSse(res, 'meta', { workflow: { id: workflow.id, name: workflow.name } });
        }
        try {
          const result = await executeWorkflow({
            ...workflowRequest,
            signal: controller.signal,
            onImage: (image) => { if (stream) sendSse(res, 'image', image); },
          });
          if (stream) sendSse(res, 'done', { workflow: result.workflow });
          else sendJson(res, 200, result);
        } catch (error) {
          if (stream && !clientCancelled) {
            const failure = publicFailure(error);
            sendSse(res, 'error', { error: failure.error, code: failure.code });
          } else throw error;
        } finally {
          if (heartbeat) clearInterval(heartbeat);
          req.removeListener('aborted', abort);
          res.removeListener('close', abort);
          if (stream && !res.writableEnded) res.end();
        }
        return;
      }

      if (req.method === 'PUT' && pathname === '/api/roles') {
        const found = requireActiveAccount(req);
        requireSafeMutation(req, sessionManager, found);
        const body = await readJson(req, MAX_JSON_BYTES);
        const savedRoles = await saveRolesFor(found.user.uid, validateRoleLibrary(body));
        sendJson(res, 200, savedRoles);
        return;
      }

      if (req.method === 'POST' && pathname === '/api/conversations/title') {
        const found = requireActiveAccount(req);
        requireSafeMutation(req, sessionManager, found);
        const body = await readJson(req, 8 * 1024);
        const source = typeof body?.source === 'string' ? body.source.trim() : '';
        if (!source || source.length > 600) throw publicError(400, '对话标题来源无效', 'INVALID_CONVERSATION_TITLE_SOURCE');
        await newApi.requireModel(CONVERSATION_TITLE_MODEL, 'chat');
        let release;
        try { release = reserve(found.session.id); } catch (error) { throw error; }
        try {
          const result = await newApi.chat({
            model: CONVERSATION_TITLE_MODEL,
            stream: false,
            maxTokens: 48,
            messages: [
              { role: 'system', content: '根据用户输入生成一个简洁的中文对话标题。只输出标题本身，不要引号、前缀、解释或 Markdown；不超过 24 个汉字或 48 个字符。' },
              { role: 'user', content: source },
            ],
          });
          const title = generatedConversationTitle(result.text);
          if (!title) throw publicError(502, '标题生成模型未返回标题', 'EMPTY_CONVERSATION_TITLE');
          sendJson(res, 200, { title, model: CONVERSATION_TITLE_MODEL });
        } finally { release(); }
        return;
      }

      if (req.method === 'GET' && pathname === '/api/conversations') {
        requireAdministrator(req);
        sendJson(res, 200, await readAdminConversations());
        return;
      }

      if (req.method === 'PUT' && pathname === '/api/conversations') {
        const found = requireAdministrator(req);
        requireSafeMutation(req, sessionManager, found);
        const body = await readJson(req, MAX_JSON_BYTES);
        const incoming = normalizeAdminConversations(body);
        const saved = await mergeAndSaveAdminConversations(incoming);
        sendJson(res, 200, saved);
        return;
      }

      if (req.method === 'POST' && pathname === '/api/uploads') {
        const found = requireActiveAccount(req);
        requireSafeMutation(req, sessionManager, found);
        const mediaOwnerId = found.user.uid;
        const declaredType = String(req.headers['content-type'] || '').toLowerCase().split(';')[0].trim();
        let fileName;
        try { fileName = decodeURIComponent(String(req.headers['x-file-name'] || '')); } catch { throw publicError(400, '文件名无效', 'INVALID_FILE_NAME'); }
        const totals = mediaStore.countUploads(mediaOwnerId);
        if (totals.count >= MAX_ATTACHMENTS) throw publicError(413, '当前会话最多保留 8 个待发送附件', 'TOO_MANY_ATTACHMENTS');
        const buffer = await readBody(req, MAX_INPUT_FILE_BYTES);
        if (totals.bytes + buffer.length > MAX_SESSION_UPLOAD_BYTES) {
          throw publicError(413, '当前会话的附件总大小超过 50 MB', 'UPLOAD_TOTAL_TOO_LARGE');
        }
        const saved = await mediaStore.saveUpload(buffer, { sessionId: mediaOwnerId, fileName, declaredType });
        sendJson(res, 201, { attachment: saved });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/media/recent') {
        const found = requireActiveAccount(req);
        const mediaOwnerId = found.user.uid;
        sendJson(res, 200, { files: mediaStore.listRecent(mediaOwnerId) });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/media/favorites') {
        const found = requireActiveAccount(req);
        const preferences = await preferencesFor(found.user.uid);
        sendJson(res, 200, { files: mediaStore.listOwned(preferences.favoriteMediaIds, found.user.uid) });
        return;
      }

      if (req.method === 'GET' && pathname.startsWith('/api/media/')) {
        const found = requireActiveAccount(req);
        const mediaOwnerId = found.user.uid;
        const id = pathname.slice('/api/media/'.length);
        const { record, buffer } = await mediaStore.read(id, mediaOwnerId);
        res.writeHead(200, {
          'Content-Type': record.mimeType,
          'Content-Length': String(buffer.length),
          'Content-Disposition': record.isImage ? 'inline' : `attachment; filename="${encodeURIComponent(record.fileName)}"`,
          'Cache-Control': 'private, no-store',
          'X-Content-Type-Options': 'nosniff',
        });
        res.end(buffer);
        return;
      }

      if (req.method === 'POST' && pathname === '/api/images/upscale') {
        const found = requireActiveAccount(req);
        requireSafeMutation(req, sessionManager, found);
        const mediaOwnerId = found.user.uid;
        const body = await readJson(req, 16 * 1024);
        if (typeof body?.imageId !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(body.imageId)) throw publicError(400, '待超分图片无效', 'INVALID_UPSCALE_IMAGE');
        const { record, buffer } = await mediaStore.read(body.imageId, mediaOwnerId);
        if (!record.isImage) throw publicError(400, '仅支持对图片执行超分', 'INVALID_UPSCALE_IMAGE');
        const width = body.width; const height = body.height; const mode = body.mode;
        if (!Number.isInteger(width) || !Number.isInteger(height) || width < 512 || height < 512 || width > MAX_LOCAL_UPSCALE_DIMENSION || height > MAX_LOCAL_UPSCALE_DIMENSION || width * height > MAX_LOCAL_UPSCALE_PIXELS) throw publicError(400, '超分输出尺寸无效或过大', 'INVALID_UPSCALE_SIZE');
        if (!['detail', 'text-safe'].includes(mode)) throw publicError(400, '超分模式无效', 'INVALID_UPSCALE_MODE');
        let release;
        try { release = reserve(found.session.id); } catch (error) { throw error; }
        try {
          const result = await imageUpscaler.upscale(buffer, { width, height, mode });
          const saved = await mediaStore.save(result, { sessionId: mediaOwnerId, kind: 'output', alt: `超分 · ${mode === 'text-safe' ? '文字保真' : '细节增强'} · ${width}×${height}` });
          sendJson(res, 200, { image: saved, options: { width, height, mode } });
        } finally { release(); }
        return;
      }

      if (req.method === 'POST' && pathname === '/api/chat') {
        const found = requireActiveAccount(req);
        requireSafeMutation(req, sessionManager, found);
        const mediaOwnerId = found.user.uid;
        const body = await readJson(req, MAX_JSON_BYTES);
        const submittedMessages = structuredClone(body?.messages);
        if (Array.isArray(body?.attachmentIds) && Array.isArray(submittedMessages) && submittedMessages.length > 0) {
          const last = submittedMessages.at(-1);
          if (last?.role === 'user' && last.attachmentIds === undefined) last.attachmentIds = body.attachmentIds;
        }
        let systemPrompt = '';
        if (body?.roleId !== undefined && body.roleId !== null && body.roleId !== '') {
          if (typeof body.roleId !== 'string') throw publicError(400, '角色标识无效', 'INVALID_ROLE');
          const role = findRole(await rolesFor(found.user.uid), body.roleId);
          if (!role) throw publicError(400, '所选角色不存在或已被删除', 'ROLE_NOT_FOUND');
          systemPrompt = role.systemPrompt;
        }
        if (typeof body?.model !== 'string') throw publicError(400, '请选择模型', 'MODEL_REQUIRED');
        requireModelAccess(found.user.uid, body.model);
        const selectedModel = await newApi.requireModel(body.model, 'chat');
        let imageSize;
        if (body.imageSize !== undefined) {
          const supportedSizes = selectedModel.imageOptions?.sizes;
          if (typeof body.imageSize !== 'string' || !Array.isArray(supportedSizes) || !supportedSizes.includes(body.imageSize)) {
            throw publicError(400, '当前模型不支持所选生图尺寸', 'INVALID_IMAGE_SIZE');
          }
          imageSize = body.imageSize;
        }
        const contextLimit = modelContextLimit(await preferencesFor(found.user.uid), body.model);
        const upstreamMessages = await validateConversation(submittedMessages, mediaStore, pdfTextExtractor, mediaOwnerId, systemPrompt, contextLimit);
        const usedUploadIds = submittedMessages.flatMap((message) => Array.isArray(message?.attachmentIds) ? message.attachmentIds : []);
        await mediaStore.markUploadsUsed(usedUploadIds, mediaOwnerId);
        const temperature = body.temperature === undefined ? undefined : Number(body.temperature);
        if (temperature !== undefined && (!Number.isFinite(temperature) || temperature < 0 || temperature > 2)) {
          throw publicError(400, '温度参数无效', 'INVALID_TEMPERATURE');
        }
        const maxTokens = body.maxTokens === undefined ? undefined : Number(body.maxTokens);
        if (maxTokens !== undefined && (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 64000)) {
          throw publicError(400, '最大输出长度无效', 'INVALID_MAX_TOKENS');
        }
        const stream = body.stream !== false;
                const quotaMode = selectedModel.suggestedMode === 'image' ? 'image' : 'chat';
        const quota = accountStore.reserveQuota(found.user.uid, quotaMode, quotaMode === 'image' ? imageCreditCost(body.model) : undefined);
        let release;
        try { release = reserve(found.session.id); } catch (error) { quota.rollback(); throw error; }
        const controller = new AbortController();
        let clientCancelled = false;
        const abort = () => { if (!res.writableEnded) { clientCancelled = true; controller.abort(); } };
        req.once('aborted', abort);
        res.once('close', abort);
        if (stream) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-store, no-transform',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
          });
          res.flushHeaders?.();
          sendSse(res, 'meta', { model: body.model, mode: 'chat', stream: true });
        }
        const heartbeat = stream
          ? setInterval(() => { if (!res.writableEnded) res.write(': keep-alive\n\n'); }, SSE_HEARTBEAT_INTERVAL_MS)
          : null;
        heartbeat?.unref?.();
        try {
          const result = await newApi.chat({
            model: body.model,
            messages: upstreamMessages,
            temperature,
            maxTokens,
            imageSize,
            stream,
            onDelta: (text) => sendSse(res, 'delta', { text }),
            onReasoning: (text) => sendSse(res, 'reasoning', { text }),
            signal: controller.signal,
          });
          const images = [];
          for (const image of result.images) {
            const saved = await mediaStore.save(image.buffer, {
              sessionId: mediaOwnerId,
              kind: 'output',
              alt: image.alt || '模型生成的图片',
            });
            images.push(saved);
            if (stream) sendSse(res, 'image', saved);
          }
          await quota.commit();
          if (stream) {
            if (result.usage) sendSse(res, 'usage', result.usage);
            sendSse(res, 'done', {});
          } else sendJson(res, 200, { text: result.text, reasoning: result.reasoning, images, usage: result.usage, model: body.model, stream: false });
        } catch (error) {
          if (clientCancelled) await quota.commit(); else quota.rollback();
          const failure = publicFailure(error);
          if (stream && !clientCancelled) sendSse(res, 'error', { error: failure.error, code: failure.code });
          else throw error;
        } finally {
          if (heartbeat) clearInterval(heartbeat);
          req.removeListener('aborted', abort);
          res.removeListener('close', abort);
          release();
          if (stream && !res.writableEnded) res.end();
        }
        return;
      }

      if (req.method === 'POST' && (pathname === '/api/images/generations' || pathname === '/api/image')) {
        const found = requireActiveAccount(req);
        requireSafeMutation(req, sessionManager, found);
        const mediaOwnerId = found.user.uid;
        const body = await readJson(req, MAX_JSON_BYTES);
        const prompt = requireImagePrompt(body);
        requireModelAccess(found.user.uid, body.model);
        const selectedModel = await newApi.requireModel(body.model, 'image');
        requirePromptWithinContext(prompt, modelContextLimit(await preferencesFor(found.user.uid), body.model));
        const { count, size, quality } = imageRequestOptions(body, selectedModel);
        const quota = accountStore.reserveQuota(found.user.uid, 'image', imageCreditCost(body.model));
        let release;
        try { release = reserve(found.session.id); } catch (error) { quota.rollback(); throw error; }
        const controller = new AbortController();
        let clientCancelled = false;
        const abort = () => { if (!res.writableEnded) { clientCancelled = true; controller.abort(); } };
        req.once('aborted', abort);
        res.once('close', abort);
        const stream = String(req.headers.accept || '').includes('text/event-stream');
        if (stream) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-store, no-transform',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
          });
          res.flushHeaders?.();
          sendSse(res, 'meta', { model: body.model, mode: 'image', stream: true });
        }
        const heartbeat = stream
          ? setInterval(() => { if (!res.writableEnded) res.write(': keep-alive\n\n'); }, SSE_HEARTBEAT_INTERVAL_MS)
          : null;
        heartbeat?.unref?.();
        try {
          const generated = await newApi.generateImages({
            model: body.model,
            prompt: body.prompt,
            size,
            count,
            quality,
            signal: controller.signal,
          });
          const images = [];
          if (stream && generated.text) sendSse(res, 'delta', { text: generated.text });
          for (const image of generated) {
            const saved = await mediaStore.save(image.buffer, {
              sessionId: mediaOwnerId,
              kind: 'output',
              alt: image.alt,
            });
            images.push(saved);
            if (stream) sendSse(res, 'image', saved);
          }
          await quota.commit();
          if (stream) sendSse(res, 'done', {});
          else sendJson(res, 200, { images, text: generated.text || '' });
        } catch (error) {
          if (clientCancelled) await quota.commit(); else quota.rollback();
          const failure = publicFailure(error);
          if (stream && !clientCancelled) sendSse(res, 'error', { error: failure.error, code: failure.code });
          else throw error;
        } finally {
          if (heartbeat) clearInterval(heartbeat);
          req.removeListener('aborted', abort);
          res.removeListener('close', abort);
          release();
          if (stream && !res.writableEnded) res.end();
        }
        return;
      }

      if (req.method === 'POST' && pathname === '/api/images/edits') {
        const found = requireActiveAccount(req);
        requireSafeMutation(req, sessionManager, found);
        const mediaOwnerId = found.user.uid;
        const body = await readJson(req, MAX_JSON_BYTES);
        const prompt = requireImagePrompt(body);
        requireModelAccess(found.user.uid, body.model);
        const selectedModel = await newApi.requireModel(body.model, 'image');
        requirePromptWithinContext(prompt, modelContextLimit(await preferencesFor(found.user.uid), body.model));
        const imageOptions = selectedModel.imageOptions || {};
        if (imageOptions.supportsEdits !== true) {
          throw publicError(400, '所选模型不支持参考图编辑', 'IMAGE_EDITS_NOT_SUPPORTED');
        }
        const maxReferenceImages = Number.isInteger(imageOptions.maxReferenceImages) ? imageOptions.maxReferenceImages : 0;
        const imageIds = body.imageIds;
        if (
          !Array.isArray(imageIds)
          || imageIds.length < 1
          || imageIds.length > maxReferenceImages
          || imageIds.some((id) => typeof id !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(id))
          || new Set(imageIds).size !== imageIds.length
        ) {
          throw publicError(400, '参考图片格式或数量无效', 'INVALID_REFERENCE_IMAGES');
        }
        if (body.maskId !== undefined && (typeof body.maskId !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(body.maskId))) {
          throw publicError(400, '遮罩图片标识无效', 'INVALID_IMAGE_MASK');
        }

        const references = [];
        let totalReferenceBytes = 0;
        for (const id of imageIds) {
          const { record, buffer } = await mediaStore.read(id, mediaOwnerId);
          if (!record.isImage) throw publicError(400, '参考文件中包含非图片附件', 'INVALID_REFERENCE_IMAGE');
          totalReferenceBytes += buffer.length;
          references.push({ buffer, mimeType: record.mimeType });
        }
        let mask;
        if (body.maskId !== undefined) {
          const loaded = await mediaStore.read(body.maskId, mediaOwnerId);
          if (!loaded.record.isImage || loaded.record.mimeType !== 'image/png') {
            throw publicError(400, '遮罩必须为 PNG 图片', 'INVALID_IMAGE_MASK');
          }
          totalReferenceBytes += loaded.buffer.length;
          mask = { buffer: loaded.buffer, mimeType: loaded.record.mimeType };
        }
        if (totalReferenceBytes > MAX_CONTEXT_MEDIA_BYTES) {
          throw publicError(413, '参考图片总大小超过 50 MB', 'CONTEXT_MEDIA_TOO_LARGE');
        }
        await mediaStore.markUploadsUsed([...imageIds, ...(body.maskId ? [body.maskId] : [])], mediaOwnerId);
        const { count, size, quality } = imageRequestOptions(body, selectedModel);
        const quota = accountStore.reserveQuota(found.user.uid, 'image', imageCreditCost(body.model));
        let release;
        try { release = reserve(found.session.id); } catch (error) { quota.rollback(); throw error; }
        const controller = new AbortController();
        let clientCancelled = false;
        const abort = () => { if (!res.writableEnded) { clientCancelled = true; controller.abort(); } };
        req.once('aborted', abort);
        res.once('close', abort);
        const stream = String(req.headers.accept || '').includes('text/event-stream');
        if (stream) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-store, no-transform',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
          });
          res.flushHeaders?.();
          sendSse(res, 'meta', { model: body.model, mode: 'image', stream: true });
        }
        const heartbeat = stream
          ? setInterval(() => { if (!res.writableEnded) res.write(': keep-alive\n\n'); }, SSE_HEARTBEAT_INTERVAL_MS)
          : null;
        heartbeat?.unref?.();
        try {
          const generated = await newApi.editImages({
            model: body.model,
            prompt: body.prompt,
            references,
            mask,
            size,
            count,
            quality,
            signal: controller.signal,
          });
          const images = [];
          if (stream && generated.text) sendSse(res, 'delta', { text: generated.text });
          for (const image of generated) {
            const saved = await mediaStore.save(image.buffer, {
              sessionId: mediaOwnerId,
              kind: 'output',
              alt: image.alt,
            });
            images.push(saved);
            if (stream) sendSse(res, 'image', saved);
          }
          await quota.commit();
          if (stream) sendSse(res, 'done', {});
          else sendJson(res, 200, { images, text: generated.text || '' });
        } catch (error) {
          if (clientCancelled) await quota.commit(); else quota.rollback();
          const failure = publicFailure(error);
          if (stream && !clientCancelled) sendSse(res, 'error', { error: failure.error, code: failure.code });
          else throw error;
        } finally {
          if (heartbeat) clearInterval(heartbeat);
          req.removeListener('aborted', abort);
          res.removeListener('close', abort);
          release();
          if (stream && !res.writableEnded) res.end();
        }
        return;
      }

      throw publicError(404, '未找到该接口', 'NOT_FOUND');
    } catch (error) {
      const failure = publicFailure(error);
      if (!res.headersSent) sendJson(res, failure.status, { error: failure.error, code: failure.code });
      else if (!res.writableEnded) res.end();
      if (failure.status >= 500 && failure.code === 'SERVER_ERROR') {
        console.error(`请求处理失败：${error?.name || 'Error'}`);
      }
    }
  });

  return {
    server,
    stores: { accountStore, preferencesStore, rolesStore, workflowsStore, mediaStore },
    async close() {
      await sessionManager.close();
      mediaStore.close();
      if (server.listening) await new Promise((resolve) => server.close(resolve));
    },
  };
}

export const testing = Object.freeze({
  chunkText,
  isAllowedHost,
  validatePreferences,
});
