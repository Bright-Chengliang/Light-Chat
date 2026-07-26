import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const publicFiles = ['login.html', 'app.html', 'login.js', 'app.js', 'styles.css'];
const publicSource = (await Promise.all(
  publicFiles.map((file) => readFile(new URL(`../public/${file}`, import.meta.url), 'utf8')),
)).join('\n');
const backendSource = await readFile(new URL('../lib/app.mjs', import.meta.url), 'utf8');

test('browser-delivered assets and session metadata do not reveal the private model gateway', () => {
  assert.doesNotMatch(publicSource, /new[ -]?api|3002|3006|CHAT_NEWAPI|127\.0\.0\.1|localhost/i);
  assert.doesNotMatch(backendSource, /newApiConfigured\s*:/);
});

test('rendered blockquotes expose a hover and keyboard accessible copy shortcut', () => {
  assert.match(publicSource, /function decorateCopyableBlockquotes\(container\)/);
  assert.match(publicSource, /copy\.setAttribute\('aria-label', '复制引用内容'\)/);
  assert.match(publicSource, /blockquote:hover > \.quote-copy-button/);
  assert.match(publicSource, /blockquote:focus-within > \.quote-copy-button/);
  assert.match(publicSource, /blockquote\.prepend\(copy\)/);
  assert.match(publicSource, /\.quote-copy-button \{ position: sticky/);
  assert.match(publicSource, /\.code-toolbar \{ position: sticky/);
});

test('long messages use token-aware validation and a sticky duplicate action bar', () => {
  assert.doesNotMatch(backendSource, /MAX_MESSAGE_CHARS|MAX_TOTAL_CHARS/);
  assert.match(backendSource, /estimatedTokens: estimateTextTokens\(content\)/);
  assert.match(backendSource, /normalized\.slice\(retainedStart\)/);
  assert.match(backendSource, /CONTEXT_LIMIT_EXCEEDED/);
  assert.doesNotMatch(publicSource, /textarea\.maxLength = 50_000|content\.length > 50_000|slice\(0, 200_000\)/);
  assert.match(publicSource, /message-actions-floating/);
  assert.match(publicSource, /appendMessageJumpActions\(floatingActions, article\)/);
  assert.match(publicSource, /message-action-divider/);
  assert.match(publicSource, /message-jump-icon/);
  assert.match(publicSource, /createElementNS\('http:\/\/www\.w3\.org\/2000\/svg', 'svg'\)/);
  assert.match(publicSource, /place-items: center/);
  assert.match(publicSource, /scrollIntoView\(\{ behavior: 'instant', block \}\)/);
  assert.match(publicSource, /回到该消息顶部/);
  assert.match(publicSource, /跳到该消息底部/);
  assert.doesNotMatch(publicSource, /message-action-spacer/);
  assert.match(publicSource, /message-primary-actions/);
  assert.match(publicSource, /justify-content: space-evenly/);
  assert.match(publicSource, /document\.body\.append\(actions\)/);
  assert.match(publicSource, /function navigateMessageByEdge\(article, edge\)/);
  assert.match(publicSource, /navigation-pinned/);
  assert.match(publicSource, /message-navigation-active/);
  assert.match(publicSource, /\.message-actions-floating:not\(\.navigation-pinned\)/);
  assert.match(publicSource, /messages\[index - 1\]/);
  assert.match(publicSource, /messages\[index \+ 1\]/);
  assert.match(publicSource, /clearMessageNavigation\(\)/);
  assert.match(publicSource, /function alignFloatingMessageActions\(actions\)/);
  assert.match(publicSource, /floatingToolbarResizeObserver\.observe\(elements\.scroll\)/);
  assert.match(publicSource, /new IntersectionObserver/);
  assert.match(publicSource, /article\.getBoundingClientRect\(\)\.height > elements\.scroll\.clientHeight \* 0\.72/);
  assert.match(publicSource, /已用 \$\{usedPercent\.toLocaleString/);
});

test('completed history messages can branch while the current response is still generating', () => {
  const branchSource = publicSource.match(/function branchFromMessage\(messageId\) \{[\s\S]*?\n\}/)?.[0] || '';
  assert.match(publicSource, /function isGeneratingResponseMessage\(conversation, messageId\)/);
  assert.match(publicSource, /activeResponse\?\.role === 'assistant' && activeResponse\.id === messageId/);
  assert.match(publicSource, /branch\.disabled = generatingResponse/);
  assert.doesNotMatch(publicSource, /branch\.disabled = isConversationBusy\(\)/);
  assert.match(publicSource, /if \(isGeneratingResponseMessage\(source, messageId\)\)/);
  assert.match(branchSource, /saveConversations\(\); renderConversation\(\); updateSendState\(\); setStatus\(`已从第/);
  assert.doesNotMatch(branchSource, /closeSidebar\(\)/);
  assert.match(publicSource, /const canCreateResponse = messageIndex === conversation\?\.messages\.length - 1/);
  assert.match(publicSource, /const target = response \|\| \{/);
  assert.match(publicSource, /if \(!response\) conversation\.messages\.push\(target\)/);
});

test('remember login uses an origin-scoped username and a server-issued session instead of storing a password', () => {
  assert.match(publicSource, /light-chat:remembered-username/);
  assert.match(publicSource, /remember: rememberInput\.checked/);
  assert.doesNotMatch(publicSource, /localStorage\.(?:setItem|getItem)\([^\n]*password/i);
  assert.match(publicSource, /保持登录 30 天/);
  assert.match(publicSource, /无需再次输入密码/);
  assert.match(backendSource, /storagePath: join\(dataDir, 'sessions\.json'\)/);
});

test('credential changes push an immediate logout event to every active session', () => {
  assert.match(backendSource, /pathname === '\/api\/session\/events'/);
  assert.match(backendSource, /sendSse\(stream\.res, 'logout', \{ reason \}\)/);
  assert.match(backendSource, /await invalidateUidSessions\(found\.user\.uid, 'credentials_changed'\)/);
  assert.match(publicSource, /function startSessionRevocationListener\(\)/);
  assert.match(publicSource, /new EventSource\('\/api\/session\/events'\)/);
  assert.match(publicSource, /events\.addEventListener\('logout'/);
});

test('streaming Markdown updates a stable message body at a capped frame rate', () => {
  assert.match(publicSource, /const STREAM_RENDER_FPS = 30/);
  assert.match(publicSource, /function streamingMarkdownSource\(value\)/);
  assert.match(publicSource, /renderRichText\(text, message\.streaming \? streamingMarkdownSource\(message\.content\) : message\.content, \{ streaming: message\.streaming, sourceValue: message\.content \}\)/);
  assert.match(publicSource, /function updateStreamingMessage\(message, conversationId = state\.currentId\)/);
  assert.match(publicSource, /streamingRenderSnapshots\.get\(existing\)/);
  assert.match(publicSource, /setTimeout\(\(\) => \{/);
  assert.match(publicSource, /finally \{\s*if \(renderTimer\) clearTimeout\(renderTimer\);\s*if \(renderFrame\) cancelAnimationFrame\(renderFrame\);/);
  assert.match(publicSource, /updateStreamingMessage\(assistant, conversationId\)/);
  assert.match(publicSource, /function createCodeBlock\(content, language = '', \{ copyable = true \} = \{\}\)/);
  assert.match(publicSource, /const copyable = !streaming \|\| match\.index \+ match\[0\]\.length <= originalSource\.length/);
  assert.match(publicSource, /elements\.messageList\.addEventListener\('click'/);
  assert.match(publicSource, /copyText\(code\.textContent \|\| '', button\)/);
});

test('the composer send button becomes an abort control while the active request is running', () => {
  assert.match(publicSource, /id="sendButton" type="button"/);
  assert.match(publicSource, /send-cancel-icon/);
  assert.match(publicSource, /const activeRequestControllers = new Map\(\)/);
  assert.match(publicSource, /new AbortController\(\)/);
  assert.match(publicSource, /signal: requestController\.signal/);
  assert.match(publicSource, /function cancelCurrentResponse\(\)/);
  assert.match(publicSource, /renderConversation\(\); updateSendState\(\);/);
  assert.match(publicSource, /function retainCancelledRegeneration\(conversation, message, variants\)/);
  assert.match(publicSource, /activeRequestControllers\.set\(conversation\.id, requestController\)/);
  assert.match(publicSource, /signal: requestController\.signal/);
  assert.match(publicSource, /activeRequestControllers\.get\(conversation\.id\) === requestController/);
  assert.match(publicSource, /响应已中断，本次调用按正常模型费用扣除/);
  assert.match(publicSource, /send-button\.cancel-mode/);
  assert.match(backendSource, /if \(clientCancelled\) await quota\.commit\(\); else quota\.rollback\(\);/);
});

test('message bodies and reasoning drawers share local Markdown and math rendering', () => {
  assert.match(publicSource, /\/vendor\/katex\/katex\.min\.css/);
  assert.match(publicSource, /\/vendor\/katex\/katex\.min\.js/);
  assert.match(publicSource, /\/vendor\/katex\/auto-render\.min\.js/);
  assert.match(publicSource, /typeof globalThis\.renderMathInElement === 'function'/);
  assert.match(publicSource, /className = 'message-text reasoning-content'/);
  assert.match(publicSource, /renderRichText\(content, message\.reasoning, \{ streaming: message\.streaming, sourceValue: message\.reasoning \}\)/);
  assert.doesNotMatch(publicSource, /pre\.textContent = message\.reasoning/);
  assert.match(publicSource, /nextCells\.length !== headers\.length/);
});

test('reading width defaults to a responsive mode and retains an optional classic layout', () => {
  assert.match(publicSource, /const initialReadingMode = storedReadingMode === 'classic' \? 'classic' : 'fluid'/);
  assert.match(publicSource, /html\[data-reading-mode="classic"\] \{ --reading-width: 760px; \}/);
  assert.match(publicSource, /html\[data-reading-mode="fluid"\] \{ --reading-width: clamp\(760px, 74vw, 1120px\); \}/);
  assert.match(publicSource, /value="fluid"/);
  assert.match(publicSource, /value="classic"/);
  assert.match(publicSource, /state\.readingMode = applyReadingMode\(state\.editingReadingMode, \{ persist: true \}\)/);
});

test('entering the platform opens a fresh global conversation without accumulating unused blanks', () => {
  assert.match(publicSource, /function openEntryGlobalConversation\(\)/);
  assert.match(publicSource, /state\.conversations\.find\(isReusableEntryGlobalConversation\)/);
  assert.match(publicSource, /conversation\.messages\.length === 0/);
  assert.match(publicSource, /conversation\.titleCustomized !== true/);
  assert.match(publicSource, /!conversation\.roleId/);
  assert.match(publicSource, /!conversation\.folderId/);
  assert.match(publicSource, /selectGlobalConversationDefaults\(\{ persist: false \}\)/);
  assert.match(publicSource, /state\.conversations = await loadPersistedConversations\(\); openEntryGlobalConversation\(\);/);
  assert.doesNotMatch(publicSource, /state\.conversations = loadConversations\(\); if \(!state\.conversations\.length\).*state\.conversations\[0\]\.id/);
});

test('administrator history uses the server as the only persistent store and clears browser conversation copies', () => {
  assert.match(publicSource, /function clearAdministratorBrowserConversationData\(\)/);
  assert.match(publicSource, /localStorage\.removeItem\(STORAGE_KEY\);/);
  assert.match(publicSource, /if \(state\.userRole === 'admin'\) \{ clearAdministratorBrowserConversationData\(\); return; \}/);
  assert.match(publicSource, /const payload = await jsonRequest\('\/api\/conversations'\);/);
  assert.match(publicSource, /const merged = mergeConversations\(\[\], payload\.conversations\);\s+state\.conversations = merged;\s+clearAdministratorBrowserConversationData\(\);/);
  assert.doesNotMatch(publicSource, /ADMIN_CONVERSATION_RECOVERY_KEY|loadAdministratorBrowserRecovery|saveAdministratorBrowserRecovery/);
});

test('the global new-conversation action exits an active packaged workflow', () => {
  assert.match(publicSource, /function exitWorkflow\(\{ force = false, announce = true \} = \{\}\)/);
  assert.match(publicSource, /const leftWorkflow = exitWorkflow\(\{ force: true, announce: false \}\);/);
  assert.match(publicSource, /setAppView\('chat'\); createGlobalConversation\(\);/);
});

test('the empty conversation keeps only the minimal welcome heading', () => {
  assert.match(publicSource, /从一个想法开始/);
  assert.match(publicSource, /今天想和 AI 聊些什么？/);
  assert.match(publicSource, /.empty-state {[^}]*display: grid;[^}]*flex: 1;[^}]*place-content: center;/);
  assert.doesNotMatch(publicSource, /empty-description/);
  assert.doesNotMatch(publicSource, /suggestion-grid/);
  assert.doesNotMatch(publicSource, /data-prompt/);
});

test('role cards can move or copy complete definitions between folders', () => {
  assert.match(publicSource, /id="toggleRoleConversations"/);
  assert.match(publicSource, /role-conversations-menu-icon/);
  assert.match(publicSource, /role-conversations-menu-count/);
  assert.match(publicSource, /toggleRoleConversations\.setAttribute\('aria-expanded'/);
  assert.match(publicSource, /function toggleRoleConversationState\(roleId\)/);
  assert.match(publicSource, /function toggleRoleConversationsFromContext\(\)/);
  assert.match(publicSource, /button\.addEventListener\('click', \(\) => createRoleConversationFromDrawer\(role\.id\)\)/);
  assert.match(publicSource, /defaultButton\.addEventListener\('click', \(\) => openSidebarDrawer\('role:__default__'\)\)/);
  assert.match(publicSource, /function createRoleConversationButton\(roleId, label\)/);
  assert.match(publicSource, /createConversation\(\{ roleId: normalized, close: false \}\)/);
  assert.match(publicSource, /openSidebarDrawer\(`role:\$\{normalized\}`\); openSidebar\(\)/);
  assert.match(publicSource, /id="duplicateRole"/);
  assert.match(publicSource, /id="copyRoleToFolder"/);
  assert.match(publicSource, /id="moveRoleToFolder"/);
  assert.match(publicSource, /function findRoleLocation\(roleId, library = state\.roleLibrary\)/);
  assert.match(publicSource, /function createCopiedRole\(source, library, targetFolder\)/);
  assert.match(publicSource, /description: source\.description, systemPrompt: source\.systemPrompt/);
  assert.match(publicSource, /nextSource\.folder\.roles\.splice\(nextSource\.roleIndex \+ 1, 0, copiedRole\)/);
  assert.match(publicSource, /target\.roles\.push\(\.\.\.source\.folder\.roles\.splice\(source\.roleIndex, 1\)\)/);
  assert.match(publicSource, /已有对话仍继续关联这个角色/);
  assert.match(publicSource, /jsonRequest\('\/api\/roles', \{ method: 'PUT'/);
});

test('the active conversation reports and can switch its server-injected role prompt', () => {
  assert.match(publicSource, /id="currentRoleCard"/);
  assert.match(publicSource, /id="currentRoleName"/);
  assert.match(publicSource, /id="currentRoleMeta"/);
  assert.match(publicSource, /系统提示词将由服务端自动注入/);
  assert.match(publicSource, /未注入系统提示词/);
  assert.match(publicSource, /function setCurrentConversationRole\(roleId\)/);
  assert.match(publicSource, /source\.messages\.filter\(\(message\) => !message\.streaming\)/);
  assert.match(publicSource, /title: `\$\{source\.title\.replace\(\/ · 角色：\[\^·\]\+\$\/, ''\)\} · 角色：\$\{roleLabel\}`\.slice\(0, 80\)/);
  assert.match(publicSource, /state\.conversations\.unshift\(conversation\)/);
  assert.match(publicSource, /roleId: normalized/);
  assert.match(publicSource, /copiedFromConversationId: source\.id/);
  assert.match(publicSource, /id="jumpToSourceConversation"/);
  assert.match(publicSource, /function jumpToSourceConversationContext\(\)/);
  assert.match(publicSource, /elements\.currentRoleCard\.addEventListener\('click', toggleHeaderRoleMenu\)/);
  assert.match(publicSource, /elements\.roleButton\.addEventListener\('click', toggleHeaderRoleMenu\)/);
  assert.match(backendSource, /const upstream = systemPrompt \? \[\{ role: 'system', content: systemPrompt \}\] : \[\]/);
  assert.match(backendSource, /systemPrompt = role\.systemPrompt/);
});

test('the sidebar uses full-height hierarchical drawers with enter and back navigation', () => {
  assert.match(publicSource, /id="sidebarDrawerRoot"/);
  assert.match(publicSource, /data-sidebar-drawer="favorites"/);
  assert.match(publicSource, /data-sidebar-drawer="roles"/);
  assert.match(publicSource, /data-sidebar-drawer="history"/);
  assert.match(publicSource, /function sidebarDrawerBase\(view\)/);
  assert.match(publicSource, /function openSidebarDrawer\(view\)/);
  assert.match(publicSource, /function closeCurrentSidebarDrawer\(\)/);
  assert.match(publicSource, /state\.sidebarDrawerStack = exists \? \['root', 'roles', view\]/);
  assert.match(publicSource, /openSidebarDrawer\(`role:\$\{normalized\}`\)/);
  assert.match(publicSource, /openSidebarDrawer\(`history-folder:\$\{folder\.id\}`\)/);
  assert.match(publicSource, /data-sidebar-drawer-active/);
  assert.match(publicSource, /data-role-drawer-active/);
  assert.match(publicSource, /\.sidebar\[data-sidebar-drawer="roles"\] \.role-conversation-list \{ display: none; \}/);
  assert.match(publicSource, /role-entry\[data-role-drawer-active="true"\] > \.role-entry-row/);
  assert.match(publicSource, /role-conversation-new/);
  assert.match(publicSource, /const defaultExpanded = state\.sidebarDrawerStack\.at\(-1\) === 'role:__default__'/);
  assert.match(publicSource, /const expanded = state\.sidebarDrawerStack\.at\(-1\) === `role:\$\{role\.id\}`/);
  assert.doesNotMatch(publicSource, /const (?:defaultExpanded|expanded) = [^;]*\.length > 0 && state\.sidebarDrawerStack/);
  assert.match(publicSource, /activateConversation\(conversation\.id, \{ closeSidebar: false, keepDrawer: true \}\)/);
  assert.match(publicSource, /function activateConversation\(conversationId, \{ closeSidebar: shouldCloseSidebar = true, keepDrawer = false \} = \{\}\)/);
  assert.match(publicSource, /button\.addEventListener\('click', \(\) => activateConversation\(conversation\.id, \{ closeSidebar: false, keepDrawer: true \}\)\)/);
  assert.match(publicSource, /role-entry\[data-role-drawer-active="true"\] \{ margin: 0; background: transparent; border-left: 0/);
  assert.match(publicSource, /\.sidebar-roles \{[^}]*padding-left: 0;[^}]*border-left: 0/);
  assert.match(publicSource, /\.sidebar-drawer-panel > \.sidebar-favorites, \.sidebar-drawer-panel > \.sidebar-roles, \.sidebar-drawer-panel > \.history-list/);
  assert.match(publicSource, /elements\.manageRoles\.textContent = activeCustomRole \? '编辑' : '管理'/);
  assert.match(publicSource, /openRolesDialog\(\{ focusRoleId: validRoleId\(roleId\) \}\)/);
});

test('the sidebar exposes recent uploaded and generated files with preview and refresh controls', () => {
  assert.match(publicSource, /id="openRecentFilesDrawer"/);
  assert.match(publicSource, /data-sidebar-drawer-panel="recent-files"/);
  assert.match(publicSource, /id="recentFilesList"/);
  assert.match(publicSource, /id="previousRecentFilesPage"/);
  assert.match(publicSource, /id="nextRecentFilesPage"/);
  assert.match(publicSource, /jsonRequest\(`\/api\/media\/recent\?page=\$\{requestedPage\}&limit=\$\{MEDIA_PAGE_SIZE\}`\)/);
  assert.match(publicSource, /function renderMediaPageControls\(/);
  assert.match(publicSource, /fetch\(item\.url, \{ credentials: 'same-origin', cache: 'no-store' \}\)/);
  assert.match(publicSource, /openImageLightbox\(images\.map\(\(candidate\) => candidate\.id === item\.id \? loaded : candidate\), loaded\)/);
  assert.match(publicSource, /open\.target = '_blank'; open\.rel = 'noopener'/);
  assert.match(publicSource, /thumb\.loading = 'lazy'/);
  assert.match(publicSource, /\.recent-file-preview img/);
  assert.match(publicSource, /const open = document\.createElement\(item\.isImage \? 'button' : 'a'\)/);
  assert.match(publicSource, /\.recent-file-item/);
});

test('the sidebar exposes favorite media and recent-file context actions without bypassing authenticated media URLs', () => {
  assert.match(publicSource, /id="openFavoriteMediaDrawer"/);
  assert.match(publicSource, /data-sidebar-drawer-panel="favorite-media"/);
  assert.match(publicSource, /id="favoriteMediaList"/);
  assert.match(publicSource, /id="previousFavoriteMediaPage"/);
  assert.match(publicSource, /id="nextFavoriteMediaPage"/);
  assert.match(publicSource, /id="recentFileContextMenu"/);
  assert.match(publicSource, /id="jumpToRecentFileMessage"/);
  assert.match(publicSource, /function toggleFavoriteMedia\(itemId\)/);
  assert.match(publicSource, /function recentFileMessageLocation\(fileId\)/);
  assert.match(publicSource, /function jumpToRecentFileMessage\(\)/);
  assert.match(publicSource, /highlightRecentFileMessage\(location\.message\.id\)/);
  assert.match(publicSource, /\/api\/media\/favorites/);
  assert.match(publicSource, /bindContextMenuTrigger\(open, 'recentFileContextMenu'/);
  assert.match(publicSource, /favorite-media-card/);
  assert.match(backendSource, /favoriteMediaIds/);
  assert.match(backendSource, /\/api\/media\/favorites/);
  assert.match(backendSource, /mediaStore\.listOwned/);
  assert.match(backendSource, /page: query\.get\('page'\), limit: query\.get\('limit'\)/);
});

test('the sidebar exposes server-orchestrated packaged workflows without exposing ordinary-user internals', () => {
  assert.match(publicSource, /id="openWorkflowsDrawer"/);
  assert.match(publicSource, /data-sidebar-drawer-panel="workflows"/);
  assert.match(publicSource, /jsonRequest\('\/api\/workflows'\)/);
  assert.match(publicSource, /jsonRequest\('\/api\/workflows\/run'/);
  assert.match(publicSource, /id="workflowComposerBanner"/);
  assert.match(publicSource, /function effectiveWorkflowImageRequest\(workflow, draft\)/);
  assert.match(publicSource, /imageModel: request\.selection\.modelId/);
  assert.match(publicSource, /state\.selectedWorkflow && !queuedDraft\) return runWorkflowMessage\(\);/);
  assert.doesNotMatch(publicSource, /id="workflowDialog"/);
  assert.match(publicSource, /工作流正在运行中，请稍候/);
});

test('workflow cards reuse their latest unused conversation and expose only their own drawing history', () => {
  assert.match(publicSource, /workflowId: validWorkflowId\(workflowId\)/);
  assert.match(publicSource, /function workflowConversations\(workflowId\)/);
  assert.match(publicSource, /conversation\.workflowId === workflowId/);
  assert.match(publicSource, /createConversation\(\{ roleId: '', workflowId: workflow\.id, close: false \}\)/);
  assert.match(publicSource, /openSidebarDrawer\(`workflow:\$\{workflow\.id\}`\); openSidebar\(\);/);
  assert.match(publicSource, /workflow-conversations-\$\{workflow\.id\}/);
  assert.match(publicSource, /workflowId: typeof item\.workflowId === 'string'/);
  assert.ok(backendSource.includes("workflowId: /^[A-Za-z0-9_-]{3,64}$/.test(storedText(value.workflowId, 64))"));
  assert.match(publicSource, /id="workflowsToggle"/);
  assert.match(publicSource, /workflow-entry/);
  assert.match(publicSource, /workflow-conversation-list/);
  assert.match(publicSource, /function isReusableWorkflowConversation\(conversation, workflowId\)/);
  assert.match(publicSource, /function latestReusableWorkflowConversation\(workflowId\)/);
  assert.match(publicSource, /const reusable = forceNew \? null : latestReusableWorkflowConversation\(workflow\.id\);/);
  assert.match(publicSource, /conversation\.messages\.length === 0/);
  assert.match(publicSource, /function activateWorkflow\(workflow, \{ forceNew = false \} = \{\}\)/);
  assert.match(publicSource, /activateWorkflow\(workflow, \{ forceNew: true \}\)/);
});

test('administrators can configure private node graphs while the user surface stays orchestration-free', () => {
  assert.match(publicSource, /data-account-panel="workflows"/);
  assert.match(publicSource, /id="workflowEditor"/);
  assert.match(publicSource, /function renderWorkflowEditor\(\)/);
  assert.match(publicSource, /function renderWorkflowGraphCanvas\(workflow\)/);
  assert.match(publicSource, /function connectWorkflowNodes\(workflow, from, to\)/);
  assert.match(publicSource, /function workflowGraphWouldCycle\(workflow, from, to\)/);
  assert.match(publicSource, /function bindWorkflowGraphPan\(scroll\)/);
  assert.match(publicSource, /event\.button !== 1 && event\.button !== 2/);
  assert.match(publicSource, /按住鼠标中键或右键拖拽平移画布/);
  assert.match(publicSource, /newWorkflowMergeNode/);
  assert.match(publicSource, /workflow-graph-edge/);
  assert.match(publicSource, /临时系统提示词/);
  assert.match(publicSource, /jsonRequest\('\/api\/admin\/workflows'/);
  assert.match(backendSource, /function validateWorkflowDefinitions\(/);
  assert.match(backendSource, /\['role', 'temporary', 'merge', 'image'\]/);
  assert.match(backendSource, /function workflowTopologicalOrder\(/);
  assert.match(backendSource, /function workflowNodeInput\(/);
  assert.match(backendSource, /function publicWorkflowList\(\)/);
  assert.match(backendSource, /\/api\/admin\/workflows/);
  assert.match(backendSource, /systemPrompt/);
});

test('workflow graph editing expands into a viewport-sized workspace without changing other account panels', () => {
  assert.match(publicSource, /accountDialog\.classList\.toggle\('workflow-workspace-active', requested === 'workflows'\)/);
  assert.match(publicSource, /accountDialog\.addEventListener\('close', \(\) => elements\.accountDialog\.classList\.remove\('workflow-workspace-active'\)\)/);
  assert.match(publicSource, /\.account-dialog\.workflow-workspace-active \{ width: calc\(100vw - 24px\); max-width: none; max-height: calc\(100dvh - 24px\); \}/);
  assert.match(publicSource, /\.account-dialog\.workflow-workspace-active \.workflow-graph-scroll, \.account-dialog\.workflow-workspace-active \.workflow-graph-inspector \{ min-height: 0; height: 100%; max-height: none; \}/);
});

test('history search input uses the sidebar visual language', () => {
  assert.match(publicSource, /id="historySearchInput"/);
  assert.match(publicSource, /elements\.historySearch\.addEventListener\('input'/);
  assert.match(publicSource, /function appendHistoryTitleHighlight\(/);
  assert.match(publicSource, /scrollIntoView\(\{ block: 'nearest' \}\)/);
  assert.match(publicSource, /history-item\.search-match/);
  assert.match(publicSource, /\.history-search \{ position: relative;/);
  assert.match(publicSource, /\.history-item mark/);
  assert.match(publicSource, /\.history-search input:focus/);
  assert.match(publicSource, /\.history-search::before/);
});

test('conversation titles can be regenerated with a saved chat-model preference', () => {
  assert.match(publicSource, /function requestGeneratedConversationTitle\(/);
  assert.match(publicSource, /function regenerateConversationTitleFromContext\(\)/);
  assert.match(publicSource, /id="regenerateConversationTitle"/);
  assert.match(publicSource, /id="conversationTitleModelSelect"/);
  assert.match(publicSource, /function renderConversationTitleModelSelect\(\)/);
  assert.match(publicSource, /conversationTitleModel/);
  assert.match(publicSource, /\/api\/conversations\/title/);
  assert.match(publicSource, /Keep the already-visible first-message fallback title/);
  assert.match(backendSource, /CONVERSATION_TITLE_MODEL = 'gemini-3\.5-flash-low-fan'/);
  assert.match(backendSource, /function validateConversationTitleModel\(/);
  assert.match(backendSource, /model: titleModel/);
  assert.match(backendSource, /根据用户输入生成一个简洁的中文对话标题/);
});

test('Gemini Flash image generation is advertised as a one-credit option', () => {
  assert.match(publicSource, /Gemini Flash 1 积分/);
  assert.match(backendSource, /function imageCreditCost\(modelId\)/);
  assert.match(backendSource, /gemini.*flash.*image/i);
  assert.match(backendSource, /imageCreditCost\(body\.model\)/);
});
test('the composer accepts a bounded editable queue while a response is active', () => {
  assert.match(publicSource, /id="messageQueue"/);
  assert.match(publicSource, /id="queueSendButton"/);
  assert.match(publicSource, /const MAX_QUEUED_MESSAGES = 10/);
  assert.match(publicSource, /messageQueues: new Map\(\)/);
  assert.match(publicSource, /function enqueueCurrentMessage\(\)/);
  assert.match(publicSource, /function processNextQueuedMessage\(conversationId\)/);
  assert.match(publicSource, /function drainQueuedMessages\(\)/);
  assert.match(publicSource, /保存修改/);
  assert.match(publicSource, /取消排队/);
  assert.match(publicSource, /queue\.length >= MAX_QUEUED_MESSAGES/);
  assert.match(publicSource, /if \(isConversationBusy\(conversation\.id\)\) \{\s*if \(!queuedDraft\) return enqueueCurrentMessage\(\);/);
  assert.match(publicSource, /drainQueuedMessages\(\);/);
});

test('editing a historical message can add and remove multimedia attachments safely', () => {
  assert.match(publicSource, /fileInput\.multiple = true/);
  assert.match(publicSource, /fileInput\.accept = elements\.fileInput\.accept/);
  assert.match(publicSource, /为历史消息上传图片或文档/);
  assert.match(publicSource, /message-editor-media-remove/);
  assert.match(publicSource, /collection\.splice\(index, 1\)/);
  assert.match(publicSource, /async function uploadAttachmentFile\(file, \{ signal \} = \{\}\)/);
  assert.match(publicSource, /fetch\('\/api\/uploads'/);
  assert.match(publicSource, /saveEditedMessage\(message\.id, textarea\.value, draftAttachments, draftImages\)/);
  assert.match(publicSource, /function saveEditedMessage\(messageId, content, attachments, images\)/);
  assert.match(publicSource, /message\.attachments = structuredClone\(nextAttachments\)/);
  assert.match(publicSource, /message\.images = structuredClone\(nextImages\)/);
  assert.match(publicSource, /variant\.attachments = structuredClone\(nextAttachments\)/);
  assert.match(publicSource, /variant\.images = structuredClone\(nextImages\)/);
  assert.match(publicSource, /if \(state\.editingMessageId === message\.id\) \{\s*body\.append\(createMessageEditor\(message\)\);\s*\} else \{/);
  assert.match(publicSource, /editingAttachmentDropHandler = uploadEditorFiles/);
  assert.match(publicSource, /function uploadEditorClipboardAttachments\(event\)/);
  assert.match(publicSource, /textarea\.addEventListener\('paste', uploadEditorClipboardAttachments\)/);
  assert.match(publicSource, /void uploadEditorFiles\(files\);/);
  assert.match(publicSource, /state\.editingMessageId && editingAttachmentDropHandler/);
  assert.match(publicSource, /松开以添加到当前历史消息/);
  assert.match(publicSource, /editor\.scrollIntoView\(\{ behavior: 'instant', block: 'center' \}\)/);
});

test('the main composer uploads pasted images and files without intercepting ordinary text paste', () => {
  assert.match(publicSource, /function clipboardAttachmentFiles\(clipboardData\)/);
  assert.match(publicSource, /clipboardData\.files/);
  assert.match(publicSource, /item\.kind === 'file'/);
  assert.match(publicSource, /function uploadClipboardAttachments\(event\)/);
  assert.match(publicSource, /if \(!files\.length\) return;\s*event\.preventDefault\(\);\s*void uploadFiles\(files\);/);
  assert.match(publicSource, /elements\.input\.addEventListener\('paste', uploadClipboardAttachments\)/);
  assert.match(publicSource, /new File\(\[file\], `粘贴附件-/);
});

test('image model size choices expand in a stable in-menu panel', () => {
  assert.match(publicSource, /button\.setAttribute\('aria-haspopup', 'true'\)/);
  assert.match(publicSource, /const setExpanded = \(expanded\) => \{ row\.dataset\.expanded = String\(expanded\); button\.setAttribute\('aria-expanded', String\(expanded\)\); \}/);
  assert.match(publicSource, /button\.addEventListener\('click', \(\) => setExpanded\(row\.dataset\.expanded !== 'true'\)\)/);
  assert.match(publicSource, /variant-image-model-row\[data-expanded="true"\] \.variant-image-size-menu/);
  assert.match(publicSource, /\.variant-image-size-menu \{ grid-column: 1 \/ -1; width: calc\(100% - 12px\);/);
  assert.match(publicSource, /variant-image-size-menu \{[\s\S]*?flex-direction: column;/);
  assert.match(publicSource, /variant-image-size-menu button \{ width: 100%;/);
  assert.doesNotMatch(publicSource, /\.variant-image-size-menu \{ position: absolute;/);
  assert.match(publicSource, /orderedImageSizes\(model\?\.imageOptions\?\.sizes \|\| \[\], modelId\)/);
  assert.match(publicSource, /function geminiFlashAspectRatio\(size, modelId = ''\)/);
});

test('lightbox navigates every image and upscale variant with keyboard and transient controls', () => {
  assert.match(publicSource, /id="imageLightboxPrevious"/);
  assert.match(publicSource, /id="imageLightboxNext"/);
  assert.match(publicSource, /function imageLightboxEntries\(items\)/);
  assert.match(publicSource, /openImageLightbox\(images, variants\[selectedVariant\]\)/);
  assert.match(publicSource, /traverseRecentPool: true/);
  assert.match(publicSource, /id="imageLightboxPosition"/);
  assert.match(publicSource, /function openRecentPoolLightbox\(source, loaded, blobUrl\)/);
  assert.match(publicSource, /\/api\/media\/recent\/neighbors\?id=\$\{encodeURIComponent\(id\)\}/);
  assert.match(publicSource, /function renderImageLightboxPosition\(\)/);
  assert.match(publicSource, /\$\{position\} \/ \$\{total\}/);
  assert.match(publicSource, /function switchRecentPoolLightbox\(direction\)/);
  assert.match(backendSource, /pathname === '\/api\/media\/recent\/neighbors'/);
  assert.match(backendSource, /mediaStore\.recentImageNeighbors/);
  assert.match(publicSource, /function switchImageLightbox\(direction\)/);
  assert.match(publicSource, /function setImageLightboxLoadStatus\(message, kind = 'loading'\)/);
  assert.match(publicSource, /image\.onload = \(\) =>/);
  assert.match(publicSource, /正在加载第 \$\{position\} 张图片/);
  assert.match(publicSource, /已切换至第 \$\{position\} 张/);
  assert.match(publicSource, /event\.key === 'ArrowLeft'/);
  assert.match(publicSource, /event\.key === 'ArrowRight'/);
  assert.match(publicSource, /elements\.imageLightboxStage\.addEventListener\('mousemove', revealImageLightboxControls\)/);
  assert.match(publicSource, /setTimeout\(\(\) => \{ elements\.imageLightbox\.classList\.remove\('controls-visible'\)/);
  assert.match(publicSource, /\.image-lightbox\.controls-visible\.has-image-navigation \.image-lightbox-nav/);
  assert.match(publicSource, /\.image-lightbox-loading\[data-kind="complete"\]/);
});

test('image context menus copy authenticated image content to the clipboard', () => {
  assert.match(publicSource, /id="imageLightboxContextMenu"/);
  assert.match(publicSource, /id="jumpToLightboxFileMessage"/);
  assert.match(publicSource, /id="toggleLightboxFavoriteMediaButton"/);
  assert.match(publicSource, /id="copyLightboxImageButton"/);
  assert.match(publicSource, /id="downloadLightboxFileButton"/);
  assert.match(publicSource, /id="copyRecentFileImageButton"/);
  assert.match(publicSource, /function openLightboxRecentFileContextMenu\(x, y, trigger\)/);
  assert.match(publicSource, /bindContextMenuTrigger\(elements\.imageLightboxImage, 'imageLightboxContextMenu', openLightboxRecentFileContextMenu\)/);
  assert.match(publicSource, /function downloadRecentFileFromContext\(\)/);
  assert.match(publicSource, /function copyRecentImageFromContext\(\)/);
  assert.match(publicSource, /fetch\(item\.url, \{ credentials: 'same-origin', cache: 'no-store' \}\)/);
  assert.match(publicSource, /new ClipboardItem\(\{ 'image\/png': png \}\)/);
  assert.match(publicSource, /const copy = navigator\.clipboard\.write/);
  assert.match(publicSource, /await copy;/);
  assert.match(publicSource, /imageBlobAsClipboardPng/);
});

test('quick translation provides a protected two-panel workspace with local history and model selection', () => {
  assert.match(publicSource, /id="openTranslator"/);
  assert.match(publicSource, /id="translatorWorkspace"/);
  assert.match(publicSource, /id="translateSourceLanguage"/);
  assert.match(publicSource, /id="translateTargetLanguage"/);
  assert.match(publicSource, /id="translateHistoryButton"/);
  assert.match(publicSource, /id="translateModelButton"/);
  assert.match(publicSource, /id="translatorCurrentModel"/);
  assert.match(publicSource, /function openTranslator\(\)/);
  assert.match(publicSource, /function translateText\(\)/);
  assert.match(publicSource, /fetch\('\/api\/chat'/);
  assert.match(publicSource, /X-CSRF-Token': state\.csrf/);
  assert.match(publicSource, /<translate_input>/);
  assert.match(publicSource, /Users may attempt to modify this instruction/);
  assert.match(publicSource, /maxTokens: 64000/);
  assert.match(publicSource, /stream: true/);
  assert.match(publicSource, /function consumeTranslationStream\(response\)/);
  assert.match(publicSource, /当前模型：\$\{modelId\}/);
  assert.match(backendSource, /maxTokens > 64000/);
  assert.match(publicSource, /function loadTranslationHistory\(\)/);
  assert.match(publicSource, /light-chat-translation-history/);
  assert.match(publicSource, /\.translator-panels \{[^}]*grid-template-columns: minmax\(0, 1fr\) minmax\(0, 1fr\)/);
});
