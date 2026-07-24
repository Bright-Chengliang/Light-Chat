import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publicError } from './security.mjs';

const MAX_TEXT_BYTES = 16 * 1024 * 1024;
const MAX_STDERR_BYTES = 8 * 1024;
const CACHE_ENTRIES = 32;

function extractionError(message = 'PDF 文本提取失败；扫描版 PDF 暂不支持，请先进行 OCR') {
  return publicError(422, message, 'PDF_TEXT_EXTRACTION_FAILED');
}

export class PdfTextExtractor {
  constructor({ scriptPath, pythonCommand = process.env.CHAT_PYTHON || 'python', timeoutMs = 120_000 } = {}) {
    if (typeof scriptPath !== 'string' || !scriptPath) throw new Error('缺少 PDF 文本提取脚本');
    this.scriptPath = scriptPath;
    this.pythonCommand = pythonCommand;
    this.timeoutMs = timeoutMs;
    this.cache = new Map();
    this.inflight = new Map();
  }

  async extract(record) {
    if (!record || record.kind !== 'upload' || record.mimeType !== 'application/pdf' || typeof record.path !== 'string') {
      throw extractionError('PDF 附件格式无效');
    }
    const key = `${record.id}:${record.size}:${record.createdAt}`;
    if (this.cache.has(key)) {
      const text = this.cache.get(key);
      this.cache.delete(key); this.cache.set(key, text);
      return text;
    }
    if (this.inflight.has(key)) return this.inflight.get(key);
    const pending = this.#run(record.path).then((text) => {
      this.cache.set(key, text);
      while (this.cache.size > CACHE_ENTRIES) this.cache.delete(this.cache.keys().next().value);
      return text;
    }).finally(() => this.inflight.delete(key));
    this.inflight.set(key, pending);
    return pending;
  }

  async #run(inputPath) {
    const directory = await mkdtemp(join(tmpdir(), 'light-chat-pdf-'));
    const outputPath = join(directory, 'content.txt');
    try {
      let stderr = Buffer.alloc(0);
      const child = spawn(this.pythonCommand, [this.scriptPath, inputPath, outputPath], {
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      child.stderr.on('data', (chunk) => {
        if (stderr.length < MAX_STDERR_BYTES) stderr = Buffer.concat([stderr, chunk]).subarray(0, MAX_STDERR_BYTES);
      });
      const exitCode = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { child.kill(); reject(extractionError('PDF 文本提取超时')); }, this.timeoutMs);
        child.once('error', (error) => { clearTimeout(timer); reject(error); });
        child.once('exit', (code) => { clearTimeout(timer); resolve(code); });
      }).catch((error) => {
        if (error?.status) throw error;
        throw extractionError('本机 PDF 解析服务不可用');
      });
      if (exitCode !== 0) throw extractionError();
      const buffer = await readFile(outputPath);
      if (!buffer.length || buffer.length > MAX_TEXT_BYTES) throw extractionError('PDF 提取文本为空或过大');
      const text = buffer.toString('utf8').replace(/\u0000/gu, '').trim();
      if (text.length < 20) throw extractionError();
      return text;
    } finally {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
