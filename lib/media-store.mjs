import { copyFile, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { publicError, randomToken } from './security.mjs';

export const ALLOWED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
export const MAX_INPUT_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_INPUT_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_OUTPUT_IMAGE_BYTES = 15 * 1024 * 1024;
const MAX_PIXELS = 40_000_000;
const MAX_DIMENSION = 16_384;
const UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;
// Media referenced by conversations must outlive the short-lived upload queue.
// Persisted conversation media is retained for a year; abandoned pending uploads still expire after 24h.
const MEDIA_RETENTION_MS = 365 * 24 * 60 * 60 * 1000;
const OUTPUT_TTL_MS = MEDIA_RETENTION_MS;

const FILE_TYPES = Object.freeze({
  '.txt': ['text/plain'],
  '.md': ['text/markdown', 'text/plain'],
  '.pdf': ['application/pdf'],
  '.doc': ['application/msword', 'application/octet-stream'],
  '.docx': ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/zip', 'application/octet-stream'],
  '.ppt': ['application/vnd.ms-powerpoint', 'application/octet-stream'],
  '.pptx': ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'application/zip', 'application/octet-stream'],
});

function cleanFileName(value) {
  const decoded = String(value || '').trim().replace(/\\/g, '/').split('/').at(-1) || '';
  const cleaned = decoded.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_').slice(0, 180);
  if (!cleaned || !/\.[A-Za-z0-9]{2,5}$/.test(cleaned)) {
    throw publicError(400, '文件名无效', 'INVALID_FILE_NAME');
  }
  return cleaned;
}

function inspectDocument(buffer, fileName, declaredType) {
  const name = cleanFileName(fileName);
  const extension = name.slice(name.lastIndexOf('.')).toLowerCase();
  const allowed = FILE_TYPES[extension];
  if (!allowed || !allowed.includes(declaredType)) {
    throw publicError(415, '仅支持 TXT、MD、PDF、Word 或 PowerPoint 文件', 'UNSUPPORTED_FILE');
  }
  const ole = buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
  const zip = buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b && [0x03, 0x05, 0x07].includes(buffer[2]);
  const valid = (
    (extension === '.pdf' && buffer.subarray(0, 5).toString('ascii') === '%PDF-')
    || (['.doc', '.ppt'].includes(extension) && ole)
    || (['.docx', '.pptx'].includes(extension) && zip)
    || (['.txt', '.md'].includes(extension) && !buffer.includes(0))
  );
  if (!valid) throw publicError(415, '文件内容与扩展名不匹配', 'FILE_TYPE_MISMATCH');
  const mimeType = {
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.pdf': 'application/pdf',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.ppt': 'application/vnd.ms-powerpoint',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  }[extension];
  return { fileName: name, mimeType, isImage: false };
}

function dimensionsForPng(buffer) {
  if (buffer.length < 24) return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function dimensionsForJpeg(buffer) {
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) return null;
    const marker = buffer[offset + 1];
    offset += 2;
    if (marker === 0xd8 || marker === 0xd9) continue;
    if (marker === 0xda) break;
    if (offset + 2 > buffer.length) return null;
    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) return null;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      return { width: buffer.readUInt16BE(offset + 5), height: buffer.readUInt16BE(offset + 3) };
    }
    offset += length;
  }
  return null;
}

function dimensionsForWebp(buffer) {
  if (buffer.length < 30) return null;
  const format = buffer.toString('ascii', 12, 16);
  if (format === 'VP8X') {
    return {
      width: 1 + buffer.readUIntLE(24, 3),
      height: 1 + buffer.readUIntLE(27, 3),
    };
  }
  if (format === 'VP8 ' && buffer.length >= 30 && buffer[23] === 0x9d && buffer[24] === 0x01 && buffer[25] === 0x2a) {
    return {
      width: buffer.readUInt16LE(26) & 0x3fff,
      height: buffer.readUInt16LE(28) & 0x3fff,
    };
  }
  if (format === 'VP8L' && buffer.length >= 25 && buffer[20] === 0x2f) {
    const bits = buffer.readUInt32LE(21);
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >>> 14) & 0x3fff) + 1,
    };
  }
  return null;
}

export function inspectRaster(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24) {
    throw publicError(415, '图片格式无效', 'INVALID_IMAGE');
  }

  let mimeType;
  let dimensions;
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    mimeType = 'image/png';
    if (buffer.toString('ascii', 12, 16) !== 'IHDR') throw publicError(415, 'PNG 图片结构无效', 'INVALID_IMAGE');
    dimensions = dimensionsForPng(buffer);
  } else if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    mimeType = 'image/jpeg';
    dimensions = dimensionsForJpeg(buffer);
  } else if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    mimeType = 'image/webp';
    dimensions = dimensionsForWebp(buffer);
  } else {
    throw publicError(415, '仅支持 PNG、JPEG 或 WebP 图片', 'UNSUPPORTED_IMAGE');
  }

  if (
    !dimensions
    || !Number.isInteger(dimensions.width)
    || !Number.isInteger(dimensions.height)
    || dimensions.width < 1
    || dimensions.height < 1
    || dimensions.width > MAX_DIMENSION
    || dimensions.height > MAX_DIMENSION
    || dimensions.width * dimensions.height > MAX_PIXELS
  ) {
    throw publicError(415, '图片尺寸无效或过大', 'INVALID_IMAGE_DIMENSIONS');
  }

  return { mimeType, ...dimensions };
}

export function decodeDataImage(value, maxBytes = MAX_OUTPUT_IMAGE_BYTES) {
  if (typeof value !== 'string') throw publicError(502, '生图结果格式无效', 'INVALID_UPSTREAM_IMAGE');
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=\r\n]+)$/.exec(value);
  if (!match) throw publicError(502, '模型返回了不受支持的图片格式', 'INVALID_UPSTREAM_IMAGE');
  const compact = match[2].replace(/[\r\n]/g, '');
  if (compact.length > Math.ceil(maxBytes / 3) * 4 + 4 || compact.length % 4 === 1) {
    throw publicError(502, '模型返回的图片过大', 'UPSTREAM_IMAGE_TOO_LARGE');
  }
  const buffer = Buffer.from(compact, 'base64');
  if (!buffer.length || buffer.length > maxBytes) {
    throw publicError(502, '模型返回的图片过大', 'UPSTREAM_IMAGE_TOO_LARGE');
  }
  const canonical = buffer.toString('base64').replace(/=+$/, '');
  if (canonical !== compact.replace(/=+$/, '')) {
    throw publicError(502, '模型返回的图片编码无效', 'INVALID_UPSTREAM_IMAGE');
  }
  const details = inspectRaster(buffer);
  if (details.mimeType !== match[1]) {
    throw publicError(502, '模型返回的图片类型不一致', 'INVALID_UPSTREAM_IMAGE');
  }
  return { buffer, ...details };
}

export class MediaStore {
  constructor(root, { defaultOwnerId = '00000' } = {}) {
    this.root = root;
    this.indexPath = join(root, 'index.json');
    this.defaultOwnerId = defaultOwnerId;
    this.records = new Map();
    this.persistQueue = Promise.resolve();
    this.timer = setInterval(() => this.cleanup().catch(() => undefined), 15 * 60 * 1000);
    this.timer.unref?.();
  }

  async initialize() {
    await mkdir(this.root, { recursive: true });
    try {
      const parsed = JSON.parse(await readFile(this.indexPath, 'utf8'));
      if (parsed?.version !== 1 || !Array.isArray(parsed.records) || parsed.records.length > 10_000) throw new Error('invalid media index');
      for (const value of parsed.records) {
        if (!value || typeof value.id !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(value.id) || typeof value.sessionId !== 'string' || !['upload', 'output'].includes(value.kind)) throw new Error('invalid media record');
        const path = join(this.root, `${value.id}.bin`);
        await stat(path);
        const pending = value.kind === 'upload' && value.pending === true;
        const expiresAt = pending ? value.expiresAt : Math.max(value.expiresAt, (value.createdAt || Date.now()) + MEDIA_RETENTION_MS);
        this.records.set(value.id, { ...value, expiresAt, pending, path });
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw new Error('媒体索引无法读取或格式无效');
    }
    await this.recoverOrphanImages();
    await this.cleanup();
    await this.persistIndex();
  }

  async recoverOrphanImages() {
    const names = await readdir(this.root);
    for (const name of names) {
      const match = /^([A-Za-z0-9_-]{32})\.bin$/.exec(name); if (!match || this.records.has(match[1])) continue;
      const id = match[1]; const path = join(this.root, name);
      try {
        const [buffer, details] = await Promise.all([readFile(path), stat(path)]);
        const raster = inspectRaster(buffer); const createdAt = details.mtimeMs || Date.now();
        this.records.set(id, { id, path, sessionId: this.defaultOwnerId, kind: 'output', alt: '恢复的历史图片', size: buffer.length, createdAt, expiresAt: Math.max(Date.now() + OUTPUT_TTL_MS, createdAt + OUTPUT_TTL_MS), ...raster, isImage: true, fileName: '' });
      } catch { /* Non-image orphan files cannot be reconstructed safely. */ }
    }
  }

  persistIndex() {
    this.persistQueue = this.persistQueue.catch(() => undefined).then(async () => {
      const records = [...this.records.values()].map(({ path: _path, ...record }) => record);
      const temp = `${this.indexPath}.${process.pid}.tmp`;
      await writeFile(temp, `${JSON.stringify({ version: 1, records }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await rename(temp, this.indexPath);
    });
    return this.persistQueue;
  }

  async save(buffer, { sessionId, kind = 'upload', alt = '' }) {
    const max = kind === 'upload' ? MAX_INPUT_IMAGE_BYTES : MAX_OUTPUT_IMAGE_BYTES;
    if (buffer.length > max) throw publicError(413, '图片文件过大', 'IMAGE_TOO_LARGE');
    const details = inspectRaster(buffer);
    const id = randomToken(24);
    const path = join(this.root, `${id}.bin`);
    await writeFile(path, buffer, { mode: 0o600 });
    const record = {
      id,
      path,
      sessionId,
      kind,
      alt: typeof alt === 'string' ? alt.slice(0, 300) : '',
      size: buffer.length,
      createdAt: Date.now(),
      expiresAt: Date.now() + (kind === 'upload' ? UPLOAD_TTL_MS : OUTPUT_TTL_MS),
      pending: kind === 'upload',
      ...details,
      isImage: true,
      fileName: '',
    };
    this.records.set(id, record);
    await this.persistIndex();
    return this.publicRecord(record);
  }

  async saveUpload(buffer, { sessionId, fileName, declaredType }) {
    if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > MAX_INPUT_FILE_BYTES) {
      throw publicError(413, '单个文件不能超过 20 MB', 'FILE_TOO_LARGE');
    }
    let details;
    if (ALLOWED_IMAGE_TYPES.has(declaredType)) {
      if (buffer.length > MAX_INPUT_IMAGE_BYTES) throw publicError(413, '单张图片不能超过 10 MB', 'IMAGE_TOO_LARGE');
      const raster = inspectRaster(buffer);
      if (raster.mimeType !== declaredType) throw publicError(415, '图片声明类型与实际内容不一致', 'IMAGE_TYPE_MISMATCH');
      details = { ...raster, isImage: true, fileName: cleanFileName(fileName) };
    } else {
      details = inspectDocument(buffer, fileName, declaredType);
    }
    const id = randomToken(24);
    const path = join(this.root, `${id}.bin`);
    await writeFile(path, buffer, { mode: 0o600 });
    const record = {
      id,
      path,
      sessionId,
      kind: 'upload',
      alt: details.isImage ? details.fileName : '',
      size: buffer.length,
      createdAt: Date.now(),
      expiresAt: Date.now() + UPLOAD_TTL_MS,
      pending: true,
      ...details,
    };
    this.records.set(id, record);
    await this.persistIndex();
    return this.publicRecord(record);
  }

  publicRecord(record) {
    return {
      id: record.id,
      url: `/api/media/${record.id}`,
      mimeType: record.mimeType,
      width: record.width,
      height: record.height,
      size: record.size,
      alt: record.alt,
      fileName: record.fileName || '',
      isImage: record.isImage !== false,
      kind: record.kind,
      createdAt: record.createdAt,
    };
  }

  async findRecoverableImage(value, sessionId) {
    const size = Number.isSafeInteger(value?.size) && value.size > 0 ? value.size : 0;
    const mimeType = typeof value?.mimeType === 'string' ? value.mimeType : '';
    if (!size || !ALLOWED_IMAGE_TYPES.has(mimeType)) return null;
    const candidates = [...this.records.values()].filter((record) => (
      record.sessionId === sessionId
      && record.isImage === true
      && record.pending !== true
      && record.size === size
      && record.mimeType === mimeType
      && record.expiresAt > Date.now()
    ));
    const fileName = typeof value?.fileName === 'string' ? value.fileName : '';
    const alt = typeof value?.alt === 'string' ? value.alt : '';
    const named = candidates.filter((record) => (
      (fileName && (record.fileName === fileName || record.alt === fileName))
      || (alt && (record.fileName === alt || record.alt === alt))
    ));
    const matches = named.length ? named : candidates;
    if (matches.length === 1) return matches[0];
    if (!matches.length) return null;
    const canonical = matches[0];
    const buffer = await readFile(canonical.path);
    for (const candidate of matches.slice(1)) {
      const candidateBuffer = await readFile(candidate.path);
      if (!buffer.equals(candidateBuffer)) return null;
    }
    return canonical;
  }

  async restoreImageAlias(id, source, { sessionId, kind = 'upload', alt = '', fileName = '' } = {}) {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(id)) return null;
    const existing = this.records.get(id);
    if (existing) return this.publicRecord(existing);
    if (!source || source.sessionId !== sessionId || source.isImage !== true || source.pending === true || !['upload', 'output'].includes(kind)) return null;
    const path = join(this.root, `${id}.bin`);
    await copyFile(source.path, path);
    const createdAt = Date.now();
    const record = {
      id,
      path,
      sessionId,
      kind,
      alt: typeof alt === 'string' ? alt.slice(0, 300) : '',
      size: source.size,
      createdAt,
      expiresAt: Math.max(source.expiresAt, createdAt + MEDIA_RETENTION_MS),
      pending: false,
      mimeType: source.mimeType,
      width: source.width,
      height: source.height,
      isImage: true,
      fileName: typeof fileName === 'string' ? fileName.slice(0, 180) : '',
      recoveredFrom: source.id,
    };
    this.records.set(id, record);
    await this.persistIndex();
    return this.publicRecord(record);
  }


  listRecent(sessionId, { limit = 50 } = {}) {
    const safeLimit = Math.max(1, Math.min(100, Number.parseInt(limit, 10) || 50));
    return [...this.records.values()]
      .filter((record) => record.sessionId === sessionId && record.expiresAt > Date.now())
      .sort((left, right) => right.createdAt - left.createdAt)
      .slice(0, safeLimit)
      .map((record) => this.publicRecord(record));
  }

  listOwned(ids, sessionId, { limit = 120 } = {}) {
    const safeLimit = Math.max(1, Math.min(120, Number.parseInt(limit, 10) || 120));
    const requested = Array.isArray(ids) ? ids.slice(0, safeLimit) : [];
    return requested.map((id) => this.get(id, sessionId)).filter(Boolean).map((record) => this.publicRecord(record));
  }

  get(id, sessionId, { kind } = {}) {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(id)) return null;
    const record = this.records.get(id);
    if (!record || record.expiresAt <= Date.now() || record.sessionId !== sessionId) return null;
    if (kind && record.kind !== kind) return null;
    return record;
  }

  async read(id, sessionId, options) {
    const record = this.get(id, sessionId, options);
    if (!record) throw publicError(404, '附件不存在或已过期', 'MEDIA_NOT_FOUND');
    return { record, buffer: await readFile(record.path) };
  }

  countUploads(sessionId) {
    let count = 0;
    let bytes = 0;
    for (const record of this.records.values()) {
      if (record.sessionId === sessionId && record.kind === 'upload' && record.pending === true && record.expiresAt > Date.now()) {
        count += 1;
        bytes += record.size;
      }
    }
    return { count, bytes };
  }

  async markUploadsUsed(ids, sessionId) {
    let changed = false;
    for (const id of new Set(Array.isArray(ids) ? ids : [])) {
      const record = this.get(id, sessionId, { kind: 'upload' });
      if (!record || record.pending !== true) continue;
      record.pending = false;
      record.expiresAt = Math.max(record.expiresAt, Date.now() + MEDIA_RETENTION_MS);
      changed = true;
    }
    if (changed) await this.persistIndex();
  }

  async cleanup() {
    const now = Date.now();
    const deletions = [];
    for (const [id, record] of this.records) {
      if (record.expiresAt <= now) {
        this.records.delete(id);
        deletions.push(unlink(record.path).catch(() => undefined));
      }
    }
    await Promise.all(deletions);
    if (deletions.length) await this.persistIndex();
  }

  close() {
    clearInterval(this.timer);
  }
}
