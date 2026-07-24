import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [appSource, appHtml, styles] = await Promise.all([
  readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
  readFile(new URL('../public/app.html', import.meta.url), 'utf8'),
  readFile(new URL('../public/styles.css', import.meta.url), 'utf8'),
]);

test('favorite conversations persist independent manual ordering', () => {
  assert.match(appSource, /favoriteOrder: Number\.isSafeInteger\(item\.favoriteOrder\)/);
  assert.match(appSource, /function favoriteConversations\(\)/);
  assert.match(appSource, /function normalizeFavoriteConversationOrder\(\)/);
  assert.match(appSource, /function reorderFavoriteConversation\(conversationId, targetConversationId, before = false\)/);
  assert.match(appSource, /text\/x-light-chat-favorite-conversation/);
  assert.match(appSource, /favoriteOrder = index/);
});

test('favorite conversations are available from the sidebar and conversation context menu', () => {
  assert.match(appHtml, /id="openFavoriteConversationsDrawer"/);
  assert.match(appHtml, /data-sidebar-drawer-panel="favorite-conversations"/);
  assert.match(appHtml, /id="favoriteConversations"/);
  assert.match(appHtml, /id="toggleFavoriteConversation"/);
  assert.match(appSource, /bindContextMenuTrigger\(conversationMenuTrigger, 'historyContextMenu'/);
  assert.match(appSource, /function toggleFavoriteConversationFromContext\(\)/);
  assert.match(styles, /\.favorite-conversation-item \{/);
  assert.match(styles, /\.favorite-conversation-item\.drag-over/);
});
