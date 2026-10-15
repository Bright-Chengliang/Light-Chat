import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const appSource = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const htmlSource = await readFile(new URL('../public/app.html', import.meta.url), 'utf8');
const styleSource = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
const backendSource = await readFile(new URL('../lib/app.mjs', import.meta.url), 'utf8');

test('admin and user accounts can register multiple browser-local OpenAI-compatible endpoints', () => {
  assert.match(appSource, /const CUSTOM_CONNECTIONS_KEY_PREFIX = 'light-chat-custom-connections-v1'/);
  assert.match(appSource, /const CUSTOM_MODEL_PREFIX = 'custom\/'/);
  assert.match(appSource, /function loadCustomConnections\(\) \{\s*if \(state\.userRole === 'guest'\) \{ state\.customConnections = \[\]; return state\.customConnections; \}/);
  assert.match(appSource, /function saveCustomConnections\(connections = state\.customConnections\)/);
  assert.match(appSource, /localStorage\.setItem\(customConnectionsStorageKey\(\)/);
});

test('custom models are namespaced, merged with the server catalog, and grouped in pickers', () => {
  assert.match(appSource, /function customModelId\(connectionId, rawId\)/);
  assert.match(appSource, /function parseCustomModelId\(modelId\)/);
  assert.match(appSource, /function withCustomModels\(models\)/);
  assert.match(appSource, /function setServerModels\(next\)/);
  assert.match(appSource, /const merged = state\.userRole === 'guest' \? next : withCustomModels\(next\)/);
  assert.match(appSource, /sections\.push\(\{ title: `端点 · \$\{connection\.name\}`, models \}\)/);
  assert.match(appSource, /heading\.className = 'model-list-group-title'/);
  assert.match(appSource, /model\.connectionId \? \(model\.connectionName \|\| '自定义端点'\) : modelProviderLabel\(model\.id\)/);
  assert.match(styleSource, /\.model-list-group-title/);
});

test('direct routing covers chat, images, translation, titles, regeneration and continuation', () => {
  assert.match(appSource, /function usesDirectResponse\(modelId\)/);
  assert.match(appSource, /return customDirectFetch\(payload\.model, '\/chat\/completions'/);
  assert.match(appSource, /if \(parseCustomModelId\(payload\.model\)\) \{\s*await directRequestGeneratedImages/);
  assert.match(appSource, /const directRequest = usesDirectResponse\(model\);/);
  assert.match(appSource, /const titleModel = availableConversationTitleModel\(\) \|\| preferredModel\('chat'\)/);
  assert.match(appSource, /usesDirectResponse\(titleModel\)/);
  assert.match(appSource, /state\.userRole === 'guest' \|\| directRequest \? consumeGuestSse : consumeSse/);
  assert.match(appSource, /state\.userRole === 'guest' \|\| requestCustom \? consumeGuestSse : consumeSse/);
  assert.match(appSource, /if \(response\.status === 401 && !requestCustom\)/);
  assert.match(appSource, /if \(response\.status === 401 && !directRequest\)/);
});

test('custom favorites and context limits survive device-local endpoint changes', () => {
  assert.match(appSource, /if \(parseCustomModelId\(modelId\)\) return \['chat', 'image'\]\.includes\(item\.mode\)/);
  assert.match(appSource, /allowed\.has\(modelId\) \|\| Boolean\(parseCustomModelId\(modelId\)\)/);
  assert.match(appSource, /if \(parseCustomModelId\(modelId\)\) continue;/);
  assert.match(backendSource, /function isCustomModelId\(modelId\)/);
  assert.match(backendSource, /if \(!model && !isCustomModelId\(modelId\)\)/);
  assert.match(backendSource, /if \(!allowed\.has\(modelId\) && !isCustomModelId\(modelId\)\)/);
  assert.match(backendSource, /if \(isCustomModelId\(modelId\)\) return modelId;/);
});

test('the settings dialog exposes the endpoint editor markup and handlers', () => {
  assert.match(htmlSource, /id="customConnectionSettings"/);
  assert.match(htmlSource, /id="customConnectionList"/);
  assert.match(htmlSource, /id="customConnectionEditor"/);
  assert.match(htmlSource, /id="customConnectionNameInput"/);
  assert.match(htmlSource, /id="customConnectionEndpointInput"/);
  assert.match(htmlSource, /id="customConnectionApiKeyInput"/);
  assert.match(htmlSource, /id="customConnectionFetchModelsButton"/);
  assert.match(htmlSource, /id="customConnectionSaveButton"/);
  assert.match(htmlSource, /id="customConnectionModelsList"/);
  assert.match(htmlSource, /id="customConnectionAddButton"/);
  assert.match(appSource, /elements\.customConnectionSettings\.hidden = isGuest;/);
  assert.match(appSource, /function renderCustomConnections\(\)/);
  assert.match(appSource, /function beginCustomConnectionEdit\(connectionId = ''\)/);
  assert.match(appSource, /function saveCustomConnection\(\)/);
  assert.match(appSource, /function deleteCustomConnection\(connectionId\)/);
  assert.match(appSource, /await loadGuestDirectModels\(\{ endpoint, apiKey, allowedModels: \[\] \}\)/);
});

test('custom model display names keep the namespaced ids out of the interface', () => {
  assert.match(appSource, /function modelDisplayName\(modelId\)/);
  assert.match(appSource, /const selectedDisplay = modelDisplayName\(state\.selected\.modelId\) \|\| state\.selected\.modelId/);
  assert.match(appSource, /strong\.textContent = modelDisplayName\(model\.id\) \|\| model\.id/);
  assert.match(appSource, /option\.textContent = modelDisplayName\(model\.id\) \|\| model\.id/);
});
