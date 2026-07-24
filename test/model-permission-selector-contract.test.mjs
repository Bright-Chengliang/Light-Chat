import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [appSource, styles] = await Promise.all([
  readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
  readFile(new URL('../public/styles.css', import.meta.url), 'utf8'),
]);

test('model permission selectors filter existing checkbox nodes without losing selection', () => {
  assert.match(appSource, /function modelPermissionSelector\(/);
  assert.match(appSource, /search\.type = 'search'/);
  assert.match(appSource, /entry\.label\.hidden = !matches/);
  assert.match(appSource, /entries\.filter\(\(entry\) => !entry\.label\.hidden\)/);
  assert.doesNotMatch(appSource, /function modelPermissionGrid\(/);
});

test('select all only enables visible search results and is reused by both admin editors', () => {
  assert.match(appSource, /for \(const entry of visibleEntries\(\)\)/);
  assert.match(appSource, /if \(entry\.input\.checked\) continue/);
  assert.match(appSource, /onChange\(entry\.modelId, true\)/);
  assert.equal((appSource.match(/modelPermissionSelector\(/g) || []).length, 3);
  assert.match(styles, /\.model-permission-toolbar/);
  assert.match(styles, /\.model-permission-select-all/);
  assert.match(styles, /\.model-check-grid label\[hidden\] \{ display: none; \}/);
});
