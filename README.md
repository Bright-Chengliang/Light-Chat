# Light-Chat

一个仅监听本机回环地址的多用户聊天服务。管理员通过账户中心创建和管理普通用户、积分与模型权限；浏览器只访问同源 API，NewAPI 固定由服务端访问 `127.0.0.1:3002`，API 密钥不会进入静态网页、浏览器存储或接口响应。

## 运行环境

- Windows 10/11
- Node.js 22 或更高版本
- NewAPI 已在 `127.0.0.1:3002` 运行
- 应用端口必须位于 `3020–4000`，默认 `3020`

## 首次配置

在 PowerShell 中进入项目目录，然后运行：

```powershell
.\scripts\configure-secrets.ps1
```

脚本会交互式读取引导管理员的用户名、初始密码和 NewAPI 专用密钥。密钥与初始密码经当前 Windows 用户的 DPAPI 加密后写入 `.secrets/`；目录 ACL 仅允许当前用户访问。首次启动后管理员固定使用 UID `00000`，其他账户只能由管理员在账户中心创建。源码不包含真实凭据。

自动化部署也可在当前 PowerShell 进程中临时设置 `CHAT_SETUP_USERNAME`、`CHAT_SETUP_INITIAL_PASSWORD` 和 `CHAT_SETUP_NEWAPI_API_KEY` 后运行同一脚本。脚本读取后会立即删除这些环境变量。

## 启动

```powershell
.\scripts\start-server.ps1
```

默认地址为 `http://127.0.0.1:3020`。如需选择其他允许端口：

```powershell
.\scripts\start-server.ps1 -Port 3021
```

不要直接执行 `npm start`，除非已经由受信任的进程把必要的服务端环境变量注入当前进程。

## 账户、积分与模型权限

- 管理员固定为 UID `00000`、角色 `admin`，不能被删除、禁用、充值或套用普通用户模型权限；管理员可使用全部 NewAPI 模型，积分显示为 `∞`。
- 普通用户由管理员创建，使用不重复的顺序七位 UID，角色为 `user`。项目不提供开放注册，也不接入货币支付或第三方充值系统。
- 一次普通对话扣除 `1` 积分，一次生图或图片编辑扣除 `5` 积分。请求开始前会先预留额度；成功响应或用户主动取消/断开会正式结算，上游失败、服务端超时或并发槽位申请失败会回滚预留，不扣积分。
- 管理员不扣余额，但成功响应和用户主动取消的调用仍累计 `usagePoints`、`chatCalls` 和 `imageCalls`，便于查看真实用量；上游失败与超时不会计入调用。
- 每个普通用户最多关联一个模型权限组，并可额外授权若干模型；最终权限为“该组模型 ∪ 额外模型”。未分组且没有额外授权的用户不能使用任何模型。`GET /api/models` 只返回当前用户获准且 NewAPI 当前可用的模型，聊天和生图端点还会再次执行服务端权限校验。
- 收藏组、当前模型、上下文上限和角色定义按 UID 保存；上传与生成媒体同样按 UID 校验所有权。普通用户的聊天正文、历史文件夹、分支和回答版本保存在当前浏览器的 localStorage 中；管理员完整会话只以服务器 `.data/conversations-00000.json` 为准，不在浏览器持久化完整或缩略会话副本。
- 删除普通用户会立即失效其会话并阻止再次访问，但当前实现不会同步清理该 UID 已有的偏好、角色和媒体文件；UID 不会复用，后续应按数据保留策略单独清理。

## 后端接口

- `GET /api/session`：建立预认证会话或读取当前登录状态，并返回 CSRF token、UID、角色、积分余额与累计用量。
- `POST /api/auth/login`、`POST /api/auth/logout`：登录与退出。
- `PUT /api/account`：当前用户提交用户名、原密码及新的用户名/密码；原凭据正确后直接修改，不使用二次验证。修改后该 UID 的旧会话全部失效，并为当前页面轮换新会话。
- `GET /api/status`、`GET /api/quota`：读取当前账户状态、余额、累计积分、对话/生图成功调用次数与固定积分规则。
- `GET /api/admin/users`、`POST /api/admin/users`：管理员列出或创建用户；创建时可设置初始积分，并返回账户数据 revision。
- `DELETE /api/admin/users/:uid`：删除普通用户并使其会话失效。
- `PUT /api/admin/users/:uid/status`：启用或禁用普通用户，并使其现有会话失效。
- `POST /api/admin/users/:uid/recharge`：为普通用户增加整数积分。
- `PUT /api/admin/users/:uid/model-access`：设置普通用户的单一模型权限组和额外模型列表。
- `GET|PUT /api/admin/model-groups`：读取或整体保存模型权限组；组内模型必须存在于当前 NewAPI 模型清单。
- `GET /api/models`：从 NewAPI 动态加载模型，并按当前 UID 的模型权限过滤；管理员返回全部可用模型。
- `GET|PUT /api/preferences`：按 UID 读取或保存收藏模型组、聊天/生图模式，以及按模型 ID 持久化的最大上下文 token（默认 `262144`）。
- `GET|PUT /api/roles`：按 UID 读取或保存角色文件夹、角色顺序和系统提示词；写入需要同源与 CSRF 校验。
- `POST /api/uploads`：以文件自身 MIME 作为 `Content-Type` 上传原始二进制，并用 `X-File-Name` 传递 URL 编码文件名；支持 PNG/JPEG/WebP、TXT/MD、PDF、DOC/DOCX、PPT/PPTX。
- `POST /api/chat`：多轮对话；消息可引用上传返回的 attachment ID，也可提交已保存的 `roleId`，由服务端注入对应系统提示词。`stream` 默认为 `true`（SSE），传 `false` 时返回单次 JSON；流式请求会请求并解析 NewAPI usage。
- `POST /api/images/generations`：调用兼容的生图端点；支持 `gpt-image-2` 与同时具备聊天/生图能力的 `gemini-3.1-flash-image`，历史参考图会随多轮上下文继续提交；两者均提供 `1152x1536`、`1024x1536`、`1024x1792` 竖图选择，并将尺寸参数原样转发给 3002。
- `POST /api/images/edits`：以 multipart 转发 `gpt-image-2` 参考图编辑，支持单图、多图 `image[]` 与可选 PNG mask；参考图可以来自当前上传或本用户历史生成结果。
- `GET /api/media/:id`：登录态下读取当前 UID 拥有的持久化媒体；接口只暴露不透明媒体 ID。

除只读 GET 外，状态修改接口必须携带同源 `Origin`、JSON 或指定图片类型以及 `X-CSRF-Token`。所有管理员接口还会验证当前账户仍有效且角色为 `admin`；管理员写操作串行化执行，并在响应中返回最新 revision。

## v3 数据迁移

- 启动时如发现 `.data/account.json` 为 v1 或 v2，服务会保留旧用户名和密码哈希，将其迁移为 v3 管理员 UID `00000`，初始化无限余额语义、零用量计数、空模型权限组和普通用户 UID 序号，并以原子写入方式保存新结构。
- 旧的 `.data/preferences.json` 与 `.data/roles.json` 继续归管理员 UID `00000` 使用；普通用户分别使用 `.data/preferences-<UID>.json` 与 `.data/roles-<UID>.json`。
- 历史媒体索引恢复时，缺少新账户归属信息的旧输出媒体归管理员 UID `00000`。迁移不会把密码、API 密钥或媒体内容写入前端。
- v3 账户文件格式错误、管理员缺失、UID/角色关系非法或积分字段无效时，服务拒绝启动，不会静默重置账户数据。

## 安全边界

- 仅监听 `127.0.0.1`；外网入口应通过 Cloudflare Tunnel 反向代理。
- 账户密码使用 Node `scrypt` + 独立随机盐保存，永不保存明文。
- 会话为服务端不透明随机令牌；HTTPS 隧道使用 `__Host-`、`Secure`、`HttpOnly`、`SameSite=Strict` Cookie。
- 登录失败限速会持久化到 `.data/`，用户名是否存在使用统一错误形状。
- 管理员 UID 固定为 `00000`；普通账户使用不重复的顺序七位 UID。偏好、角色和媒体均按 UID 隔离，媒体索引跨服务重启持久化。
- 管理员不能通过用户管理接口被删除、禁用、充值或限制模型权限；禁用和删除普通用户会立即撤销其现有会话。
- 管理员创建/删除/启停用户、充值、修改模型权限和保存权限组会写入 `.data/admin-audit.jsonl`。审计记录只包含时间、动作、操作者 UID、目标 UID 与经过筛选的基础字段，不记录密码、密钥或请求正文；文件以 mode `0600` 创建。
- 管理员写操作通过进程内队列串行化，账户文件使用临时文件加 rename 原子替换；模型组和额外授权只接受当前 NewAPI 已知模型。
- 客户端不能提供 NewAPI 地址；模型必须命中最近加载的服务端 allowlist。
- 聊天请求不能直接提交任意 `system` 消息；只能引用服务器已校验保存的角色 ID。
- 图片验证文件签名、尺寸与体积；文档只做类型/签名/体积验证，不在本地解析或转换，而是原样封装后交给上游；拒绝 SVG/HTML 与未知类型。模型图片只接受受限 raster base64，绝不抓取或展示任意上游 URL。
- 对话和生图最多允许 4 个会话并行，具备超时和浏览器断开取消；上游错误体、Authorization、密码及图片 base64 不写日志。

## 验证

```powershell
npm test
npm run check
```

界面还支持：

- 账户中心包含额度概览、账户与安全、用户管理和模型权限分组。普通用户只能查看自己的额度并修改自己的凭据；管理员额外管理用户、充值、启停、删除和模型授权。
- 本机历史消息编辑、单条删除、从任意用户/助手节点建立新分支；历史文件夹拖拽整理、右键删除，以及 TXT、纯文本 Markdown、带媒体 Markdown ZIP 三种导出。
- 用户或助手节点重新生成与 `@` 收藏模型生成；较早用户节点会保存完整后续消息链，每个回答最多保留 8 个分支版本，切换时同步恢复模型名、图片、思考过程、usage 和全部后续对话。
- 自定义角色文件夹、角色排序与右键管理；角色卡可展开浏览其衍生对话并直接跳转，展开状态保存在浏览器中。
- 安全白名单 HTML 与 GFM 表格渲染、代码块/用户消息/助手消息一键复制；流式阶段按动画帧刷新，完成后一次性渲染 Markdown。
- 全页面拖拽上传附件；生成图片支持点击放大与悬浮下载。
- usage 存在时显示 `上下文 已用/上限`；上限按模型单独保存，生图提示词按中英文近似 token 估算并沿用同一模型上限，不再使用固定字符上限。
- 右上角模型按钮优先按收藏组展开，底部“更多模型”再进入完整模型库；输入栏“＋ 新对话”保留当前模型、模式和角色，左上角全局“新对话”则切回默认助手并选择收藏中的首个可用模型。
- 流式输出默认贴底；用户主动上翻后暂停吸附，回到底部 80px 内自动恢复。
- 桌面侧栏分界线可左右拖拽，角色区下界可上下拖拽；两者均支持键盘、双击复位和持久化，移动端保持抽屉式自适应侧栏。

历史正文、文件夹、角色关联、分支与回答版本只保存在当前浏览器的本地存储中；服务端账户、积分、权限、收藏、角色定义和媒体则按 UID 保存。

## Android 客户端

Android 客户端位于 [`android/`](android/)，是受限同源 HTTPS WebView。它不保存密码或 NewAPI 密钥，首次登录后使用 HttpOnly Cookie 持久化登录状态，重启 App 时直接回到聊天主界面。构建和 MuMu ADB 验收请参阅 [`android/README.md`](android/README.md)，快捷脚本为 `scripts/build-android.ps1` 与 `scripts/install-android-mumu.ps1`。

## 后台运行与登录自启动

```powershell
.\scripts\start-background.ps1 -Port 3020
.\scripts\install-autostart.ps1 -Port 3020
```

停止后台服务：

```powershell
.\scripts\stop-background.ps1
```
