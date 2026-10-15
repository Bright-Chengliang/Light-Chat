import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const appSource = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');

test('guest direct connection can be saved without an API key', () => {
  assert.doesNotMatch(appSource, /if \(!apiKey\) throw new Error\('请先填写 API 密钥'\)/);
  assert.match(appSource, /允许留空 API 密钥/);
  assert.match(appSource, /await loadGuestDirectModels\(\{ endpoint, apiKey, allowedModels: \[\] \}\)/);
});

test('guest fetch omits the Authorization header when no API key is configured', () => {
  assert.match(appSource, /if \(apiKey\) headers\.set\('Authorization', `Bearer \$\{apiKey\}`\)/);
});

test('guest save still requires an endpoint before touching the network', () => {
  assert.match(appSource, /if \(!endpoint\) throw new Error\('请先填写 API 服务端点'\)/);
});
