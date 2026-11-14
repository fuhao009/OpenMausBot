# 192.168.66.193 网关部署

## 电脑端 Bot 模型链路（2026-11-14 实机核对）

安装版 `/Applications/Hezuo.app/Contents/Resources/product-service.json` 指向
`https://192.168.66.193:18487`，并包含网关 CA。网关服务端已经部署，模型渠道已经配置。
托管版 Bot 走项目自己的 `product-ai`（界面名称 Hezuo AI）及账号网关，不需要 Codex CLI 登录或个人模型密钥。

**不要因为 `gateway.json` 中模型字段为空，或 `gateway-runtime.json` 显示 `ai: false`，就判断没有模型。**
本次只读检查发现，这两个文件未反映数据库中的渠道配置；实际模型目录保存在 D1 的
`ai_channel_catalog.snapshot_json`。核对时还应检查账号可用模型及 Bot/会话实际选择，不能把网关默认模型当作所有 Bot 的模型。

| 模型 ID | 已启用 | 协议 | 上游模型 |
| --- | --- | --- | --- |
| `gpt-6-luna` | 是，网关默认 | `responses` | `gpt-6-luna` |
| `gpt-6.1-sol` | 是 | `responses` | `gpt-6.1-sol` |
| `gpt-6-astra` | 是 | `responses` | `gpt-6-astra` |
| `gpt-6-luna-chat` | 是 | `chat` | `gpt-6-luna` |

- 已启用渠道：`omp-fuhaoliang`（OMP Fuhaoliang），地址 `https://api.muzeai.top/v1`；数据库存在加密凭据，不读取、复制或输出其内容。
- 服务状态：`hezuo-gateway.service` 为 active。
- 本次检查时，最近三条 `account_ai_requests` 均为 `settled`，模型为 `gpt-6-luna-chat`，记录耗时为 6141、5669、5194 ms。这些是已有推理记录，不是浏览器验收结果。
- 实际数据库文件：`/var/lib/hezuo-gateway/state/d1/miniflare-D1DatabaseObject/ebc39d1dd414791fd5b9687094fc221f1605b876d0f2096b673dbaf585b55bd2.sqlite`。路径若变化，从服务数据目录定位；只读检查，不修改生产数据。
- 上表是核对时的快照，之后以账号模型目录和实际请求记录为准。

### Bot 网页验收要求

用户自然语言需求 → Hezuo Bot → 账号网关真实模型 → 模型选择浏览器工具 → 目标网页变化 → 结果返回模型 → Bot 回复。
每项必须记录测试事项、实际模型、Bot 名字、每步动作与耗时、页面证据及是否成功。
测试脚本直接调用工具、模拟模型、已有服务端推理记录，都不能替代这条完整链路。
目前尚未完成真实模型驱动内嵌网页的验收；内嵌页面绑定也不能视为已经接入正式应用。

## 部署记录

### 2026-11-13 内测修复部署

当前实际部署 `8e54c107d`，分支 `backend/gateway-beta`。18项迁移已应用、0待应用，HTTPS健康与后台200。渠道revision3、任务计费策略revision3，新增 Luna Chat 和 auto-chat。每次部署均停服并完整备份数据/源码；备份 `pre-beta-<SHA>-{data,code}.tgz` 位于root私有backups目录。

35,012输入tokens预占20.6074积分；客户端断开后可信usage结算、reserved归零。最终真实模型矩阵22条全部settled且成本非unknown。供应商后台独立对照及遗留复核账号清理尚未完成，详细提交、请求ID、失败历史和验收边界见 [内测交付](gateway-beta-delivery.md)。下方任务计费部署信息为此前历史记录。


- 地址：`https://192.168.66.193:18487`，仅绑定该内网地址。
- 服务：`hezuo-gateway.service`，已启用开机启动，运行账号 `hezuo-gateway`。
- 源码：`/opt/hezuo-gateway/app`。
- 独立 Node 24.16.0：`/opt/hezuo-gateway/runtime/node_modules/node/bin/node`；未替换系统 Node。
- 数据和配置：`/var/lib/hezuo-gateway/`、`/var/lib/hezuo-gateway/gateway.json`。
- 证书：`/var/lib/hezuo-gateway/tls/gateway-cert.pem`；私钥只留服务器。
- 本机证书副本：`.omb-scratch/remote-gateway-193/gateway-cert.pem`。

初次部署时为全新环境，未迁移原电脑数据库、账户或上游凭据；当时仅开启密码登录，未配置邮件、上游模型、价格或运营者。模型配置现状以上方实机核对为准。没有修改现有 nginx 或其他服务。

全新部署，未迁移原电脑用户数据库。管理员 `fuhaoliang@admin.com` 已显式授权。按用户授权使用 OMP 上游渠道；当前目录 revision 2，发布 `gpt-6-luna`、`gpt-6.1-sol`、`gpt-6-astra`（均 Responses），保留默认 `gpt-6-luna`。任务计费策略 revision 2 已启用，目录同时提供 `auto-responses`。模型发现成功；真实客户端推理仍待联调。邮件未配置，没有修改 nginx 或其他服务。

管理网页：`https://192.168.66.193:18487/admin`。此前任务计费部署为 `89e3991c6`；当前提交以上方内测记录与 `/opt/hezuo-gateway/deployed-commit` 为准。随机管理员初始密码保存在服务器 `/root/hezuo-admin-initial-credentials.json`（root，0600），不进入 Git。

### 2026-11-13 任务计费上线

- 部署前停止 `hezuo-gateway.service`，完整备份数据与旧代码到 `/opt/hezuo-gateway/backups/pre-task-billing-89e3991c6-data.tgz` 和 `pre-task-billing-89e3991c6-code.tgz`；配套旧提交记录为 `pre-task-billing-89e3991c6-deployed-commit`，均 root 私有 0600。
- 从已提交源码归档发布，没有复制本机依赖、用户数据或密钥。systemd 返回 active；CLI `running=true,healthy=true`，16 项迁移已应用、0 项待应用。开发机通过 CA 校验访问 `/healthz`、`/admin` 均 200。
- 通过既有运营者会话查询真实渠道 `/models`，确认 Luna、Sol、Astra 三个候选存在；没有调用付费推理。发布保留渠道加密 key、原 Luna 参数与默认模型；新增 Sol、Astra 的运行限额为上下文 128000、输出 4096，比 OMP 中声明的上限更保守。
- 策略显式启用：1000 积分/USD 估值、目标估算毛利 50%、风险附加 10%，初始成本倍率 2.2×，上限 5×、单步 0.1×、至少 20 个终态样本、60 秒冷却、60 分钟窗口。源码默认关闭不代表本次生产仍关闭；隔离浏览器保存的 55% 没有用于生产。
- 模型档案：Luna=simple，Sol=standard，Astra=complex，三者工具/图像均开启。策略 revision 2 保留显式 Luna 原有的工具/图片请求准入，避免在新计费层缩小既有调用范围；这不是证明上游能力。Sol/Astra 图像输入和 Responses 来自现有 OMP 声明，三者工具与图像真实调用仍未联调。自动选模遵循能力下限，不额外收取复杂度费。
- 运营者 API 已读取启用策略和公开目录：三个实际模型加 `auto-responses`，价格版本均 `task-v1-r2-m22000`。没有发布 Chat 模型，因此生产不提供 `auto-chat`。客户端需要显式选择自动 ID；默认 Luna 和显式模型不会暗中变为自动路由，但已配置档案的实际模型同样按新快照计费。
- 激活后指标 `sampleCount=0,settledCount=0,unknownCostCount=0`。没有创建生产测试用户、补充测试积分或发起测试推理；不能将零样本写成利润达标。所有本次临时管理员会话均已退出撤销。
- 采购表是用户提供的估算，按上游公开 USD 展示采用 USD/百万 tokens；没有核实账户分组折扣或供应商账单，也未做人民币汇率换算。积分换钱仅为估值，不包含收款、现金兑付或支付履约。

代码、策略和模型目录是三个独立版本；CLI capabilities 是启动配置快照，不能用其旧 `ai=false` 否定热保存的真实模型能力。客户端与运营者以实时 API 为准。回滚需先停服并评估迁移/账本兼容；完整恢复会丢失备份之后的新增记录，不能在线覆盖数据库。


## 运维

```sh
ssh root@192.168.66.193 'systemctl status hezuo-gateway --no-pager'
ssh root@192.168.66.193 'journalctl -u hezuo-gateway -n 100 --no-pager'
ssh root@192.168.66.193 'systemctl restart hezuo-gateway'
```

账号注册后，通过现有 `operator --operator-email <已注册邮箱>` 命令显式指定管理员，再重启服务。授权命令应以 `hezuo-gateway` 用户运行以保持配置文件所有权；不会自动给账号开通 AI 或增加积分。

手机需填写上述网关地址并导入/粘贴该证书；桌面包需绑定新地址和 CA。当前桌面安装不会自动切换到新服务器。浏览器不信任自签证书时，不应关闭 TLS 校验；使用可信域名证书或显式信任此证书。

## 初次管理后台验证（历史记录）

- systemd：active (running)，enabled。
- 网关 status：running=true、healthy=true；14 项迁移已应用，0 项待应用。
- 从开发机使用 curl `--cacert` 校验证书并跨机器访问：`/healthz` 200；`/v1/auth/methods` 200；部署后 `/admin` 200。
- `tsc --noEmit -p gateway/control-plane/tsconfig.json` 通过。
- `vitest run test/admin.test.ts test/account-ai.test.ts`：2 个文件、21 项测试通过，涵盖运营者权限和现有账本管理行为。
- 独立临时数据库 + 真实网关 CLI + 假上游 fixture 已成功启动；此前直接程序调用的隔离检查曾超时，不作为通过证据。
- 浏览器在 fixture 中实际验证：普通账号拒绝、运营者登录、精确邮箱查询、增加 1.000001 积分、停用/启用 AI、拒绝超出 0.204 积分预占的结算、按 0.1 积分成功结算、系统状态、退出。最终可用 5.900001 积分，预占 0。
- 桌面宽度 1440px、窄屏 390px 已观察真实页面；窄屏无整页横向溢出，localStorage/sessionStorage 均为空，浏览器无页面错误。仅本机一次性 fixture 浏览器放行自签证书；生产跨机器检查使用 CA 校验。
- 生产环境只执行用户授权的管理员注册与授权，没有注入测试积分或推理请求。手机/桌面中继和真实模型推理未验证。

实现包含账号查询、权限启停、增加积分、请求记录/详情/人工结算、渠道模型管理、系统状态和智能计费。接口契约见 [gateway-admin-api.md](gateway-admin-api.md) 与 [gateway-channels.md](gateway-channels.md)。全局用户列表、设备管理不在此版界面内。

后台方案见 [gateway-admin-design.md](gateway-admin-design.md)。目前不存在可登录的管理网页，设计方案不是已实现后台。

## 2026-11-14 密码登录不限次数

按要求将 Better Auth 的 `rateLimit.customRules["/sign-in/email"]` 设为
`false`，明确跳过该接口的默认及专属限流；注册、验证码、重置密码和 AI
限流保持原样。密码登录不再受这层防暴力猜测保护，部署对公网开放前需重新评估风险。

改动已同步桌面工作树、`HezuoBot-gw-beta` 工作树及 193 部署源码。
隔离 Worker 的 `pnpm exec vitest run test/password-auth.test.ts` 共 13 项通过：
同一 IP 连续 12 次密码登录均为 200，注册第 6 次仍为 429。
部署后重启 `hezuo-gateway.service`，服务 active，证书校验下 `/healthz` 返回 200。
未用真实用户账号执行批量登录测试；桌面 App 无需更新。

## 渠道管理发布验证

- 类型检查与 admin/account-ai/channel-management/ai-gateway 四文件共 70 项测试通过，覆盖双渠道 Chat/Responses 路由、精确扣费、并发版本冲突、密钥隔离、停用与错误不重试。
- 真实 Worker 首次发现模型失败：workerd 不支持 `redirect: error`。改为 `manual` 后仍拒绝所有非 2xx；没有放宽重定向或证书校验。修复后 `node scripts/verify-gateway-admin.mjs --smoke` 通过渠道发布、发现、推理、重启和加密凭据持久化检查。
- 浏览器实际新增渠道并保存版本 2，发现 2 个模型，填写三个价格与 token 限额后发布版本 3。使用网页发布模型完成实际隔离推理；网页停用渠道保存版本 4 后，该模型请求 403。1440px 和 390px 页面已观察，窄屏无整页横向溢出，浏览器存储为空、无页面错误。
- 生产通过 CA 校验登录已有管理员，`/admin`、脚本、`/v1/operator/me`、`/v1/operator/channels` 均 200，检查后撤销临时登录会话。生产渠道目录仍为空（revision 0），没有复制测试上游或真实个人 key，也未改变用户积分。
- 停服后完整备份数据与旧代码到 `/opt/hezuo-gateway/backups/pre-channels-64b453286-data.tgz` 和 `pre-channels-64b453286-code.tgz`，文件由 root 私有保存。回滚必须协调停服与完整恢复，不可只恢复部分账本或覆盖运行中的数据库。
