import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { dirname } from 'node:path';
import { hmac, parseCookies, publicError, randomToken, safeTokenEqual, sha256 } from './security.mjs';

const LOCAL_IPS = new Set(['127.0.0.1', '::1']);
const AUTH_TTL_MS = 12 * 60 * 60 * 1000;
const REMEMBERED_AUTH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const ANDROID_AUTH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const PREAUTH_TTL_MS = 30 * 60 * 1000;
const ANDROID_USER_AGENT_TOKEN = 'light-chat-android/';

async function atomicWriteJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temp, path);
}

function normalizeIp(value) {
  if (typeof value !== 'string') return null;
  let candidate = value.trim();
  if (candidate.startsWith('::ffff:')) candidate = candidate.slice(7);
  if (candidate.startsWith('[') && candidate.endsWith(']')) candidate = candidate.slice(1, -1);
  return isIP(candidate) ? candidate : null;
}

export class SessionManager {
  constructor({ secret, trustProxy = false, storagePath = null }) {
    this.secret = secret;
    this.trustProxy = trustProxy;
    this.storagePath = storagePath;
    this.sessions = new Map();
    this.persistQueue = Promise.resolve();
    this.timer = setInterval(() => this.cleanup(), 10 * 60 * 1000);
    this.timer.unref?.();
  }

  async initialize() {
    if (!this.storagePath) return;
    try {
      const parsed = JSON.parse(await readFile(this.storagePath, 'utf8'));
      if (parsed?.version !== 1 || !Array.isArray(parsed.sessions)) throw new Error('invalid session store');
      const now = Date.now();
      for (const entry of parsed.sessions) {
        const session = entry?.session;
        if (
          typeof entry?.tokenHash !== 'string' || !/^[a-f0-9]{64}$/.test(entry.tokenHash)
          || !session || session.authenticated !== true || session.persistent !== true
          || typeof session.id !== 'string' || typeof session.csrfToken !== 'string'
          || typeof session.username !== 'string' || typeof session.uid !== 'string'
          || !Number.isFinite(session.createdAt) || !Number.isFinite(session.lastSeenAt) || !Number.isFinite(session.expiresAt)
        ) throw new Error('invalid session record');
        if (session.expiresAt > now) this.sessions.set(entry.tokenHash, { ...session });
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw new Error('长期登录数据无法读取或格式无效，服务拒绝启动');
      await atomicWriteJson(this.storagePath, { version: 1, sessions: [] });
    }
    this.cleanup();
  }

  persistentSnapshot() {
    const now = Date.now();
    return {
      version: 1,
      sessions: [...this.sessions.entries()]
        .filter(([, session]) => session.persistent === true && session.authenticated === true && session.expiresAt > now)
        .map(([tokenHash, session]) => ({ tokenHash, session: { ...session } })),
    };
  }

  queuePersist() {
    if (!this.storagePath) return;
    const snapshot = this.persistentSnapshot();
    this.persistQueue = this.persistQueue.then(() => atomicWriteJson(this.storagePath, snapshot));
  }

  isTrustedProxyRequest(req) {
    return this.trustProxy && LOCAL_IPS.has(normalizeIp(req.socket.remoteAddress));
  }

  isHttps(req) {
    return Boolean(req.socket.encrypted)
      || (this.isTrustedProxyRequest(req) && req.headers['x-forwarded-proto'] === 'https');
  }

  clientIp(req) {
    const remote = normalizeIp(req.socket.remoteAddress);
    if (!remote) return null;
    if (!this.isTrustedProxyRequest(req)) return remote;
    return normalizeIp(req.headers['cf-connecting-ip']) || remote;
  }

  preferredCookieName(req) {
    return this.isHttps(req) ? '__Host-chat_session' : 'chat_session';
  }

  authenticatedTtl(req, remember = false) {
    const userAgent = String(req.headers['user-agent'] || '').toLocaleLowerCase('en-US');
    return userAgent.includes(ANDROID_USER_AGENT_TOKEN) || remember ? REMEMBERED_AUTH_TTL_MS : AUTH_TTL_MS;
  }

  shouldPersist(req, remember = false) {
    const userAgent = String(req.headers['user-agent'] || '').toLocaleLowerCase('en-US');
    return remember || userAgent.includes(ANDROID_USER_AGENT_TOKEN);
  }

  cookieHeader(req, token, maxAgeSeconds) {
    const secure = this.isHttps(req);
    return `${secure ? '__Host-chat_session' : 'chat_session'}=${token}; HttpOnly; `
      + `${secure ? 'Secure; ' : ''}SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}`;
  }

  clearCookieHeaders() {
    return [
      '__Host-chat_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0',
      'chat_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0',
    ];
  }

  tokenFromRequest(req) {
    const cookies = parseCookies(req.headers.cookie);
    return cookies.__Host_chat_session
      || cookies['__Host-chat_session']
      || cookies.chat_session
      || null;
  }

  find(req) {
    const token = this.tokenFromRequest(req);
    if (!token) return null;
    const session = this.sessions.get(sha256(token));
    if (!session || session.expiresAt <= Date.now()) {
      if (session) { this.sessions.delete(sha256(token)); this.queuePersist(); }
      return null;
    }
    session.lastSeenAt = Date.now();
    return { token, session };
  }

  create(req, { authenticated = false, username = null, uid = null, remember = false } = {}) {
    const token = randomToken(32);
    const now = Date.now();
    const ttl = authenticated ? this.authenticatedTtl(req, remember) : PREAUTH_TTL_MS;
    const session = {
      id: randomToken(18),
      csrfToken: randomToken(24),
      authenticated,
      username,
      uid,
      persistent: authenticated && this.shouldPersist(req, remember),
      createdAt: now,
      lastSeenAt: now,
      expiresAt: now + ttl,
    };
    this.sessions.set(sha256(token), session);
    if (session.persistent) this.queuePersist();
    return {
      token,
      session,
      cookie: this.cookieHeader(req, token, Math.floor(ttl / 1000)),
    };
  }

  rotate(req, previous, { authenticated, username, uid, remember = false }) {
    if (previous?.token) this.sessions.delete(sha256(previous.token));
    const rotated = this.create(req, { authenticated, username, uid, remember });
    if (!rotated.session.persistent) this.queuePersist();
    return rotated;
  }

  require(req) {
    const found = this.find(req);
    if (!found?.session.authenticated) {
      throw publicError(401, '请先登录', 'AUTH_REQUIRED');
    }
    return found;
  }

  requireCsrf(req, found) {
    const supplied = req.headers['x-csrf-token'];
    if (typeof supplied !== 'string' || !safeTokenEqual(supplied, found?.session.csrfToken)) {
      throw publicError(403, '安全令牌无效，请刷新页面后重试', 'CSRF_INVALID');
    }
  }

  invalidateAll() {
    this.sessions.clear();
    this.queuePersist();
  }

  invalidate(found) {
    if (found?.token && this.sessions.delete(sha256(found.token))) this.queuePersist();
  }

  invalidateUid(uid) {
    let changed = false;
    for (const [key, session] of this.sessions) if (session.uid === uid) { this.sessions.delete(key); changed = true; }
    if (changed) this.queuePersist();
  }

  async flush() {
    await this.persistQueue;
  }

  cleanup() {
    const now = Date.now();
    let changed = false;
    for (const [key, session] of this.sessions) {
      if (session.expiresAt <= now) { this.sessions.delete(key); changed = true; }
    }
    if (changed) this.queuePersist();
  }

  rateKey(ip, username) {
    return hmac(this.secret, `${ip}\0${String(username).toLowerCase()}`);
  }

  rateKeys(ip, username) {
    return [
      hmac(this.secret, `ip\0${ip}`),
      hmac(this.secret, `account\0${String(username).trim().toLowerCase()}`),
    ];
  }

  async close() {
    clearInterval(this.timer);
    this.cleanup();
    await this.persistQueue;
  }
}
