# Light-Chat Android

这是 Light-Chat 的 Android WebView 客户端。首次启动时可输入部署者自己的 HTTPS 服务地址并保存；之后 App 只加载该地址的受信任页面，复用现有登录、聊天、多模型、多媒体上传和生图页面，不在 APK 中保存账户密码或模型服务凭据。

## 构建

本机需要 Android SDK、JDK 17+ 和 MuMu/ADB。当前工程默认使用：

- compile/target SDK 36
- min SDK 29
- Android Gradle Plugin 8.7.3
- Gradle Wrapper 8.11.1

在项目根目录执行：

```powershell
.\scripts\build-android.ps1
```

或手动执行：

```powershell
$env:JAVA_HOME = 'C:\Program Files\Android\Android Studio\jbr'
$env:ANDROID_HOME = Join-Path $env:LOCALAPPDATA 'Android\Sdk'
cd android
.\gradlew.bat testDebugUnitTest lintDebug assembleDebug
```

仓库不包含个人部署域名。默认构建地址为 `https://chat.example.com/`；如果没有在构建时传入真实地址，通用 APK 会在首次启动时显示服务地址配置页。配置会保存在 App 私有 SharedPreferences，之后打开 App 会自动使用该地址。构建时也可以直接注入部署域名，本机一键构建会优先读取 `.local/base-url`（已被 `.gitignore` 排除）：

```powershell
.\gradlew.bat assembleDebug -PLIGHT_CHAT_BASE_URL=https://example.example/
```

使用项目脚本构建时，也可以先设置 `$env:LIGHT_CHAT_BASE_URL`，或在项目根目录创建 `.local/base-url` 写入你的 HTTPS 地址。

构建产物：

- `android/app/build/outputs/apk/debug/app-debug.apk`
- 使用脚本构建后会复制到 `output/android/Light-Chat-1.0.0-debug.apk`

## MuMu 安装与验收

MuMu 的 ADB 设备默认是 `emulator-5554`。可执行：

```powershell
.\scripts\install-android-mumu.ps1
```

或手动：

```powershell
$adb = $env:MUMU_ADB
if (-not $adb) { $adb = Join-Path $env:LOCALAPPDATA 'Android\Sdk\platform-tools\adb.exe' }
& $adb devices -l
& $adb -s emulator-5554 install -r .\app\build\outputs\apk\debug\app-debug.apk
& $adb -s emulator-5554 shell am start -n top.brightcl.lightchat.debug/top.brightcl.lightchat.MainActivity
```

验收顺序：

1. 清除 App 数据，打开后应显示登录页；
2. 输入有效账户登录，确认直接进入聊天主界面；
3. 选择“文件”，应打开系统文件选择器，图片/文档由网页原有上传流程处理；
4. 执行 `am force-stop` 后再次启动，确认不再显示登录页而是直接进入聊天页；
5. 点击侧栏、模型双栏、角色、历史和设置，确认移动端抽屉与对话区域仍可操作；
6. 断网后启动或刷新，确认显示原生重试页，恢复网络后可重新连接；
7. 在网页登录失效时，服务端重定向回登录页，App 不缓存或自动填充密码；
8. Android 15/16 模拟器可用系统挖孔模拟检查顶栏；MuMu Android 12 可用 `cmd overlay enable-exclusive --category com.android.internal.display.cutout.emulation.hole` 做竖屏安全区回归，完成后执行 `cmd overlay disable com.android.internal.display.cutout.emulation.hole` 恢复。

## 持久登录与安全边界

- 登录态只由服务端 `HttpOnly; Secure; SameSite=Strict` Cookie 保存；WebView 调用 `CookieManager.flush()`，支持进程结束后恢复 Cookie。
- Android User-Agent 标记会让服务端为已认证 App 会话签发 30 天有效期；普通网页会话仍为 12 小时。注销、封禁、删除用户或修改密码仍由服务端立即撤销会话。
- WebView 启用 DOM Storage 以保留网页端本机历史；仅向受信任页面提供一个最小下载桥，用于把网页生成的 TXT、Markdown 和 ZIP Blob 写入系统下载目录。下载桥不提供读取文件、账户、Cookie、密钥或设备信息的能力，并在每次写入前重新校验当前页面来源。
- 目标 SDK 36 的 edge-to-edge 窗口由根容器统一处理 `systemBars | displayCutout` inset：状态栏、导航栏、横屏左右挖孔和桌面窗口安全区都会得到 padding；处理后的系统栏 inset 会归零后继续传给 WebView，避免与网页安全区重复留白，同时保留 IME（软键盘）视口更新。
- 只允许精确的已配置 HTTPS 主机导航和普通网络下载；受信任页面自己生成的 `blob:` 导出由受限下载桥保存。HTTP、文件、内容、JavaScript URL、用户信息、非标准端口及外域 Blob 均不会在 WebView 内打开。服务地址可以由构建时的 `LIGHT_CHAT_BASE_URL` 注入，也可以由用户在首次启动时配置；更换地址时会重新校验 HTTPS 和主机边界。
- 禁止明文网络、混合内容、file URL 跨域访问和第三方 Cookie；SSL 错误始终取消连接。
- 文件上传使用 Android 系统 `ACTION_OPEN_DOCUMENT`，不申请相机或公共存储权限；服务端文件通过带当前 Cookie 的系统 `DownloadManager` 下载，网页即时生成的对话导出通过 `MediaStore.Downloads` 保存，两者都只接受受信任页面发起的请求。
- APK 和 Web 前端不包含后台模型服务地址、API 密钥、密码或固定管理员凭据。

## 代码结构

- `app/src/main/java/top/brightcl/lightchat/MainActivity.java`：WebView、Cookie、文件选择、下载、返回键和错误页。
- `app/src/main/java/top/brightcl/lightchat/TrustedNavigation.java`：纯 Java 的 HTTPS 主机和外链策略，配有单元测试。
- `app/src/main/res/`：纸张暖白/丹砂色 UI、启动图和自适应闪电图标。
- `app/src/test/`：URL 白名单与危险 scheme 回归测试。
