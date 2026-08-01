import { lookup } from 'node:dns/promises';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { dirname } from 'node:path';
import { publicError } from './security.mjs';

export const GUEST_UID = 'guest';
export const GUEST_USERNAME = '游客';

export function guestPublicUser() {
  return {
    uid: GUEST_UID,
    username: GUEST_USERNAME,
    role: 'guest',
    disabled: false,
    credits: 0,
    usagePoints: 0,
    chatCalls: 0,
    imageCalls: 0,
    modelGroupId: null,
    modelGroupName: null,
    extraModels: [],
    createdAt: '',
    updatedAt: '',
  };
}

function privateIpv4(octets) {
  const [a, b] = octets;
  return a === 0
    || a === 10
    || a === 127
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 192 && (b === 0 || b === 18 || b === 19))
    || a >= 224;
}

function privateIpv6(address) {
  const normalized = address.toLowerCase();
  if (normalized === '::' || normalized === '::1') return true;
  if (normalized.startsWith('::ffff:')) {
    const v4 = normalized.slice(7).split('.');
    if (v4.length === 4 && v4.every((part) => /^\d{1,3}$/.test(part))) return privateIpv4(v4.map(Number));
    return false;
  }
  const first = Number.parseInt(normalized.split(':')[0], 16);
  return (first >= 0xfe80 && first <= 0xfebf)
    || (first >= 0xfc00 && first <= 0xfdff)
    || first >= 0xff00;
}

function privateAddress(address) {
  const version = isIP(address);
  if (!version) return false;
  return version === 4 ? privateIpv4(address.split('.').map(Number)) : privateIpv6(address);
}

export async function normalizeGuestEndpoint(value, { allowPrivate = false, resolveDns = true } = {}) {
  const raw = value === null || value === undefined ? '' : String(value).trim();
  if (!raw) return '';
  if (raw.length > 2048) throw publicError(400, 'API 服务端点过长', 'INVALID_GUEST_ENDPOINT');
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw publicError(400, 'API 服务端点格式无效', 'INVALID_GUEST_ENDPOINT');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw publicError(400, 'API 服务端点仅支持无内嵌凭据的 http/https 地址', 'INVALID_GUEST_ENDPOINT');
  }
  const hostname = url.hostname.toLowerCase();
  if (!hostname) throw publicError(400, 'API 服务端点格式无效', 'INVALID_GUEST_ENDPOINT');
  if (
    !allowPrivate
    && (
      hostname === 'localhost'
      || hostname.endsWith('.local')
      || hostname.endsWith('.internal')
      || hostname.endsWith('.home.arpa')
      || (isIP(hostname) && privateAddress(hostname))
    )
  ) {
    throw publicError(400, 'API 服务端点不能指向本机或内网地址', 'GUEST_ENDPOINT_NOT_ALLOWED');
  }
  if (!allowPrivate && resolveDns && !isIP(hostname)) {
    let addresses;
    try {
      addresses = await lookup(hostname, { all: true, verbatim: true });
    } catch {
      throw publicError(400, 'API 服务端点无法解析', 'GUEST_ENDPOINT_UNRESOLVED');
    }
    if (!addresses.length || addresses.some((entry) => privateAddress(entry.address))) {
      throw publicError(400, 'API 服务端点不能指向本机或内网地址', 'GUEST_ENDPOINT_NOT_ALLOWED');
    }
  }
  return url.href.replace(/\/+$/, '');
}

export function validateGuestModelIds(value) {
  if (!Array.isArray(value) || value.length > 200) {
    throw publicError(400, '可用模型列表无效', 'INVALID_GUEST_MODELS');
  }
  const seen = new Set();
  const normalized = [];
  for (const raw of value) {
    const id = typeof raw === 'string' ? raw.trim() : '';
    if (seen.has(id)) continue;
    if (!id || id.length > 200 || /[\u0000-\u001f\u007f]/.test(id)) {
      throw publicError(400, '可用模型列表无效', 'INVALID_GUEST_MODELS');
    }
    seen.add(id);
    normalized.push(id);
  }
  return normalized;
}

export class GuestStore {
  constructor(path, { allowPrivateEndpoints = false } = {}) {
    this.path = path;
    this.allowPrivateEndpoints = allowPrivateEndpoints;
    this.data = null;
    this.apiKey = '';
  }

  async initialize() {
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8'));
      this.data = await this.validateData(parsed, { resolveDns: false });
    } catch (error) {
      if (error?.code !== 'ENOENT') throw new Error('游客设置无法读取或格式无效，服务拒绝启动');
      this.data = { version: 1, endpoint: '', allowedModels: [] };
      await this.persist();
    }
    this.apiKey = '';
  }

  async validateData(parsed, { resolveDns = true } = {}) {
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.allowedModels)) throw new Error('invalid guest settings');
    return {
      version: 1,
      endpoint: await normalizeGuestEndpoint(parsed.endpoint, { allowPrivate: this.allowPrivateEndpoints, resolveDns }),
      allowedModels: validateGuestModelIds(parsed.allowedModels),
    };
  }

  async persist() {
    await mkdir(dirname(this.path), { recursive: true });
    const temp = `${this.path}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify(this.data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temp, this.path);
  }

  get endpoint() {
    return this.data?.endpoint || '';
  }

  get apiKeyValue() {
    return this.apiKey;
  }

  publicSettings() {
    return {
      endpoint: this.endpoint,
      hasApiKey: Boolean(this.apiKey),
      allowedModels: [...(this.data?.allowedModels || [])],
    };
  }

  allowedModelIds() {
    return new Set(this.data?.allowedModels || []);
  }

  canUseModel(modelId) {
    return Boolean(this.data?.allowedModels.includes(modelId));
  }

  async saveSettings({ endpoint, allowedModels, apiKey, clearApiKey = false } = {}) {
    this.data = {
      version: 1,
      endpoint: await normalizeGuestEndpoint(endpoint, { allowPrivate: this.allowPrivateEndpoints }),
      allowedModels: validateGuestModelIds(allowedModels),
    };
    await this.persist();
    if (clearApiKey === true) this.apiKey = '';
    else if (typeof apiKey === 'string' && apiKey.trim()) this.apiKey = apiKey.trim().slice(0, 512);
    return this.publicSettings();
  }
}
