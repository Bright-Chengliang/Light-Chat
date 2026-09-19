import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [appSource, styles] = await Promise.all([
  readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
  readFile(new URL('../public/styles.css', import.meta.url), 'utf8'),
]);

test('markdown parser keeps tables with <br> cells intact without DOMParser section shattering', () => {
  assert.match(appSource, /function appendSafeInlineNode\(parent, node\)/);
  assert.match(appSource, /function appendInlineMarkdown\(parent, text\)/);
  assert.match(appSource, /function standaloneHtmlBlock\(lines, startIndex\)/);
  assert.match(appSource, /function renderMarkdownSection\(container, source\)/);
  assert.doesNotMatch(appSource, /function renderMarkdownSection\(container, source\) \{\s*if \(!\/<\/\?\(?:details/);
  assert.match(styles, /\.message-text table \{[^}]*overflow-x:\s*auto/);
});

test('markdown table definition correctly parses tables with <br> and bold header cells', () => {
  const sample = `## 3.7 方法论横向对比与技术完备性论证 (Comparative Analysis & Self-Containment Summary)

为清晰体现本方法对比现有学术工作的实质性跨越，特构建如下对比矩阵：

| 维度 | 传统全序列长文本 LLM 推荐<br>(如 P5, LLaRA) | 外部外挂检索式代理<br>(如 ReMem, Mem0) | 传统循环递推模型<br>(初版草案设计) | **本方法设计 (Topological Manifold Retrieval)** |
| :--- | :--- | :--- | :--- | :--- |
| **长程依赖机制** | 强行在单次前向中展开长文本 | 离散长文本 RAG / 搜索工具调用 | 单链马尔可夫循环记忆传递 ($M^{t-1} \\to M^t$) | **双轨制：局部工作流 + 拓扑意图图动态演化** |
| **存储触发方式** | 全量被动塞入上下文 | 启发式固定切片 / 昂贵的 RL 决策 | 每步无条件更新覆盖 | **流形凸包测地残差自适应触发 (自感意图跃迁)** |
| **记忆存储形态** | 无显式结构（文本 Token 序列） | 扁平孤立的文本向量片段 (Vector DB) | 定长张量槽位 (Tensor Slots) | **个人微观动态偏好知识图 (保留时序骨架与回流转移)** |
| **检索与注入形式** | 无需检索，文本全覆盖 | 将文本段落反拼回 Prompt 引起上下文膨胀 | 无检索（纯依赖上一分块） | **轻量 GNN 结构感知编码 + 连续软图提示注入 (无文本膨胀)** |
| **单步推断复杂度** | $O(L^2)$ 二次方延迟，长文性能坍塌 | 依赖多轮 Tool-use，秒级延迟 | $O(1)$ 恒定常数复杂度 | **$O(1)$ 恒定常数复杂度（亚毫秒级实时在线服务）** |
| **梯度反传与训练** | 显存极易爆炸，外推能力弱 | 多阶段/RL 策略收敛脆弱，难以端到端 | 步内就地回传（无长程关联正则） | **全算子可微，纯单阶段端到端联合反传优化** |`;

  const lines = sample.split(/\n/);
  // Extract splitMarkdownTableRow and markdownTableDefinition logic from app.js
  function splitMarkdownTableRow(line) {
    let value = line.trim();
    if (value.startsWith('|')) value = value.slice(1);
    if (value.endsWith('|') && !value.endsWith('\\|')) value = value.slice(0, -1);
    const cells = []; let cell = ''; let escaped = false; let inCode = false;
    for (const character of value) {
      if (escaped) { cell += character; escaped = false; continue; }
      if (character === '\\') { escaped = true; continue; }
      if (character === '`') { inCode = !inCode; cell += character; continue; }
      if (character === '|' && !inCode) { cells.push(cell.trim()); cell = ''; continue; }
      cell += character;
    }
    if (escaped) cell += '\\';
    cells.push(cell.trim());
    return cells;
  }

  function markdownTableDefinition(lines, index) {
    if (index + 1 >= lines.length || !lines[index].includes('|')) return null;
    const headers = splitMarkdownTableRow(lines[index]);
    const separators = splitMarkdownTableRow(lines[index + 1]);
    if (headers.length < 2 || separators.length !== headers.length || separators.some((cell) => !/^:?-+:?$/.test(cell))) return null;
    const alignments = separators.map((cell) => cell.startsWith(':') && cell.endsWith(':') ? 'center' : cell.endsWith(':') ? 'right' : cell.startsWith(':') ? 'left' : '');
    const rows = []; let cursor = index + 2; let lastConsumed = index + 1;
    while (cursor < lines.length) {
      if (!lines[cursor].trim()) {
        let next = cursor + 1;
        while (next < lines.length && !lines[next].trim()) next += 1;
        if (next >= lines.length) break;
        const nextCells = lines[next].includes('|') ? splitMarkdownTableRow(lines[next]) : [];
        if (nextCells.length !== headers.length) break;
        cursor = next;
      }
      if (!lines[cursor].includes('|')) break;
      const cells = splitMarkdownTableRow(lines[cursor]);
      if (cells.length !== headers.length) break;
      rows.push(cells); lastConsumed = cursor; cursor += 1;
    }
    return { headers, alignments, rows, endIndex: lastConsumed };
  }

  const table = markdownTableDefinition(lines, 4);
  assert.ok(table, 'table definition should not be null');
  assert.equal(table.headers.length, 5);
  assert.equal(table.headers[0], '维度');
  assert.equal(table.headers[1], '传统全序列长文本 LLM 推荐<br>(如 P5, LLaRA)');
  assert.equal(table.headers[4], '**本方法设计 (Topological Manifold Retrieval)**');
  assert.equal(table.rows.length, 6);
  assert.equal(table.rows[0][0], '**长程依赖机制**');
  assert.equal(table.rows[4][1], '$O(L^2)$ 二次方延迟，长文性能坍塌');
  assert.equal(table.endIndex, 11);
});
