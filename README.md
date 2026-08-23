# Light-Chat

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Light-Chat 是一个运行在本机、面向多用户的 AI 聊天工作台。管理员负责创建用户、分配积分和模型权限，普通用户专注对话与知识整理。服务端代持上游 API 密钥，密钥不会进入浏览器；普通用户会话正文保存在浏览器本地，服务端不收集聊天内容。

它不是又一个只能打开单一模型页面、发送几条消息的聊天界面。Light-Chat 把多模型对话、生图与图片编辑、可整理的对话历史、可复用角色和多步骤工作流放进同一个工作台；多人使用时，管理员还能统一管理模型权限与额度，并按账户隔离用户数据。

使用它可以直接得到这些体验：

- **不用在不同模型页面之间来回切换**：在同一个对话里选择对话模型、生图模型或图片编辑模型。
- **让对话变成可继续使用的工作资料**：文件夹、收藏、分支、回答版本和导出都围绕历史对话组织。
- **把重复任务变成可复用流程**：角色卡保存稳定的工作方式，多步骤工作流串联角色、提示词、合并和生图节点。
- **让图文资料直接进入工作台**：图片、PDF、Word 和 PowerPoint 可以作为对话材料，生成的图片也能统一预览、收藏和回溯。
- **换设备也能继续工作**：管理员登录其他设备后，可以从服务端恢复完整会话、图片和工作资料，不必依赖某一台浏览器；普通用户和游客的聊天正文为了隐私只保存在本地，不提供跨设备同步。

项目同时提供 Web 工作台和受限 HTTPS Android 客户端。

## 界面预览

<img src="public/assets/light-chat-screenshot.png" alt="Light-Chat 新对话主界面预览" width="800" />

Light-Chat 新对话主界面：在一个工作区内选择模型、角色和工作流，整理历史对话与媒体，并直接开始多模态任务。

<p align="center">
  <img src="public/assets/light-chat-favorite-groups.png" alt="Light-Chat 默认对话模型和默认生图模型收藏组设置" width="800" />
</p>

模型收藏组设置：`默认对话模型` 和 `默认生图模型` 分别对应工作区底部的两个模型选择器；每组第一项就是该模式的默认模型，同一个模型也可以同时加入两个组。

<p align="center">
  <img src="public/assets/light-chat-guest-direct.png" alt="Light-Chat 游客模型浏览器直连设置" width="800" />
</p>

游客模型直连设置：端点和密钥只保存在当前浏览器，模型列表、对话和生图请求由浏览器直接发送到用户配置的上游服务。

## 架构概览

```mermaid
flowchart LR
    Web[Web 工作台\npublic/app.js] --> Server[Node.js 服务\nserver.mjs + lib/app.mjs]
    Android[Android WebView\n受限 HTTPS] --> Server
    Server --> Auth[账户 / 会话 / CSRF\n安全边界]
    Server --> Stores[JSON Stores\n账户、角色、媒体、偏好]
    Server --> Upstream[OpenAI-compatible\n上游模型服务]
    Server --> Tools[PDF / 生图 / 工作流\n工具链]
```

普通账户的请求、权限和上游模型调用经过 Node 服务端；游客模式由浏览器直连用户配置的上游，浏览器不把游客密钥提交给本站。`lib/` 负责领域逻辑，`public/` 提供无构建前端，`android/` 是面向移动端的受限客户端。

## 功能亮点

### 对话文件夹

历史对话支持文件夹整理：拖拽归组、折叠与展开、文件夹头部操作，以及“未归档对话”独立折叠区。文件夹结构持久化，按最近活动排序，方便把散落的会话整理成可复用的知识库。

### 收藏对话

常用会话可以一键收藏，收藏列表按最近活动自动排序。配合最近图片侧栏，可以快速回到重要的讨论、继续上下文，或者把某个历史消息作为新对话的起点。

### 收藏图片

生成过的图片会进入按用户隔离的媒体库，支持跨页浏览、灯箱预览、悬浮下载、上下文菜单复制，以及从图片跳回源消息。图片归属严格按 UID 校验，用户之间无法互相读取。

### 本地图片超分

本机超分有两种模式：**细节增强**调用 Real-ESRGAN NCNN Vulkan 的 `realesrgan-x4plus` 模型，再用 Pillow 调整到目标尺寸；**文字保真**跳过 AI 超分，只使用 Python Pillow 的高质量 `LANCZOS` 缩放，适合包含文字、线条或排版的图片。

部署本机超分需要额外环境：Python、Pillow，以及细节增强模式所需的 `realesrgan-ncnn-vulkan.exe` 和 `realesrgan-x4plus` 模型文件。默认引擎路径为项目同级的 `../image-upscaler/realesrgan-ncnn-vulkan/realesrgan-ncnn-vulkan.exe`。其他部署者可以让 AI 按这个默认目录协助安装和配置，也可以自行准备引擎、模型和 Python 依赖；未配置本地超分时，聊天、生图和图片编辑等其他能力仍可独立使用。

### 收藏模型

模型可以组织成收藏组，右上角模型按钮优先展开收藏，底部“更多模型”再进入完整模型库。服务端按用户权限过滤模型：管理员配置“权限组 + 额外模型”授权，普通用户只能看到并使用自己被允许的模型。

### 游客模式

登录页支持免密进入游客模式：游客默认没有积分、也没有系统预置的模型权限，但可以在“设置”中自行配置 OpenAI 兼容 API 服务端点、可选 API 密钥和可用模型列表。游客配置保存在当前浏览器，模型列表、聊天和生图请求由浏览器直接发送到该端点；因此可以使用用户设备本地可达的 API，但上游必须允许浏览器跨域请求。

想快速体验游客模式，可以直接访问 [chat.brightcl.top](https://chat.brightcl.top)，在登录页选择“以游客身份进入”。

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
- 生图与图片编辑：能力取决于已配置的上游模型；图片还可调用本机 Real-ESRGAN 或 Pillow 超分。
- 文档上传：PNG/JPEG/WebP、TXT/MD、PDF、DOC/DOCX、PPT/PPTX，服务端只做签名和体积校验。
- 账户中心：额度概览、账户与安全、用户管理、充值/启停/删除、模型权限分组。
- Android WebView 客户端：受限 HTTPS、HttpOnly Cookie 持久登录，不保存密码或密钥。

## 安全设计

- 服务仅监听 `127.0.0.1`，外网入口通过 HTTPS 反向代理。
- 密码使用 `scrypt` + 独立随机盐保存，永不保存明文。
- 会话为服务端不透明令牌，CSRF、同源校验、登录限速、UID 数据隔离默认开启。
- 管理员关键操作写入 `.data/admin-audit.jsonl`，不记录密码、密钥或请求正文。
- 游客免密会话只获得零积分、零预置模型权限的浏览器本地角色；游客端点和 API 密钥只保存在当前浏览器缓存，不写入本站服务端。
- 普通账户上游 API 地址由服务端配置；游客模式由浏览器使用用户在本机设置的端点直连，不限定于任何特定 API 渠道。

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
- 服务端只保存密码哈希、会话令牌、积分、权限、登录账户数据和管理员媒体索引，不保存游客 API 密钥或游客聊天正文。
- 服务端 JSON 每次保存前会自动保留上一份 `.bak`；收藏图片等偏好记录意外被清空时，可运行 `.\scripts\restore-preferences-backup.ps1` 从备份恢复。

## License

MIT License，详见 [LICENSE](LICENSE)。

## 作者

© 2026 [Bright-Chengliang](https://github.com/Bright-Chengliang) · Light-Chat
