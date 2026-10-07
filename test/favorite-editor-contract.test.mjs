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

test('model catalog is refreshed before favorites are offered or saved', () => {
  assert.match(appSource, /async function syncModels\(\{ force = false \} = \{\}\)/);
  assert.match(appSource, /function modelsAreStale\(maxAgeMs = 60_000\)/);
  assert.match(appSource, /if \(!isGuest && modelsAreStale\(\)\) await syncModels\(\);/);
  assert.match(appSource, /state\.userRole !== 'guest' && modelsAreStale\(\)/);
  assert.match(appSource, /syncModels\(\)\.then\(\(result\) => \{/);
  assert.match(appSource, /function refreshModelDialogCatalog\(\)/);
  assert.match(appSource, /payload\.details && typeof payload\.details === 'object'\) error\.details = payload\.details/);
});

test('unavailable favorites stay visible, are named on save, and block silent drops', () => {
  assert.match(appSource, /（不可用）/);
  assert.match(appSource, /favorite-row-stale/);
  assert.match(appSource, /function highlightFavoriteRows\(details = \{\}\)/);
  assert.match(appSource, /function collectDroppedFavorites\(requestedGroups, sanitizedGroups\)/);
  assert.match(appSource, /collectDroppedFavorites\(nextPreferences\.favoriteGroups, sanitizedFavoriteGroups\)/);
  assert.match(appSource, /error\.details = \{ reason: 'not_in_catalog', scope: 'favorite', items: dropped \}/);
  assert.match(appSource, /请先改选或移除/);
  assert.match(appSource, /当前没有支持\$\{modeLabelText\(nextMode\)\}模式的可用模型/);
  assert.match(appSource, /state\.editingDirty = true;/);
});

test('favorite models are picked in a full-size browser instead of a squeezed native select', () => {
  assert.match(appSource, /function openFavoriteModelPicker\(\{ title, description = '', mode = 'chat', multiple = false, existing = \[\], currentModelId = '', limit = Infinity, onConfirm \}\)/);
  // Adding opens the browser in multi-select mode and keeps already-added models disabled.
  assert.match(appSource, /multiple: true,\s+existing: group\.items\.map\(/);
  assert.match(appSource, /limit: 20 - group\.items\.length/);
  // Each row shows the full model ID as a button that opens the browser.
  assert.match(appSource, /model\.className = 'favorite-model-button'/);
  assert.doesNotMatch(appSource, /const model = document\.createElement\('select'\); model\.setAttribute\('aria-label', '模型'\)/);
  // Replacing a model also adopts the mode chosen in the browser.
  assert.match(appSource, /updateFavoriteModel\(item, pick\.modelId\);\s+item\.mode = pick\.mode;/);
});
