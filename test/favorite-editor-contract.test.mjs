import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const appSource = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');

test('favorite editor adds an unused model in the group preferred mode', () => {
  assert.match(appSource, /function nextFavoriteCandidate\(group\)/);
  assert.match(appSource, /existing\.has\(`\$\{mode\}\\0\$\{candidate\}`\)/);
  assert.match(appSource, /items\.at\(-1\)\?\.mode \|\| state\.selected\?\.mode \|\| 'chat'/);
  assert.doesNotMatch(appSource, /add\.addEventListener\('click', \(\) => \{ const modelId = preferredModel\('chat'\)/);
});

test('favorite editor reveals and focuses the newly appended Android row', () => {
  assert.match(appSource, /function focusFavoriteEditorRow\(/);
  assert.match(appSource, /row\.scrollIntoView\(\{ block, inline: 'nearest', behavior: 'auto' \}\)/);
  assert.match(appSource, /renderGroupsEditor\(\{ focusFavorite: \{ groupId: group\.id, itemIndex \}, focusBlock: 'end' \}\)/);
  assert.match(appSource, /label: candidate\.modelId/);
  assert.match(appSource, /已添加 \$\{candidate\.modelId\}，保存设置后生效/);
});

test('default favorite display name follows model id without overwriting custom labels', () => {
  assert.match(appSource, /function updateFavoriteModel\(item, modelId\)/);
  assert.match(appSource, /const usesDefaultLabel = !item\.label \|\| item\.label === previousModelId/);
  assert.match(appSource, /if \(usesDefaultLabel\) item\.label = modelId/);
  assert.match(appSource, /label\.placeholder = item\.modelId \|\| item\.model \|\| '显示名称（默认模型 ID）'/);
});
