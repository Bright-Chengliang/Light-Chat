import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [appSource, styles] = await Promise.all([
  readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
  readFile(new URL('../public/styles.css', import.meta.url), 'utf8'),
]);

test('assistant regenerate button uses the currently active model instead of the original response model', () => {
  assert.match(appSource, /function regenerateAssistantWithCurrentModel\(messageId\)/);
  assert.match(appSource, /regenerateAssistantWithCurrentModel\(message\.id\)/);
  assert.match(appSource, /regenerateAssistant\(messageId, selection\.modelId\)/);
  assert.match(appSource, /regenerateImageAssistant\(messageId, selection\.modelId\)/);
  assert.doesNotMatch(appSource, /regenerateAssistant\(message\.id, message\.modelId\)/);
});

test('regeneration keeps an in-place pending variant so earlier responses remain switchable', () => {
  const imageRegeneration = appSource.slice(appSource.indexOf('async function regenerateImageAssistant'), appSource.indexOf('async function regenerateAssistant'));
  const chatRegeneration = appSource.slice(appSource.indexOf('async function regenerateAssistant'), appSource.indexOf('async function sendMessage'));
  assert.match(appSource, /function beginRegenerationVariant\(conversation, message, draft\)/);
  assert.match(appSource, /function syncRegenerationDraft\(draft, conversationId = state\.currentId\)/);
  assert.match(appSource, /function finishRegenerationVariant\(conversation, message, draft, \{ cancelled = false \} = \{\}\)/);
  assert.match(imageRegeneration, /beginRegenerationVariant\(conversation, message, draft\)/);
  assert.match(chatRegeneration, /beginRegenerationVariant\(conversation, message, draft\)/);
  assert.doesNotMatch(imageRegeneration, /conversation\.messages\.push\(draft\)/);
  assert.doesNotMatch(chatRegeneration, /conversation\.messages\.push\(draft\)/);
  assert.match(appSource, /message\.regeneration\?\.pendingIndex === message\.variantIndex \? ' · 生成中' : ''/);
  assert.match(appSource, /message\.regeneration\?\.pendingIndex === index && isConversationBusy\(conversation\.id\)/);
  assert.doesNotMatch(appSource, /previous\.disabled = message\.variantIndex <= 0 \|\| isConversationBusy\(\)/);
  assert.doesNotMatch(appSource, /next\.disabled = message\.variantIndex >= message\.variants\.length - 1 \|\| isConversationBusy\(\)/);
});

test('response model image-size choices remain readable in the @ model menu', () => {
  assert.match(appSource, /sizeButton\.setAttribute\('role', 'menuitem'\)/);
  assert.match(styles, /\.variant-model-menu \{ width: min\(320px, calc\(100vw - 16px\)\);/);
  assert.match(styles, /\.variant-image-size-menu \{[^}]*width: calc\(100% - 12px\);[^}]*flex-direction: column/);
  assert.match(styles, /\.variant-image-size-menu button \{[^}]*width: 100%/);
  assert.match(styles, /\.variant-image-size-menu button \{[^}]*overflow: hidden;[^}]*text-overflow: ellipsis/);
});
