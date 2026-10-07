import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { JsonStore } from '../lib/account-store.mjs';

test('JsonStore keeps a .bak copy of the previous value before saving', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'light-chat-store-'));
  const path = join(dir, 'data.json');
  const store = new JsonStore(path, { version: 1, favoriteMediaIds: [] });

  await store.save({ version: 1, favoriteMediaIds: ['first-id'] });
  await store.save({ version: 1, favoriteMediaIds: [] });

  const backup = JSON.parse(await readFile(`${path}.bak`, 'utf8'));
  assert.deepEqual(backup.favoriteMediaIds, ['first-id']);
  await rm(dir, { recursive: true, force: true });
});

test('JsonStore restores a corrupt primary from .bak, preserves the damaged file, and keeps the backup intact', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'light-chat-store-'));
  const path = join(dir, 'data.json');
  await writeFile(path, '{"version":1,"favoriteMediaIds":["tru');
  await writeFile(`${path}.bak`, JSON.stringify({ version: 1, favoriteMediaIds: ['kept-id'] }));
  const store = new JsonStore(path, { version: 1, favoriteMediaIds: [] });

  const loaded = await store.load();
  assert.deepEqual(loaded.favoriteMediaIds, ['kept-id']);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')).favoriteMediaIds, ['kept-id']);
  const files = await readdir(dir);
  const corrupt = files.find((name) => name.startsWith('data.json.corrupt-'));
  assert.ok(corrupt, 'damaged file must be preserved');
  assert.equal(await readFile(join(dir, corrupt), 'utf8'), '{"version":1,"favoriteMediaIds":["tru');

  // The next save rotates the restored (valid) primary, never the damaged bytes.
  await store.save({ version: 1, favoriteMediaIds: ['kept-id', 'new-id'] });
  assert.deepEqual(JSON.parse(await readFile(`${path}.bak`, 'utf8')).favoriteMediaIds, ['kept-id']);
  await rm(dir, { recursive: true, force: true });
});

test('JsonStore refuses to load when both the primary and the backup are unusable, without writing anything', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'light-chat-store-'));
  const path = join(dir, 'data.json');
  await writeFile(path, 'not json');
  await writeFile(`${path}.bak`, 'also not json');
  const store = new JsonStore(path, { version: 1, favoriteMediaIds: [] });

  await assert.rejects(() => store.load(), /拒绝启动/);
  assert.equal(await readFile(path, 'utf8'), 'not json');
  assert.equal(await readFile(`${path}.bak`, 'utf8'), 'also not json');
  await rm(dir, { recursive: true, force: true });
});

test('JsonStore restores a missing primary from .bak instead of starting empty', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'light-chat-store-'));
  const path = join(dir, 'data.json');
  await writeFile(`${path}.bak`, JSON.stringify({ version: 1, favoriteMediaIds: ['from-backup'] }));
  const store = new JsonStore(path, { version: 1, favoriteMediaIds: [] });

  assert.deepEqual((await store.load()).favoriteMediaIds, ['from-backup']);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')).favoriteMediaIds, ['from-backup']);
  await rm(dir, { recursive: true, force: true });
});

test('JsonStore save without a prior load never rotates a damaged primary into .bak', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'light-chat-store-'));
  const path = join(dir, 'data.json');
  await writeFile(path, '{broken');
  await writeFile(`${path}.bak`, JSON.stringify({ version: 1, favoriteMediaIds: ['good'] }));
  const store = new JsonStore(path, { version: 1, favoriteMediaIds: [] });

  await store.save({ version: 1, favoriteMediaIds: ['written'] });
  assert.deepEqual(JSON.parse(await readFile(`${path}.bak`, 'utf8')).favoriteMediaIds, ['good']);
  assert.ok((await readdir(dir)).some((name) => name.startsWith('data.json.corrupt-')));
  await rm(dir, { recursive: true, force: true });
});
