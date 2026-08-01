# Light-Chat

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Light-Chat 是一个运行在本机、面向多用户的 AI 聊天工作台。管理员负责创建用户、分配积分和模型权限，普通用户专注对话与知识整理。服务端代持上游 API 密钥，密钥不会进入浏览器；普通用户会话正文保存在浏览器本地，服务端不收集聊天内容。

<img src="public/assets/light-chat-icon.png" alt="Light-Chat" width="512" />

## 功能亮点

### 对话文件夹

历史对话支持文件夹整理：拖拽归组、折叠与展开、文件夹头部操作，以及“未归档对话”独立折叠区。文件夹结构持久化，按最近活动排序，方便把散落的会话整理成可复用的知识库。

### 收藏对话

常用会话可以一键收藏，收藏列表按最近活动自动排序。配合最近图片侧栏，可以快速回到重要的讨论、继续上下文，或者把某个历史消息作为新对话的起点。

### 收藏图片

生成过的图片会进入按用户隔离的媒体库，支持跨页浏览、灯箱预览、悬浮下载、上下文菜单复制，以及从图片跳回源消息。图片归属严格按 UID 校验，用户之间无法互相读取。

### 收藏模型

模型可以组织成收藏组，右上角模型按钮优先展开收藏，底部“更多模型”再进入完整模型库。服务端按用户权限过滤模型：管理员配置“权限组 + 额外模型”授权，普通用户只能看到并使用自己被允许的模型。

### 快速翻译

内置受保护的双面板快速翻译：左原文、右译文，本地保留历史，可选择当前已授权模型。翻译入口不会破坏当前对话，适合阅读外文资料时的即取即用。

### 打包工作流

工作流是可配置、可复用的多步骤任务：聊天、角色卡、临时系统提示词、生图等节点可以组合成一条流水线，支持拖拽编排、画布平移与展开。工作流按用户保存，服务端执行时只注入校验过的角色或系统提示词。

### 历史消息快捷键

历史消息支持右键或快捷键快速操作：编辑原文、单条删除、从任意用户/助手节点建立新分支、重新生成、`@` 收藏模型重新生成，以及切换最多 8 个回答版本。回答版本会完整保留后续消息链、模型名、图片、思考过程和 usage。

### 自定义角色

支持自定义角色文件夹、拖拽排序与右键管理；角色卡可以展开浏览其衍生对话并直接跳转。系统提示词只保存在服务端，聊天时按角色 ID 注入，客户端不能绕过校验提交任意 system 消息。

## 其他能力

- 多模型对话：默认 SSE 流式，可切换单次 JSON；支持多轮上下文、附件与 usage 展示。
- 生图与图片编辑：`gpt-image-2` 生成/参考图编辑，Gemini Flash 生图，支持多尺寸竖图与 PNG mask。
- 文档上传：PNG/JPEG/WebP、TXT/MD、PDF、DOC/DOCX、PPT/PPTX，服务端只做签名和体积校验。
- 账户中心：额度概览、账户与安全、用户管理、充值/启停/删除、模型权限分组。
- Android WebView 客户端：受限 HTTPS、HttpOnly Cookie 持久登录，不保存密码或密钥。

## 安全设计

- 服务仅监听 `127.0.0.1`，外网入口通过 HTTPS 反向代理。
- 密码使用 `scrypt` + 独立随机盐保存，永不保存明文。
- 会话为服务端不透明令牌，CSRF、同源校验、登录限速、UID 数据隔离默认开启。
- 管理员关键操作写入 `.data/admin-audit.jsonl`，不记录密码、密钥或请求正文。
- 上游 API 地址由服务端配置（默认 `http://127.0.0.1:3002/v1`），客户端不能提供上游地址，不限定于任何特定 API 渠道。

## 快速开始

环境要求：Windows 10/11、Node.js 22+、OpenAI 兼容上游服务（默认地址为 `127.0.0.1:3002`，可通过环境变量修改）。

```powershell
.\scripts\configure-secrets.ps1
.\scripts\start-server.ps1
```

`configure-secrets.ps1` 会交互式配置引导管理员用户名、初始密码和上游 API 密钥，经当前 Windows 用户 DPAPI 加密后写入 `.secrets/`。默认地址为 `http://127.0.0.1:3020`。

后台运行与登录自启动：

```powershell
.\scripts\start-background.ps1 -Port 3020
.\scripts\install-autostart.ps1 -Port 3020
```

## 部署域名

仓库源码不包含个人部署域名。服务端允许的 Host 按以下顺序解析：

1. `-AllowedHosts` 参数
2. 环境变量 `CHAT_ALLOWED_HOSTS`
3. gitignored 的 `.local/allowed-hosts`
4. 默认 `127.0.0.1,localhost`

Android 构建的 Base URL 同样支持 `.local/base-url` 或 `LIGHT_CHAT_BASE_URL`，方便本机一键构建而不把域名提交到仓库。

## 上游 API 配置

上游地址通过 `CHAT_UPSTREAM_BASE_URL` 指定，默认值为 `http://127.0.0.1:3002/v1`。也可以在本机创建 gitignored 的 `.local/upstream-base-url` 写入自定义地址，`scripts/start-server.ps1` 会自动读取。

其他服务端环境变量：

| 变量 | 说明 |
| --- | --- |
| `CHAT_UPSTREAM_API_KEY` | 上游 API 密钥，仅存于服务端进程内存 |
| `CHAT_UPSTREAM_BASE_URL` | 上游 OpenAI 兼容 API 地址 |
| `CHAT_BOOTSTRAP_USERNAME` | 引导管理员用户名 |
| `CHAT_BOOTSTRAP_PASSWORD` | 引导管理员初始密码 |
| `CHAT_SESSION_SECRET` | 会话签名密钥 |
| `CHAT_PORT` | 监听端口，`3020–4000` |
| `CHAT_TRUST_PROXY` | 反代场景置为 `true` |
| `CHAT_ALLOWED_HOSTS` | 允许的 Host，逗号分隔 |
| `CHAT_DATA_DIR` | 运行时数据目录，默认项目内 `.data/` |

## 目录结构

```text
lib/                 服务端逻辑：账户、会话、安全、媒体、上游 API 客户端等
public/              前端静态资源：登录页、工作台、样式、KaTeX 等
scripts/             PowerShell 配置/启动/后台/Android 构建脚本
android/             Android WebView 客户端
test/                Node 单元与集成测试
.data/               运行时数据（gitignored）
.secrets/            DPAPI 加密凭据（gitignored）
```

## 验证

```powershell
npm test
npm run check
```

## 数据与隐私

- `.data/`、`.secrets/`、`.logs/`、`.run/`、`.local/` 等运行时目录均被 `.gitignore` 排除。
- 普通用户聊天正文只存在浏览器 `localStorage`；管理员会话以服务端 `.data/conversations-00000.json` 为准。
- 服务端只保存密码哈希、会话令牌、积分、权限、角色定义和媒体索引，不收集聊天正文。
- 服务端 JSON 每次保存前会自动保留上一份 `.bak`；收藏图片等偏好记录意外被清空时，可运行 `.\scripts\restore-preferences-backup.ps1` 从备份恢复。

## License

MIT License，详见 [LICENSE](LICENSE)。

## 作者

© 2026 [Bright-Chengliang](https://github.com/Bright-Chengliang) · Light-Chat
