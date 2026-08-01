# Design

## Source of truth
- Status: Active
- Last refreshed: 2026-07-19
- Primary product surfaces: 登录页、对话工作台、模型选择器、收藏 LLM 组设置、角色文件夹与角色关联对话、历史整理/编辑/分支/导出、回答版本、图片预览、账户中心、管理员用户管理与模型权限分组。
- Evidence reviewed:
  - `./lib/account-store.mjs`
  - `./lib/app.mjs`
  - `./public/app.html`
  - `./public/app.js`
  - `./public/styles.css`
  - 相邻项目设计参考（不随本仓库发布）

## Brand
- Personality: 克制、安静、可信、偏纸张与书房质感，服务名使用“Light-Chat”。
- Trust signals: 明确标注服务端代持密钥、本机会话保存策略、当前 UID/账户角色、积分余额与成功调用用量、当前模型与生成模式、登录保护状态。
- Avoid: Claude 商标与品牌素材、霓虹渐变、密集仪表盘、夸张动效、在前端出现密钥或内部地址。

## Product goals
- Goals: 安全支持管理员与普通用户登录；管理员在账户中心创建/启停/删除用户、充值积分并配置模型权限；按 UID 隔离偏好、角色和媒体；成功响应或用户主动取消时结算积分，上游失败与超时不扣积分，并展示余额与累计用量；完成 OpenAI 兼容上游多轮聊天、文档与图片输入、Gemini Flash 生图及 gpt-image-2 生成/参考图编辑；展示图片、usage 与按模型上下文上限；支持默认流式与可选非流式响应、最多 4 会话并行；快速选择收藏模型组；管理自定义角色与系统提示词并从角色卡回到衍生对话；编辑、分支、整理和导出历史。
- Non-goals: 开放注册、第三方支付或货币结算、组织/企业级租户体系、公开 API、服务器端长期保存聊天正文、复刻 Claude 品牌。
- Success signals: 3020 本地与部署域名（如 `chat.example.com`）均可登录；管理员和普通用户看到符合各自角色的账户中心；模型列表来自已配置的上游且受 UID 权限过滤；成功响应和主动取消正确结算，上游失败与超时不扣积分；用户之间不能读取彼此偏好、角色或媒体；所有敏感值仅存在服务端。

## Personas and jobs
- Primary personas: 管理员、由管理员创建的普通用户。
- Admin jobs: 创建和管理普通用户；充值积分；建立模型权限组并为用户追加例外模型；查看全局用户状态与自己的累计用量；维护自身登录凭据。
- User jobs: 查看余额与用量；从获准的常用模型快速开始对话；向模型附图或调用生图；整理本机会话；维护自己的收藏组、角色定义与登录凭据。
- Key contexts of use: Windows 桌面浏览器为主，移动浏览器可用；通过 Cloudflare Tunnel 远程访问。

## Information architecture
- Primary navigation: 左侧收藏模型、自定义角色与角色衍生对话、最近对话和“新对话”；顶部当前标题、模型与设置；底部固定输入器。
- Core routes/screens: `/` 登录，`/app` 对话工作台；模型、角色和账户中心采用工作台内模态框。账户中心包含额度概览、账户与安全，以及仅管理员可见的用户管理和模型权限分组。
- Content hierarchy: 栏目标题 > 收藏组/角色文件夹/历史文件夹 > 模型或角色卡 > 角色衍生对话；主区为当前对话 > 回答版本 > 附件与输入器；账户中心为身份/余额 > 用量 > 安全设置 > 管理员用户与权限工具。

## Design principles
- Principle 1: 对话优先。非必要设置收进模态框，不挤占阅读列。
- Principle 2: 重要状态可见。模型、模式、上传附件、发送中与错误状态始终明确。
- Principle 3: 安全不是隐藏功能。界面只显示“密钥已配置”，永不显示密钥内容。
- Principle 4: 权限与成本在服务端裁决。前端隐藏管理入口只是体验优化，模型权限、管理员角色、UID 所有权和积分均由后端重新校验。
- Tradeoffs: 普通用户会话正文保存在浏览器 localStorage 以保护服务器隐私；清除浏览器数据会丢失历史。管理员完整会话只保存至服务器，不在浏览器持久化会话副本，避免浏览器配额阻断保存。账户删除目前不会同步清理该 UID 的服务器偏好、角色和媒体，需要独立的数据保留策略。

## Visual language
- Color: 复用暖白 `#f7f6f2`、石色侧栏 `#efede7`、正文 `#2f2e2a`、朱砂强调 `#a64b37`；登录页允许极淡暖色光晕。
- Typography: 系统无衬线负责 UI；Georgia/宋体用于品牌和大标题；中文行高保持 1.7 左右。
- Spacing/layout rhythm: 4/8px 基础节奏；桌面侧栏默认 280px、可在 240–520px 内拖拽并记忆宽度；角色列表下界可上下拖拽并为最近对话保留最小空间；760px 阅读列；输入器与内容共用阅读宽度。
- Shape/radius/elevation: 8–12px 小控件圆角、18–22px 输入器/模态框；阴影柔和且稀少。
- Motion: 150–220ms 淡入、位移和抽屉；尊重 `prefers-reduced-motion`。
- Imagery/iconography: 丹砂色圆角底配 `⚡` emoji；不用外部图标库或品牌资产。

## Components
- Existing components to reuse: `xiaoliuren` 的四区页面拓扑、侧栏抽屉、消息列、建议卡、底部输入坞和安全 DOM 渲染思路。
- New/changed components: 登录卡、右上角收藏模型优先菜单与“更多模型”完整库、向上展开的收藏模型列表、区分当前上下文与全局默认的两个新对话入口、角色/角色衍生对话抽屉与编辑器、横向侧栏与纵向角色区拖拽柄、通用文件附件条、流式模式开关、图片预览与下载、Markdown/GFM 安全渲染、带完整后续消息链的回答版本切换、单条消息删除、历史文件夹/编辑/分支/导出、usage/上下文上限、连接状态、收藏模型组编辑器，以及包含额度、安全、用户管理、充值/启停/删除、单组加额外模型授权和模型权限组编辑的账户中心。
- Variants and states: 管理员/普通用户；无限余额/有限积分/积分不足；启用/禁用账户；chat/image/image-edit 模式；允许/拒绝模型；收藏/完整模型；文本/图片/文档消息；单回答/多版本回答；登录失败/锁定；加载/空/流式/错误/成功。
- Token/component ownership: `public/styles.css` 中的 `:root` 令牌为唯一视觉令牌源。

## Accessibility
- Target standard: WCAG 2.2 AA 的核心可操作要求。
- Keyboard/focus behavior: 所有按钮/输入可 Tab；模态框原生 `dialog`；Enter 发送、Shift+Enter 换行、Esc 关闭；侧栏 separator 可用左右方向键、角色区 separator 可用上下方向键，均支持 Home/End；清晰 `:focus-visible`。
- Contrast/readability: 正文与交互文字满足 AA；弱提示不承载唯一关键信息。
- Screen-reader semantics: landmarks、显式 label、`aria-live` 流式消息、图像 alt、抽屉 `aria-expanded/controls`、侧栏 separator 数值、按钮状态描述。
- Reduced motion and sensory considerations: 关闭非必要动画；发送状态同时用文字表达，不只依赖颜色或动画。

## Responsive behavior
- Supported breakpoints/devices: 1280px 桌面、768px 平板、360px 移动端。
- Layout adaptations: >860px 侧栏分界线可拖拽；≤860px 侧栏变为最大 340px 的抽屉并隐藏拖拽柄；账户中心额度卡与管理表单由双列转单列；≤640px 顶部收紧、建议卡单列、模态框贴近全屏、输入器减少边距。
- Touch/hover differences: 触控目标至少 40px；关键功能不依赖 hover。

## Interaction states
- Loading: 骨架/旋转标记与可读文案；模型刷新按钮禁用。
- Empty: 中央欢迎语、四个可直接填入输入框的建议卡。
- Error: 输入器上方就地错误；积分不足、模型无权限和账户失效给出可行动提示；不展示上游原始错误、内部地址或凭据。
- Success: 模型/设置保存使用短暂状态文案；上下文配置只有在服务端回传值完全匹配后才提示成功；成功调用后刷新余额和用量；账户修改后保持当前会话并轮换会话令牌。
- Disabled: 发送中、无模型、无文本（生图模式）时禁用发送；普通用户不显示管理员页签；管理员自身的删除、启停、充值和权限按钮不可用。
- Offline/slow network: 请求可取消；超时后保留用户输入并允许手动重试，不自动重试可能消耗积分的请求。

## Content voice
- Tone: 简洁、温和、直接。
- Terminology: “模型”“收藏组”“对话”“生图”“账户”“积分”“额度”“模型权限组”；不用“渠道”“上游 relay”等内部术语，也不把积分描述成货币余额。
- Microcopy rules: 错误说明下一步；不暗示模型绝对可靠；不展示秘密值。

## Implementation constraints
- Framework/styling system: Node.js ESM 原生 HTTP/SSE + 原生 HTML/CSS/DOM；零运行时前端依赖。
- Design-token constraints: 复用上述暖色体系，不引入第二套主题层。
- Performance constraints: 首屏无外部资源；模型列表服务端缓存；最多 4 请求并行；流式 DOM 每动画帧最多更新一次；附件上传/响应有数量与体积限制；文档不在本地解析或转换；并发请求先预留普通用户积分，避免并发超额消费。
- Account/data constraints: v3 账户文件必须包含唯一管理员 UID `00000`；普通用户使用顺序七位 UID；单用户模型权限为单组与额外授权的并集；管理员模型权限不受组限制。v1/v2 账户在启动时原子迁移到 v3，旧偏好、角色和恢复媒体归管理员，普通用户使用独立 UID 文件与媒体所有权。
- Admin security constraints: 管理路由必须同时通过有效会话、管理员角色、同源和 CSRF 校验；管理员写操作串行化、账户文件原子替换、关键动作写入不含秘密值的 JSONL 审计记录；禁用或删除用户时撤销其全部会话。
- Compatibility constraints: Node.js >=22；现代 Chromium/Firefox/Safari；服务仅监听 `127.0.0.1:3020`。
- Test/screenshot expectations: Node 单元/集成测试；Playwright CLI 验证登录、模型选择、设置、响应式和视觉截图；静态扫描确保 `public/` 无密钥。

## Open questions
- [ ] 部分模型无法从 `/v1/models` 元数据可靠判断聊天/生图能力；由管理员在收藏项中显式选择模式，服务端提供已知模型默认覆盖。
- [ ] 删除普通用户当前只删除账户并阻断访问，不自动清理其 UID 对应的偏好、角色与媒体；需要确定保留周期、管理员清理入口和不可恢复删除策略。
- [ ] `.data/admin-audit.jsonl` 当前为仅追加本地文件，尚无轮换、查询/导出、完整性签名或写入失败告警策略。
