import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [appSource, styles] = await Promise.all([
  readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
  readFile(new URL('../public/styles.css', import.meta.url), 'utf8'),
]);

test('sidebar role cards support persisted drag ordering and folder moves', () => {
  assert.match(appSource, /async function moveRoleByDrag\(sourceRoleId, \{ targetRoleId = '', targetFolderId = '', before = false \} = \{\}\)/);
  assert.match(appSource, /text\/x-light-chat-role/);
  assert.match(appSource, /entry\.draggable = true/);
  assert.match(appSource, /void moveRoleByDrag\(sourceRoleId, \{ targetRoleId: role\.id, before:/);
  assert.match(appSource, /void moveRoleByDrag\(sourceRoleId, \{ targetFolderId: folder\.id \}\)/);
  assert.match(appSource, /roleRequest\('\/api\/roles', \{ method: 'PUT'/);
  assert.match(styles, /\.role-entry\.drag-over/);
  assert.match(styles, /\.role-folder\.role-drag-over/);
});
