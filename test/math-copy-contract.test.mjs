import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [appSource, styles] = await Promise.all([
  readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
  readFile(new URL('../public/styles.css', import.meta.url), 'utf8'),
]);

test('display math exposes a one-click LaTeX copy action', () => {
  assert.match(appSource, /function decorateCopyableMath\(container\)/);
  assert.match(appSource, /annotation\[encoding="application\/x-tex"\]/);
  assert.match(appSource, /copy\.title = '复制 LaTeX 公式'/);
  assert.match(appSource, /void copyText\(latex, copy\)/);
  assert.match(appSource, /decorateCopyableMath\(container\);/);
  assert.match(styles, /\.math-copy-shell/);
  assert.match(styles, /\.math-copy-button/);
});
