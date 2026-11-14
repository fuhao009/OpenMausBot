# 电脑端 debug 包任务清单

## 目的

正式包登录时报"无法连接账户服务"（`network_unavailable`），但看不到底层原因。做一个只用于排错的 debug 包：装好后直接双击打开，所有操作的请求和返回都写进日志文件，用来定位问题。

## 已确认的需求

1. **只在 debug 包里开启**：打包脚本加 `--debug` 选项，只有带这个选项打出来的包才记日志，正式包里没有。不需要任何启动参数或环境变量。
2. **记 4 层，成功和失败都记**：

   | 层 | 记什么 |
   |---|---|
   | 页面 → 主进程 | 登录、注册、退出、查余额、看账本等每个账户操作的输入和结果 |
   | 主进程 → 193 网关 | 每个账户接口的请求和返回 |
   | 本机服务 → 193 网关 | Bot 的每次模型请求和返回，流式回复按收到的顺序逐段记 |
   | 页面 → 本机服务 | 所有 `/api/...` 请求和返回 |

3. **每条日志的内容**：时间、哪一层、方法、地址、状态码、耗时、请求编号（`x-ai-request-id`，有的话）、请求正文、返回正文；失败时加上底层原因（如 `EHOSTUNREACH`、证书错误、超时）。
4. **打码**：密码、各种 token、`Authorization` 请求头、API 密钥换成 `***`，其余正文原样记。日志里会有邮箱、余额、对话内容。
5. **文件**：写到 `~/Library/Logs/Hezuo Product/debug.log`；满 10MB 换下一个文件（`debug-1.log`、`debug-2.log`……）；旧文件全部保留，不自动删。
6. **单一写入方**：本机服务是另一个进程，它的日志发给主进程，由主进程统一写，保证 4 层在同一组文件里、按时间顺序。

## 任务

| # | 任务 | 状态 |
|---|---|---|
| 0 | 补全提交：把联调分支、服务端分支合进当前目录 `feat/bot-panel-unify` | 已完成 |
| 1 | 撤掉之前临时加的改动：`control-plane-client.mjs` 里失败时 `console.error` 的那段；`entitlements.mac.plist` 里加的 `get-task-allow` | 已完成 |
| 2 | 新建 debug 日志模块：10MB 轮转、打码、只在 debug 包开启 | 未开始 |
| 3 | 接入"页面 → 主进程"：账户 IPC 的每个调用 | 未开始 |
| 4 | 接入"主进程 → 193 网关"：账户服务客户端的每个请求 | 未开始 |
| 5 | 接入"本机服务 → 193 网关"：模型请求，经主进程写日志 | 未开始 |
| 6 | 接入"页面 → 本机服务"：所有 `/api` 请求 | 未开始 |
| 7 | 打包脚本加 `--debug` 选项 | 未开始 |
| 8 | 单元测试：轮转、打码、非 debug 包不写日志；类型检查 | 未开始 |
| 9 | 打 debug dmg 放到桌面；装好后登录一次，读 `debug.log` 找出连不上 193 的原因 | 未开始 |

## 已找到的接入点

| 层 | 位置 |
|---|---|
| 页面 → 主进程 | `desktop/electron/product-account-ipc.mjs`：`register()` 是所有账户操作的唯一入口 |
| 主进程 → 193 网关 | `desktop/electron/control-plane-client.mjs`：`request()` 是所有账户接口的唯一出口；`main.mjs` 第 756、2875 行创建这个客户端 |
| 本机服务 → 193 网关 | `desktop/electron/product-ca.mjs`：`createPinnedHttpsFetch()`，带内置证书的产品包里所有模型请求都经过它（`desktop/server/drivers/pinned-trust.ts` → `openai-compat.ts` → `openai-chat.ts`） |
| 页面 → 本机服务 | `desktop/server/index.ts`：`handleRequest`（第 12749 行）是所有 `/api` 请求的入口 |
| 本机服务发日志给主进程 | `utilityParentPort.postMessage`（`desktop/server/index.ts`）；主进程在 `main.mjs` 的 `proc.on("message")` 接收 |
| 现有日志目录 | `main.mjs` 第 517 行 `LOG_DIR = app.getPath("logs")`，即 `~/Library/Logs/Hezuo Product/` |

## 相关遗留（不属于 debug 包，但还没收尾）

- 代码已统一到 `feat/bot-panel-unify`（当前目录 `HezuoBot`）：合并了联调分支 `integ/desktop-gateway` 和服务端 `backend/gateway-beta` 的全部提交（`75e6f31be`）。之后只在这个目录开发和打包。
- `electron-builder.yml` 的本地网络用途声明 `NSLocalNetworkUsageDescription` 已提交。
- 打包脚本直接用 `node` 运行时找不到 `electron-builder`（只在 `node_modules/.bin` 里），要用 `pnpm` 运行或把 `.bin` 加进 `PATH`。
- `desktop/server/mcp-bridge.test.ts` 用了 `Promise.withResolvers`，服务端类型检查因此报 1 个错（目标是 ES2023）。这是电脑端开发未完成的改动，随 `6a1ee94a9` 原样提交，等开发处理。
- 自签名证书 `Hezuo Local Signing` 已导入本机钥匙串。签名版 dmg 在桌面 `Hezuo-0.1.139-arm64-signed.dmg`，首次打开会被 Gatekeeper 拦，要右键打开。
- 签名、本地网络权限、`--lan-origin` 打包的交接文档还没写。
