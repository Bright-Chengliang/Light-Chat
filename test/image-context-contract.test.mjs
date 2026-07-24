import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const appSource = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const serverSource = await readFile(new URL('../server.mjs', import.meta.url), 'utf8');
const backendSource = await readFile(new URL('../lib/app.mjs', import.meta.url), 'utf8');
const clientSource = await readFile(new URL('../lib/newapi-client.mjs', import.meta.url), 'utf8');

test('dedicated Images API conversations retain textual history in their generated or edited prompt', () => {
  assert.match(appSource, /function imageConversationPrompt\(messages\)/);
  assert.match(appSource, /const prospectiveImagePrompt = requestSelection\.mode === 'image'/);
  assert.match(appSource, /'\/api\/images\/generations'[\s\S]*prompt: prospectiveImagePrompt/);
  assert.match(appSource, /'\/api\/images\/generations'[\s\S]*prompt: imagePrompt/);
});

test('Gemini Flash image input keeps first-turn text and multiple attachments on the chat route', () => {
  assert.match(appSource, /const useImageChat = requestSelection\.mode === 'image' && requestModel\?\.modes\.includes\('chat'\) && \(conversation\.messages\.length > 0 \|\| attachments\.length > 0\)/);
  assert.match(appSource, /const messages = chatSubmissionMessages\(submitted\)/);
  assert.match(appSource, /attachmentIds: message\.role === 'user' \? \(message\.attachments \|\| \[\]\)\.map\(\(item\) => item\.id\) : \[\]/);
});

test('Light-Chat routes every Gemini Flash request through the configured 3002 NewAPI gateway', () => {
  const runtimeSource = `${serverSource}\n${backendSource}\n${clientSource}`;
  assert.doesNotMatch(runtimeSource, /3006|ICON_3006|geminiFlashChatApiKey|geminiFlashChatBaseUrl/);
  assert.match(serverSource, /NEWAPI_BASE_URL = 'http:\/\/127\.0\.0\.1:3002\/v1'/);
  assert.match(clientSource, /this\.fetch\(`\$\{this\.baseUrl\}\/chat\/completions`/);
});

test('gpt-image-2 uses the configured 3002 NewAPI gateway without any direct proxy route', () => {
  const runtimeSource = `${serverSource}\n${backendSource}\n${clientSource}`;
  assert.match(serverSource, /NEWAPI_BASE_URL = 'http:\/\/127\.0\.0\.1:3002\/v1'/);
  assert.match(clientSource, /this\.fetch\(`\$\{this\.baseUrl\}\/responses`/);
  assert.match(clientSource, /model: 'gpt-5\.4-mini'/);
  assert.doesNotMatch(runtimeSource, /8393|cockpit-cliproxy|cli-proxy/i);
});

test('gpt-image-2 edits receive prior generated images and prior user reference uploads', () => {
  assert.match(appSource, /function historicalReferenceImageIds\(messages\)/);
  assert.match(appSource, /message\?\.role === 'user' \? \(message\.attachments \|\| \[\]\)\.filter\(\(item\) => item\.isImage\)/);
  assert.match(appSource, /'\/api\/images\/edits'[\s\S]*prompt: prospectiveImagePrompt[\s\S]*imageIds: editImageIds/);
  assert.match(appSource, /'\/api\/images\/edits'[\s\S]*prompt: imagePrompt[\s\S]*imageIds: editImageIds/);
});

test('a first image turn keeps every pending image and the text prompt on the edit route', () => {
  assert.match(appSource, /const pendingImageIds = attachments\.filter\(\(item\) => item\.isImage\)\.map\(\(item\) => item\.id\)/);
  assert.match(appSource, /const editImageIds = \[\.\.\.new Set\(\[\.\.\.pendingImageIds, \.\.\.historicalImageIds\]\)\]\.slice\(0, maxReferenceImages\)/);
  assert.match(appSource, /const prospectiveImagePrompt = requestSelection\.mode === 'image'[\s\S]*content, attachments \}/);
  assert.match(appSource, /useImageEdit[\s\S]*'\/api\/images\/edits'[\s\S]*prompt: prospectiveImagePrompt[\s\S]*imageIds: editImageIds/);
});
