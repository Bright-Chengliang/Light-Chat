import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [appSource, appHtml, styles] = await Promise.all([
  readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
  readFile(new URL('../public/app.html', import.meta.url), 'utf8'),
  readFile(new URL('../public/styles.css', import.meta.url), 'utf8'),
]);

test('favorite conversations put the latest favorite or interaction first', () => {
  assert.match(appSource, /favoriteOrder: Number\.isSafeInteger\(item\.favoriteOrder\)/);
  assert.match(appSource, /favoritedAt: Number\.isFinite\(item\.favoritedAt\)/);
  assert.match(appSource, /function favoriteConversationActivityAt\(conversation\)/);
  assert.match(appSource, /function favoriteConversations\(\)/);
  assert.match(appSource, /function normalizeFavoriteConversationOrder\(\)/);
  assert.match(appSource, /favoriteConversationActivityAt\(right\) - favoriteConversationActivityAt\(left\)/);
  assert.match(appSource, /conversation\.favoritedAt = Date\.now\(\)/);
  assert.doesNotMatch(appSource, /text\/x-light-chat-favorite-conversation/);
});

test('favorite conversations are available from the sidebar and conversation context menu', () => {
  assert.match(appHtml, /id="openFavoriteConversationsDrawer"/);
  assert.match(appHtml, /data-sidebar-drawer-panel="favorite-conversations"/);
  assert.match(appHtml, /id="favoriteConversations"/);
  assert.match(appHtml, /id="toggleFavoriteConversation"/);
  assert.match(appSource, /bindContextMenuTrigger\(conversationMenuTrigger, 'historyContextMenu'/);
  assert.match(appSource, /function toggleFavoriteConversationFromContext\(\)/);
  assert.match(styles, /\.favorite-conversation-item \{/);
  assert.match(styles, /grid-template-columns: minmax\(0, 1fr\) auto/);
  assert.doesNotMatch(styles, /\.favorite-conversation-handle/);
});
