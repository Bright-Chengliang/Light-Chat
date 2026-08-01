import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createChatApp } from './lib/app.mjs';

const ROOT_DIR = dirname(fileURLToPath(import.meta.url));
const HOST = '127.0.0.1';
const PORT = Number.parseInt(process.env.CHAT_PORT || '3020', 10);
const UPSTREAM_BASE_URL = process.env.CHAT_UPSTREAM_BASE_URL || 'http://127.0.0.1:3002/v1';
const API_KEY = process.env.CHAT_UPSTREAM_API_KEY;
const BOOTSTRAP_USERNAME = process.env.CHAT_BOOTSTRAP_USERNAME;
const BOOTSTRAP_PASSWORD = process.env.CHAT_BOOTSTRAP_PASSWORD;
const SESSION_SECRET = process.env.CHAT_SESSION_SECRET;
const TRUST_PROXY = process.env.CHAT_TRUST_PROXY === 'true';
const ALLOWED_HOSTS = (process.env.CHAT_ALLOWED_HOSTS || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const DATA_DIR = process.env.CHAT_DATA_DIR ? resolve(process.env.CHAT_DATA_DIR) : undefined;

for (const name of [
  'CHAT_UPSTREAM_API_KEY',
  'CHAT_UPSTREAM_BASE_URL',
  'CHAT_BOOTSTRAP_USERNAME',
  'CHAT_BOOTSTRAP_PASSWORD',
  'CHAT_SESSION_SECRET',
  'CHAT_ALLOWED_HOSTS',
  'CHAT_DATA_DIR',
]) delete process.env[name];

if (!Number.isInteger(PORT) || PORT < 3020 || PORT > 4000) {
  console.error('CHAT_PORT 必须是 3020–4000 之间的端口。');
  process.exit(1);
}

const missing = [
  ['CHAT_UPSTREAM_API_KEY', API_KEY],
  ['CHAT_BOOTSTRAP_USERNAME', BOOTSTRAP_USERNAME],
  ['CHAT_BOOTSTRAP_PASSWORD', BOOTSTRAP_PASSWORD],
  ['CHAT_SESSION_SECRET', SESSION_SECRET],
].filter(([, value]) => !value).map(([name]) => name);

if (missing.length > 0) {
  console.error(`缺少服务端配置：${missing.join(', ')}`);
  console.error('请先运行 scripts/configure-secrets.ps1，再运行 scripts/start-server.ps1。');
  process.exit(1);
}

let app;
try {
  app = await createChatApp({
    rootDir: ROOT_DIR,
    ...(DATA_DIR ? { dataDir: DATA_DIR } : {}),
    apiKey: API_KEY,
    bootstrapUsername: BOOTSTRAP_USERNAME,
    bootstrapPassword: BOOTSTRAP_PASSWORD,
    sessionSecret: SESSION_SECRET,
    port: PORT,
    trustProxy: TRUST_PROXY,
    allowedHosts: ALLOWED_HOSTS,
    newApiBaseUrl: UPSTREAM_BASE_URL,
  });
} catch (error) {
  console.error(`服务初始化失败：${error?.message || '未知错误'}`);
  process.exit(1);
}

app.server.listen(PORT, HOST, () => {
  console.log(`Light-Chat 已启动：http://${HOST}:${PORT}`);
  console.log('模型服务：已安全配置（访问凭据仅保留在服务端进程内存）');
});

// Upstream image requests have their own 10-minute deadline. Keep Node from
// imposing a shorter whole-request deadline while a workflow job is running.
app.server.requestTimeout = 0;
app.server.headersTimeout = 65_000;
app.server.keepAliveTimeout = 65_000;

async function shutdown(signal) {
  console.log(`收到 ${signal}，正在安全停止服务。`);
  const force = setTimeout(() => process.exit(1), 5000);
  force.unref();
  await app.close();
  clearTimeout(force);
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
