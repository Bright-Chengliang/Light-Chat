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

test('multiline display math is kept in one text node before KaTeX auto-rendering', () => {
  assert.match(appSource, /function standaloneDisplayMath\(lines, startIndex\)/);
  assert.match(appSource, /const opening = .*\.exec\(lines\[startIndex\]\);/);
  assert.match(appSource, /const closing = opening\[1\] === '\$\$'/);
  assert.match(appSource, /lines\.slice\(startIndex, endIndex \+ 1\)\.join\('\\n'\)/);
  assert.match(appSource, /math\.className = 'math-display-source'; math\.textContent = displayMath\.source;/);
  assert.match(appSource, /\{ left: '\\\\\[', right: '\\\\]', display: true \}/);
});
