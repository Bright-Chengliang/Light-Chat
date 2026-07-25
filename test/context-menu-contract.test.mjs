import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [appSource, appHtml, styles] = await Promise.all([
  readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
  readFile(new URL('../public/app.html', import.meta.url), 'utf8'),
  readFile(new URL('../public/styles.css', import.meta.url), 'utf8'),
]);

test('context menus use stable favorite identity and serialize destructive menu actions', () => {
  assert.doesNotMatch(appSource, /contextFavoriteItemIndex/);
  assert.match(appSource, /contextFavoriteModelId/);
  assert.match(appSource, /contextFavoriteMode/);
  assert.match(appSource, /preferenceContextMutationInFlight/);
  assert.match(appSource, /roleContextMutationInFlight/);
});

test('context menu keyboard and focus lifecycle is explicit', () => {
  assert.match(appSource, /\['ContextMenu', 'Apps'\]/);
  assert.match(appSource, /event\.shiftKey && event\.key === 'F10'/);
  for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End', 'Escape', 'Tab']) assert.match(appSource, new RegExp(`event\\.key === '${key}'|'${key}'`));
  assert.match(appSource, /closeAllContextMenus\(\{ restoreFocus: true \}\)/);
  assert.match(appSource, /restoreContextMenuFocus/);
});

test('context menu semantics, touch entry, and destructive separation remain present', () => {
  assert.ok((appHtml.match(/role="menu"/g) || []).length >= 5);
  assert.ok((appHtml.match(/role="separator"/g) || []).length >= 4);
  assert.ok((appHtml.match(/aria-orientation="vertical"/g) || []).length >= 5);
  assert.match(appSource, /className = 'item-menu-button'/);
  assert.match(styles, /@media \(hover: none\)[\s\S]*\.item-menu-button/);
  assert.match(styles, /\.context-menu \.danger-menu-item \{ color: var\(--danger\); \}/);
});

test('menu scrolling and export concurrency have regression guards', () => {
  assert.match(appSource, /activeContextMenu\?\.contains\(event\.target\)/);
  assert.match(appSource, /markdownZipExportInFlight/);
  assert.match(appSource, /模型仍在生成，完成后再导出对话/);
  assert.match(appSource, /const conversation = structuredClone\(source\)/);
});

test('history context menus can jump directly to an associated role card', () => {
  assert.match(appHtml, /id="jumpToRoleFromConversation"/);
  assert.match(appSource, /function jumpToRoleFromConversationContext\(\)/);
  assert.match(appSource, /elements\.jumpToRoleFromConversation\.disabled = !roleId/);
  assert.match(appSource, /openSidebarDrawer\(`role:\$\{roleId\}`\); openSidebar\(\)/);
  assert.match(appSource, /该对话使用默认助手，没有可跳转的自定义角色卡/);
});

test('history context menus can regenerate a title from existing user messages', () => {
  assert.match(appHtml, /id="regenerateConversationTitle"/);
  assert.match(appSource, /function regenerateConversationTitleFromContext\(\)/);
  assert.match(appSource, /function conversationTitleSource\(conversation\)/);
  assert.match(appSource, /elements\.regenerateConversationTitle\.disabled = !titleSource/);
});

test('role-card conversation history reuses the full conversation context menu', () => {
  const bindings = appSource.match(/bindContextMenuTrigger\(conversationButton, 'historyContextMenu', \(x, y, trigger\) => openHistoryContextMenu\(conversation\.id, x, y, trigger\)\)/g) || [];
  assert.ok(bindings.length >= 2);
  assert.match(appSource, /跳转到对话：\$\{conversation\.title\}；右键管理/);
});
