import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AccountStore, sequentialUserUid } from '../lib/account-store.mjs';
import { LoginLimiter } from '../lib/login-limiter.mjs';
import { decodeDataImage, inspectRaster, MediaStore } from '../lib/media-store.mjs';
import { hashPassword, verifyPassword } from '../lib/security.mjs';
import { tinyPng } from './helpers.mjs';

test('scrypt password records verify without retaining plaintext', async () => {
  const record = await hashPassword('temporary-test-password');
  assert.equal(record.algorithm, 'scrypt');
  assert.equal(Object.values(record).includes('temporary-test-password'), false);
  assert.equal(await verifyPassword('temporary-test-password', record), true);
  assert.equal(await verifyPassword('wrong-password', record), false);
});

test('account changes require original credentials and replace the password hash', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chat-account-'));
  try {
    const store = new AccountStore(join(root, 'account.json'));
    await store.initialize('test-admin', 'temporary-test-password');
    assert.equal(store.uid, '00000');
    await assert.rejects(
      store.changeCredentials({ username: 'test-admin', currentPassword: 'wrong-password', newPassword: 'replacement-test-password' }),
      (error) => error.status === 401,
    );
    await store.changeCredentials({
      username: 'test-admin',
      currentPassword: 'temporary-test-password',
      newPassword: 'replacement-test-password',
    });
    assert.equal(await store.authenticate('test-admin', 'temporary-test-password'), false);
    assert.equal(await store.authenticate('test-admin', 'replacement-test-password'), true);
    assert.equal(store.uid, '00000');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('ordinary user UIDs are sequential seven-digit values', () => {
  assert.equal(sequentialUserUid(0), '0000000');
  assert.equal(sequentialUserUid(1), '0000001');
  assert.equal(sequentialUserUid(9_999_999), '9999999');
  assert.throws(() => sequentialUserUid(-1), RangeError);
  assert.throws(() => sequentialUserUid(10_000_000), RangeError);
});

test('raster validation accepts bounded PNG and rejects SVG/data type spoofing', () => {
  const png = tinyPng(16, 12);
  assert.deepEqual(inspectRaster(png), { mimeType: 'image/png', width: 16, height: 12 });
  const decoded = decodeDataImage(`data:image/png;base64,${png.toString('base64')}`);
  assert.equal(decoded.mimeType, 'image/png');
  assert.throws(() => inspectRaster(Buffer.from('<svg><script/></svg>')), (error) => error.status === 415);
  assert.throws(
    () => decodeDataImage(`data:image/svg+xml;base64,${Buffer.from('<svg/>').toString('base64')}`),
    (error) => error.status === 502,
  );
});

test('media metadata persists across restarts and remains UID-scoped', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chat-media-'));
  try {
    const first = new MediaStore(root, { defaultOwnerId: '00000' }); await first.initialize();
    const saved = await first.save(tinyPng(12, 9), { sessionId: '00000', kind: 'output', alt: 'persisted' }); first.close();
    const second = new MediaStore(root, { defaultOwnerId: '00000' }); await second.initialize();
    const loaded = await second.read(saved.id, '00000');
    assert.equal(loaded.record.alt, 'persisted');
    assert.equal(loaded.record.width, 12);
    await assert.rejects(second.read(saved.id, '0000000'), (error) => error.code === 'MEDIA_NOT_FOUND');
    second.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('login throttling blocks at the configured threshold and survives reload', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chat-login-limit-'));
  const path = join(root, 'limits.json');
  try {
    const limiter = new LoginLimiter(path);
    await limiter.initialize();
    for (let index = 0; index < 4; index += 1) {
      assert.equal((await limiter.failure('opaque-account-key')).blocked, false);
    }
    const blocked = await limiter.failure('opaque-account-key');
    assert.equal(blocked.blocked, true);
    assert.ok(blocked.retryAfter > 0);

    const reloaded = new LoginLimiter(path);
    await reloaded.initialize();
    assert.equal(reloaded.state('opaque-account-key').blocked, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
