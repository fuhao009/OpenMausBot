# Hezuo 架构与配置

本文使用目录拆分后的源码路径；源码移动不改变任何现有用户数据目录、数据库、密钥路径或部署标识。

## 整体关系与数据边界

```text
手机 App（mobile/android、mobile/ios）
  │ 账号登录、安装列表、手机中继
  ▼
网关（gateway/） ── 模型请求 ──▶ 运营者配置的上游 API
  ▲ HTTPS；本机部署地址 https://127.0.0.1:18487
  │ 账号、积分、模型凭据；桌面建立中继连接
桌面 Hezuo（desktop/electron、desktop/src）
  │
  ▼
桌面本地服务（desktop/server）
  http://127.0.0.1:8799
  bot、对话、群、部门、工作区与本地工具执行
```

- 桌面本地服务和网关是两个独立服务，**不共享数据库或数据目录**。网关保存账号、会话、安装归属、AI 权限、积分账本和请求结算；它不是 bot 和对话的存储服务。手机通过中继操作所属桌面上的数据，不会把桌面数据库迁入网关。
- `8799` 是桌面首选端口；占用时还会尝试 `18799`、`28799`（`desktop/electron/desktop-ports.mjs`）。`18487` 是当前本机部署选择的网关端口，并非 CLI 默认值；本地网关默认端口是 `8787`。
- 手机上的 `127.0.0.1` 指手机本身，不是电脑。跨设备连接必须使用手机可达、证书可信且网关实际绑定的 HTTPS 地址；仅监听电脑回环地址的部署只适用于本机客户端。
- 本机网关的数据目录约定为 `~/Library/ApplicationSupport/HezuoGateway/`（注意 `ApplicationSupport` 没有空格）。CLI 未指定数据目录时默认用仓库的 `.omb-scratch/local-gateway/`。两者不可混为一谈，移动源码也不应移动数据。

### 源码职责

| 路径 | 职责 |
| --- | --- |
| `desktop/src/`、`desktop/public/`、`desktop/*.html` | 桌面/网页 UI 与静态资源 |
| `desktop/server/` | bot、对话、部门、工具与本地 API |
| `desktop/electron/`、`desktop/companion/` | 桌面宿主、系统能力、远程连接与 companion 服务 |
| `mobile/android/`、`mobile/ios/` | Android 与 iOS 原生客户端 |
| `gateway/control-plane/` | Cloudflare Worker：认证、安装、模型代理、账本与运营者接口 |
| `gateway/local/` | 同一 Worker 的本地 Miniflare/TLS 宿主及手机中继 |
| `gateway/composio-broker/` | 独立的托管连接服务 |
| `gateway/scripts/` | 网关部署与账号 AI 管理工具 |
| `packages/shared/` | 桌面与控制平面等使用的共享类型、协议和纯逻辑 |
| 根目录 `scripts/` | 桌面构建、打包及仓库工具；`dist*`、`release/` 仍在根目录 |

拆分不是完全独立的包边界。`gateway/local/local-gateway/companion-relay.mjs` 仍引用 `desktop/electron/companion-relay-frames.mjs` 的隧道帧编码；`gateway/local/local-gateway.mjs` 的账号命令仍引用 `desktop/electron/control-plane-client.mjs`。`desktop/` 和 `gateway/control-plane/` 也都会引用 `packages/shared/`。这些依赖在部署/复制源码时不能遗漏。

## 网关对外接口

账号会话、安装凭据、短期模型凭据各有用途，不能互换。下表概括已实现的路由；完整安装协议见 [控制平面 README](../gateway/control-plane/README.md#api-surface)。

| 方法 | 路径 | 用途与权限 |
| --- | --- | --- |
| 按 Better Auth 路由 | `/api/auth/*` | 邮箱/密码注册、登录、退出，以及配置邮件后的验证码流程 |
| `GET` | `/v1/auth/methods` | 无需登录；查询密码策略、验证码是否可用、是否要求验证邮箱 |
| `GET` | `/v1/me` | 账号 bearer 会话；当前账号身份 |
| `GET` | `/v1/ai/models` | 短期模型凭据；可用模型目录，查询本身不扣积分 |
| `POST` | `/v1/ai/chat/completions` | 短期模型凭据；Chat Completions 转发、预扣与用量结算 |
| `POST` | `/v1/ai/responses` | 短期模型凭据；Responses 转发、预扣与用量结算 |
| `GET` | `/v1/account/ai` | 账号会话；自身 AI 状态与余额 |
| `GET` | `/v1/account/ai/ledger` | 账号会话；自身积分扣费和调整记录 |
| `POST`、`DELETE` | `/v1/account/ai/tokens`、`/v1/account/ai/tokens/:id` | 账号会话；为设备签发短期模型凭据、撤销自身凭据 |
| `GET`、`POST` | `/v1/installations` | 账号会话；列出/注册自己的桌面安装 |
| `POST`、`DELETE` | `/v1/installations/:id/credentials/rotate`、`/v1/installations/:id` | 所属账号会话；轮换安装凭据、撤销安装 |
| `GET` | `/v1/installations/self` | 安装凭据；读取当前安装身份 |
| `GET`、`POST`、`DELETE` | `/v1/installations/self/endpoint` | 安装凭据；读取、申请、清理托管端点（需要对应部署能力） |
| `POST` | `/v1/installations/self/push/register`、`unregister`、`send` | 安装凭据；设备推送注册、注销和发送 |
| WebSocket upgrade | `/v1/companion/relay` | 本地网关的桌面隧道入口；验证安装凭据 |
| HTTP / WebSocket | `/v1/companion/:installationId/*` | 本地网关手机侧中继；验证账号会话及安装归属，再转给在线桌面 |
| `GET`、`POST` | `/v1/operator/ai/account` | 仅运营者账号：按邮箱查询、开启或关闭账号 AI |
| `POST` | `/v1/operator/ai/balance` | 仅运营者账号：增加积分，写审计记录 |
| `GET`、`POST` | `/v1/operator/ai/requests`、`/v1/operator/ai/requests/:id/settle` | 仅运营者账号：查请求、结算待复核预扣 |
| `GET` | `/v1/operator/me` | 仅运营者账号：当前身份、公开模型及脱敏能力 |
| `GET`、`POST` | `/v1/operator/channels` | 仅运营者账号：读取/版本化保存渠道和模型目录，密钥只写 |
| `POST` | `/v1/operator/channels/:id/probe` | 仅运营者账号：读取已保存渠道的上游模型列表，不自动发布 |
| `GET` | `/healthz` | 无需登录；网关健康与可用的容量信息，不等于桌面在线或上游可推理 |
| `POST`、`GET` | `/v1/highlevel/start`、`/v1/highlevel/callback`、`/v1/highlevel/claim`、`/v1/highlevel/refresh` | HighLevel OAuth 跳转/回调/领取/刷新；回调用 `GET`，其余用 `POST`；受随机 state、令牌与限流约束 |

运营者必须是 `operatorIds`（Worker 中的 `AI_OPERATOR_USER_IDS`）列出的**账号 ID**；先注册的账号不会自动成为管理员。注册也不会自动开启 AI 或赠送积分。管理 CLI 是 `gateway/scripts/account-ai-admin.mjs`；同源 `/admin` 网页管理账号、积分、请求结算及渠道模型。

## 配置在哪里改

本机部署配置文件为 `~/Library/ApplicationSupport/HezuoGateway/gateway.json`。以下 `<数据目录>` 指该配置的 `dataDir`，不是源码目录。配置和密钥文件应保持私有权限；不要把真实凭据写进源码、命令行或文档。

渠道管理保存前，下表的单上游字段继续生效；首次通过 `/admin` 保存后，D1 中的版本化渠道目录成为模型和上游配置的唯一来源，保存立即作用于新请求，清空目录不会回退旧配置。认证、监听、TLS 和运营者名单仍由服务器配置管理。详见 [渠道管理](gateway-channels.md)。

| 配置 | 本地位置 / 操作 | Worker 对应项或客户端位置 |
| --- | --- | --- |
| 上游地址 | `gateway.json` 的 `upstreamBase`；`init --upstream-base` | `AI_UPSTREAM_BASE_URL`，必须是 HTTPS API base |
| 上游 key | `<数据目录>/secrets/upstream-key`，或 `openModelsFile` 指向的 `~/.omp/agent/models.yml` 中所选 provider 的 `apiKey` | `AI_UPSTREAM_API_KEY` secret；使用 OMP 源时每次启动重新读取，同一个文件也供 OMP 使用 |
| 模型、输入/缓存输入/输出单价、上下文与输出上限 | `gateway.json` 的 `models` 数组；可由 `init --models <file>` 或 `--open-models` 加明确费率生成 | `AI_MODELS` JSON；各模型的 `enabled`、`upstreamModel`、`maxContextTokens`、`maxOutputTokens` 等 |
| 默认公开模型 | `defaultModel`；`init --default-model` | `AI_DEFAULT_MODEL` |
| 运营者账号 | `operatorIds`；`operator --operator-email` 或 `init --operator-id` | `AI_OPERATOR_USER_IDS` JSON 账号 ID 数组 |
| 登录方式 | `emailVerification` 为 `required` / `off`；邮件还需 `emailFrom` 和 `<数据目录>/secrets/smtp-url` | `AUTH_EMAIL_VERIFICATION`、`EMAIL_FROM`、`EMAIL` binding；`off` 不等于禁用密码登录 |
| TLS 证书与私钥 | `<数据目录>/tls/`；或 `--cert` / `--key`（配置中的 `certFile` / `keyFile`） | 本地 TLS 宿主；Worker 公网 TLS 由部署域名提供 |
| 监听地址与端口 | `host`、`port`、`publicHost`；非回环绑定必须明确公开主机名 | 决定客户端实际使用的 HTTPS origin |
| 桌面固定网关地址及信任证书 | 打包时 `OMB_PRODUCT_SERVICE_URL` 和 `--gateway-ca`；本机 origin 另需 `--local-origin` | 写入包内 `product-service.json`；不是让 renderer 任意选择上游 |
| 手机端网关地址 | 登录页手动输入手机可达的网关地址 | Android `mobile/android/app/src/main/kotlin/com/openmausbot/companion/ui/AccountLoginScreen.kt`；iOS `mobile/ios/App/AccountLoginView.swift` |
| 云端部署 | `gateway/control-plane/wrangler.jsonc` 的 vars、D1、bindings 与 secrets | 部署工具 `gateway/scripts/deploy-product-service.mjs`，不是根目录 `scripts/` |

单价使用每百万 token 的微积分，1 积分 = 1,000,000 微积分。模型目录必须由运营者明确启用和定价；修改公开模型不等于实现按复杂度自动切换上游模型。未迁移渠道目录的部署，`init` 的外部模型文件、默认模型和费率参数可能重新生成 `models`，修改这些启动配置后需重启。网页渠道配置立即用于新请求，已预占请求保留原计价快照。

## 两种部署方式

### 本地网关

入口 `gateway/local/local-gateway.mjs` 将 `gateway/control-plane/src/index.ts` 打包交给 Miniflare，使用同一份 Worker 和 `gateway/control-plane/migrations/`，持久化 D1 状态在 `<数据目录>/state/`。外层提供 HTTPS、自签名证书、SMTP 适配及桌面/手机中继。macOS 可通过 `service install` 安装 launchd 登录服务。详细命令、证书信任和私有文件要求见 [本地网关](local-gateway.md)。

源码搬迁不会自动更新已安装 LaunchAgent 的绝对路径。指向旧入口的服务在下一次启动可能失败；应先在隔离数据目录验证新入口，再由维护者安排重新安装服务。**不要为了阅读或修改文档重启真实服务，也不要改动已有用户数据库。**

### Cloudflare Worker

`gateway/control-plane/` 用 Wrangler 部署，同样执行认证、安装、模型代理与积分账本逻辑，使用云端 D1、vars 和 secrets。可用 `gateway/scripts/deploy-product-service.mjs` 完成运营者自己的部署，见 [产品发布](product-release.md)。

同一份 Worker 不代表外层能力相同：`/v1/companion/relay` 和 `/v1/companion/:installationId/*` 实现位于本地 Node 宿主，不在 Worker 路由里。云端远程连接使用控制平面的托管端点和 Cloudflare Tunnel，不能把只有 Worker 的域名当作本地 Node 中继入口。数据库也不会在两种部署间自动同步。

## 本机开发环境与网络约定

当前维护机器的环境约定（不是所有开发机器的通用安装要求）：

```sh
export PATH="$HOME/.local/nodejs/node-v24.16.0-darwin-arm64/bin:$HOME/.local/bin:$PATH"
# pnpm 位于 ~/.local/bin/pnpm
unset ELECTRON_RUN_AS_NODE
```

启动 Electron 前取消 `ELECTRON_RUN_AS_NODE`，否则可能以 Node 模式运行。桌面配置文件在 `desktop/` 下（如 `desktop/vite.config.ts`、`desktop/tsconfig.json`）；根目录保留包管理和打包入口。

网关访问上游时必须能通过 DNS 正确解析上游域名。此机器曾因路由器 DNS 无法解析上游而失败，现使用公共 DNS `223.5.5.5`、`119.29.29.29`；这是 macOS 系统网络设置，不是仓库配置。排查时先区分 DNS/网络故障、TLS 信任错误和上游认证/权限错误，不要用关闭 TLS 校验或硬编码 IP 掩盖故障。
