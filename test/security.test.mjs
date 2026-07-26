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

test('persisted media has no record-count or expiry limit while browsing stays paginated', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chat-media-pages-'));
  try {
    const first = new MediaStore(root, { defaultOwnerId: '00000' }); await first.initialize();
    for (let index = 0; index < 51; index += 1) await first.save(tinyPng(10 + index, 9), { sessionId: '00000', kind: 'output', alt: `image-${index}` });
    const pageOne = first.listRecent('00000', { page: 1, limit: 50 });
    const pageTwo = first.listRecent('00000', { page: 2, limit: 50 });
    assert.deepEqual({ total: pageOne.total, totalPages: pageOne.totalPages, pageSize: pageOne.pageSize }, { total: 51, totalPages: 2, pageSize: 50 });
    assert.equal(pageOne.files.length, 50);
    assert.equal(pageTwo.files.length, 1);
    const neighbors = first.recentImageNeighbors('00000', pageOne.files[25].id);
    assert.equal(neighbors.previous.id, pageOne.files[24].id);
    assert.equal(neighbors.next.id, pageOne.files[26].id);
    assert.deepEqual({ position: neighbors.position, total: neighbors.total }, { position: 26, total: 51 });
    assert.deepEqual(first.recentImageNeighbors('00000', pageTwo.files[0].id), { previous: pageOne.files[49], next: null, position: 51, total: 51 });
    assert.equal(first.get(pageOne.files[0].id, '00000').expiresAt, null);
    first.close();

    const second = new MediaStore(root, { defaultOwnerId: '00000' }); await second.initialize();
    assert.equal(second.listRecent('00000', { page: 2, limit: 50 }).total, 51);
    second.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('historical image recovery accepts byte-identical duplicates but rejects different candidates', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chat-media-recovery-'));
  try {
    const store = new MediaStore(root, { defaultOwnerId: '00000' }); await store.initialize();
    const image = tinyPng(12, 9);
    const source = await store.save(image, { sessionId: '00000', kind: 'output', alt: 'source' });
    const legacy = 'R'.repeat(32);
    await store.restoreImageAlias(legacy, store.get(source.id, '00000'), { sessionId: '00000', kind: 'output' });
    const recovered = await store.findRecoverableImage({ size: image.length, mimeType: 'image/png' }, '00000');
    assert.ok(recovered);

    const different = Buffer.from(image); different[different.length - 1] ^= 1;
    await store.save(different, { sessionId: '00000', kind: 'output', alt: 'different' });
    assert.equal(await store.findRecoverableImage({ size: image.length, mimeType: 'image/png' }, '00000'), null);
    store.close();
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
