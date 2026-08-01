# Light-Chat

Light-Chat 是一个仅监听本机回环地址的多用户 AI 聊天服务。管理员在账户中心创建用户、分配积分与模型权限；普通用户的会话正文保存在浏览器本地，服务端只保存账户、积分、权限、角色定义和媒体索引。NewAPI 由服务端固定访问 `127.0.0.1:3002`，API 密钥不会进入静态网页、浏览器存储或接口响应。

![Light-Chat](public/assets/light-chat-icon.png)

## 特性

- 管理员账户中心：创建/启停/删除用户、充值积分、配置模型权限组与额外模型授权。
- 普通用户：积分余额、用量统计、收藏模型组、自定义角色、本机历史编辑/分支/导出。
- 多模型对话：默认流式 SSE，可选单次 JSON；支持多轮上下文、附件、usage 与按模型上下文上限。
- 图片能力：`gpt-image-2` 生成与参考图编辑、Gemini Flash 生图、历史图片浏览与下载。
- 安全设计：服务端会话令牌、CSRF、同源校验、登录限速、UID 数据隔离、管理员审计日志。
- Android WebView 客户端：受限同源 HTTPS、HttpOnly Cookie 持久登录，不保存密码或密钥。

## 技术栈

- Node.js 22+（ESM，零运行时前端依赖）
- 原生 HTTP/SSE 服务端 + 原生 HTML/CSS/JavaScript 前端
- NewAPI 作为 OpenAI 兼容上游，固定在 `127.0.0.1:3002`
- Android：Java WebView，Gradle 构建

## 目录结构

```text
lib/                 服务端逻辑：账户、会话、安全、媒体、NewAPI 客户端等
public/              前端静态资源：登录页、工作台、样式、KaTeX 等
scripts/             PowerShell 配置/启动/后台/Android 构建脚本
android/             Android WebView 客户端
test/                Node 单元与集成测试
.data/               运行时数据（gitignored，绝不提交）
.secrets/            DPAPI 加密凭据（gitignored）
```

## 环境要求

- Windows 10/11
- Node.js 22 或更高版本
- NewAPI 已在 `127.0.0.1:3002` 运行
- 应用端口必须位于 `3020–4000`，默认 `3020`

## 快速开始

在 PowerShell 中进入项目目录：

```powershell
.\scripts\configure-secrets.ps1
.\scripts\start-server.ps1
```

`configure-secrets.ps1` 会交互式读取引导管理员用户名、初始密码和 NewAPI 专用密钥，经当前 Windows 用户的 DPAPI 加密后写入 `.secrets/`。首次启动后管理员固定使用 UID `00000`，其他用户只能由管理员创建。

自动化配置也可以通过当前 PowerShell 进程临时设置 `CHAT_SETUP_USERNAME`、`CHAT_SETUP_INITIAL_PASSWORD` 和 `CHAT_SETUP_NEWAPI_API_KEY` 后运行同一脚本；脚本读取后会立即删除这些环境变量。

默认地址为 `http://127.0.0.1:3020`。选择其他允许端口：

```powershell
.\scripts\start-server.ps1 -Port 3021
```

不要直接执行 `npm start`，除非已由受信任进程注入必要环境变量。

## 部署域名与本机一键部署

仓库源码不包含个人部署域名。服务端允许的 Host 通过 `CHAT_ALLOWED_HOSTS` 控制，启动脚本的解析顺序为：

1. `-AllowedHosts` 参数
2. 当前进程环境变量 `CHAT_ALLOWED_HOSTS`
3. gitignored 的 `.local/allowed-hosts` 文件
4. 默认 `127.0.0.1,localhost`

因此本机可以创建 `.local/allowed-hosts` 写入自己的域名（例如 `chat.example.com`），继续使用现有的一键启动脚本，同时不会把域名提交到开源仓库。

Android 构建同理，`scripts/build-android.ps1` 的 Base URL 解析顺序为：

1. `-BaseUrl` 参数
2. 环境变量 `LIGHT_CHAT_BASE_URL`
3. gitignored 的 `.local/base-url` 文件
4. 默认 `https://chat.example.com/`

`.local/` 已在 `.gitignore` 中，只存在于本机。

## 服务端环境变量

| 变量 | 说明 |
| --- | --- |
| `CHAT_NEWAPI_API_KEY` | NewAPI 专用 API 密钥，仅存于服务端进程内存 |
| `CHAT_BOOTSTRAP_USERNAME` | 引导管理员用户名 |
| `CHAT_BOOTSTRAP_PASSWORD` | 引导管理员初始密码 |
| `CHAT_SESSION_SECRET` | 会话签名密钥 |
| `CHAT_PORT` | 监听端口，`3020–4000` |
| `CHAT_TRUST_PROXY` | 反代场景置为 `true` |
| `CHAT_ALLOWED_HOSTS` | 允许的 Host，逗号分隔 |
| `CHAT_DATA_DIR` | 运行时数据目录，默认项目内 `.data/` |

## 数据与隐私

- `.data/`、`.secrets/`、`.logs/`、`.run/`、`.QuickSSH/`、`.playwright-cli/`、`output/`、`tmp/`、`.local/` 均被 `.gitignore` 排除。
- 管理员完整会话以服务端 `.data/conversations-00000.json` 为准；该文件是运行时数据，**不要提交到 git**。
- 普通用户聊天正文、历史文件夹和分支版本保存在浏览器 `localStorage`。
- 服务端只保存密码哈希（`scrypt` + 随机盐）、会话令牌、积分、权限、角色定义和媒体索引。
- 若历史提交中已经混入 `.data/`，仅更新 `.gitignore` 不够，需要重写 git 历史并清理对象，发布前务必确认。

## Android 客户端

Android 客户端位于 [`android/`](android/)，是受限同源 HTTPS WebView。构建与验收详见 [`android/README.md`](android/README.md)。

```powershell
.\scripts\build-android.ps1
```

## 后台运行与登录自启动

```powershell
.\scripts\start-background.ps1 -Port 3020
.\scripts\install-autostart.ps1 -Port 3020
```

停止后台服务：

```powershell
.\scripts\stop-background.ps1
```

## 验证

```powershell
npm test
npm run check
```

## 开源发布检查清单

1. 删除或停止跟踪 `.data/`、`.secrets/` 等运行时目录，并确认 `.gitignore` 覆盖。
2. 检查 `git log --all` 中是否出现过凭据、会话文件、聊天记录或本地绝对路径；如有，重写历史并清理对象。
3. 将个人域名、本机路径替换为配置项或占位域名。
4. 添加 `LICENSE` 并更新 `package.json` 的 `license` 字段。
5. 用 `rg`/GitHub secret scanning 再做一次密钥扫描后发布。

## License

MIT License，详见 [LICENSE](LICENSE)。
