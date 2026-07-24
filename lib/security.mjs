import {
  createHash,
  createHmac,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from 'node:crypto';
import { isIP } from 'node:net';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);

export const PASSWORD_LIMITS = Object.freeze({ min: 10, max: 128 });
export const USERNAME_LIMITS = Object.freeze({ min: 3, max: 64 });
export const SCRYPT_PARAMS = Object.freeze({ N: 32768, r: 8, p: 1, keyLength: 64 });

export function validateUsername(value) {
  if (typeof value !== 'string') throw publicError(400, '用户名格式无效');
  const username = value.trim();
  if (
    username.length < USERNAME_LIMITS.min
    || username.length > USERNAME_LIMITS.max
    || !/^[\p{L}\p{N}_.-]+$/u.test(username)
  ) {
    throw publicError(400, '用户名需为 3–64 位字母、数字、点、下划线或连字符');
  }
  return username;
}

export function validatePassword(value) {
  if (
    typeof value !== 'string'
    || value.length < PASSWORD_LIMITS.min
    || value.length > PASSWORD_LIMITS.max
  ) {
    throw publicError(400, '密码长度需为 10–128 位');
  }
  return value;
}

export async function hashPassword(password) {
  validatePassword(password);
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, SCRYPT_PARAMS.keyLength, {
    N: SCRYPT_PARAMS.N,
    r: SCRYPT_PARAMS.r,
    p: SCRYPT_PARAMS.p,
    maxmem: 64 * 1024 * 1024,
  });
  return {
    algorithm: 'scrypt',
    salt: salt.toString('base64'),
    hash: Buffer.from(derived).toString('base64'),
    params: { ...SCRYPT_PARAMS },
  };
}

export async function verifyPassword(password, record) {
  if (typeof password !== 'string' || !record || record.algorithm !== 'scrypt') return false;
  try {
    const salt = Buffer.from(record.salt, 'base64');
    const expected = Buffer.from(record.hash, 'base64');
    const params = record.params || SCRYPT_PARAMS;
    if (salt.length !== 16 || expected.length !== params.keyLength) return false;
    const actual = await scrypt(password, salt, params.keyLength, {
      N: params.N,
      r: params.r,
      p: params.p,
      maxmem: 64 * 1024 * 1024,
    });
    return timingSafeEqual(expected, Buffer.from(actual));
  } catch {
    return false;
  }
}

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

export function hashToken(token) {
  return createHash('sha256').update(String(token)).digest('base64url');
}

export function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

export function hmac(secret, value) {
  return createHmac('sha256', String(secret)).update(String(value)).digest('hex');
}

export function constantTimeTextEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  if (a.length !== b.length) {
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

export function assertUsername(value) {
  return validateUsername(value);
}

export function assertPassword(value, { current = false } = {}) {
  if (current) {
    if (typeof value !== 'string' || value.length < 1 || value.length > 128 || value.includes('\0')) {
      throw publicError(400, '密码格式无效', 'INVALID_PASSWORD');
    }
    return value;
  }
  return validatePassword(value);
}

export function safeTokenEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function parseCookies(header = '') {
  const cookies = {};
  for (const part of String(header).split(';')) {
    const separator = part.indexOf('=');
    if (separator < 1) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      cookies[name] = value;
    }
  }
  return cookies;
}

export function sessionCookie(name, value, { secure = false, maxAge = 43_200 } = {}) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${Math.max(0, Math.floor(maxAge))}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function canonicalOrigin(req) {
  const secure = req.socket?.encrypted || req.headers['x-forwarded-proto'] === 'https';
  return `${secure ? 'https' : 'http'}://${req.headers.host}`;
}

export function hasValidOrigin(req, allowedHosts = []) {
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || origin.length > 300) return false;
  try {
    const parsed = new URL(origin);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return false;
    const host = String(req.headers.host || '').toLowerCase();
    const allowed = new Set([host, ...allowedHosts.map((item) => item.toLowerCase())]);
    return allowed.has(parsed.host.toLowerCase());
  } catch {
    return false;
  }
}

export function isLoopbackAddress(value) {
  const ip = String(value || '').replace(/^::ffff:/, '');
  return ip === '::1' || ip.startsWith('127.');
}

export function getClientIp(req, { trustProxy = false } = {}) {
  const remote = String(req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
  if (!trustProxy || !isLoopbackAddress(remote)) return remote;
  const cfIp = req.headers['cf-connecting-ip'];
  if (typeof cfIp === 'string' && isIP(cfIp.trim())) return cfIp.trim();
  return remote;
}

export function publicError(status, message, code = undefined) {
  const error = new Error(message);
  error.status = status;
  if (code) error.code = code;
  return error;
}

export function setSecurityHeaders(req, res, { forwardedHttps = false } = {}) {
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "connect-src 'self'",
    "img-src 'self' data: blob:",
    "style-src 'self'",
    "script-src 'self'",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; '));
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  if (forwardedHttps || req.socket?.encrypted) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
}

export function sendJson(res, status, payload, extraHeaders = {}) {
  if (res.writableEnded) return;
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(JSON.stringify(payload));
}

export function sendSse(res, event, payload) {
  if (res.destroyed || res.writableEnded) return;
  res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

export async function readBody(req, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) throw publicError(413, '请求内容过大', 'PAYLOAD_TOO_LARGE');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function readJson(req, maxBytes) {
  const contentType = String(req.headers['content-type'] || '').toLowerCase();
  if (!contentType.startsWith('application/json')) {
    throw publicError(415, '仅接受 JSON 请求', 'UNSUPPORTED_MEDIA_TYPE');
  }
  const buffer = await readBody(req, maxBytes);
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch {
    throw publicError(400, '请求格式无效', 'INVALID_JSON');
  }
}

export async function readLimitedResponse(response, maxBytes) {
  if (!response.body) return Buffer.alloc(0);
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.length;
    if (total > maxBytes) throw publicError(502, '模型服务返回内容过大', 'UPSTREAM_TOO_LARGE');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function validateRasterDataUrl(value, { maxBytes = 6 * 1024 * 1024 } = {}) {
  if (typeof value !== 'string') throw publicError(400, '图片格式无效');
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) throw publicError(415, '仅支持 PNG、JPEG 或 WebP 图片');
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.length === 0 || bytes.length > maxBytes) throw publicError(413, '单张图片不能超过 6 MB');
  const roundTrip = bytes.toString('base64').replace(/=+$/, '');
  if (roundTrip !== match[2].replace(/=+$/, '')) throw publicError(400, '图片编码无效');
  const type = match[1];
  const validMagic = (
    (type === 'png' && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    || (type === 'jpeg' && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9)
    || (type === 'webp' && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP')
  );
  if (!validMagic) throw publicError(415, '图片内容与格式不匹配');
  return { mime: `image/${type}`, bytes };
}
