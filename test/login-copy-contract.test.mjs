import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const loginHtml = await readFile(new URL('../public/login.html', import.meta.url), 'utf8');

test('login page presents the current fast multi-model conversation workflow', () => {
  assert.match(loginHtml, /便捷、快速、美观/);
  for (const feature of ['历史消息编辑', '快速分支', '模型切换', '多版本重新生成']) assert.match(loginHtml, new RegExp(feature));
});
