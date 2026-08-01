import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
