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

- 地址：`https://192.168.66.193:18487`，仅绑定该内网地址。
- 服务：`hezuo-gateway.service`，已启用开机启动，运行账号 `hezuo-gateway`。
- 源码：`/opt/hezuo-gateway/app`。
- 独立 Node 24.16.0：`/opt/hezuo-gateway/runtime/node_modules/node/bin/node`；未替换系统 Node。
- 数据和配置：`/var/lib/hezuo-gateway/`、`/var/lib/hezuo-gateway/gateway.json`。
- 证书：`/var/lib/hezuo-gateway/tls/gateway-cert.pem`；私钥只留服务器。
- 本机证书副本：`.omb-scratch/remote-gateway-193/gateway-cert.pem`。

初次部署时为全新环境，未迁移原电脑数据库、账户或上游凭据；当时仅开启密码登录，未配置邮件、上游模型、价格或运营者。模型配置现状以上方实机核对为准。没有修改现有 nginx 或其他服务。

## 运维

```sh
ssh root@192.168.66.193 'systemctl status hezuo-gateway --no-pager'
ssh root@192.168.66.193 'journalctl -u hezuo-gateway -n 100 --no-pager'
ssh root@192.168.66.193 'systemctl restart hezuo-gateway'
```

账号注册后，通过现有 `operator --operator-email <已注册邮箱>` 命令显式指定管理员，再重启服务。授权命令应以 `hezuo-gateway` 用户运行以保持配置文件所有权；不会自动给账号开通 AI 或增加积分。

手机需填写上述网关地址并导入/粘贴该证书；桌面包需绑定新地址和 CA。当前桌面安装不会自动切换到新服务器。浏览器不信任自签证书时，不应关闭 TLS 校验；使用可信域名证书或显式信任此证书。

## 已观察到的验证结果

- systemd：active (running)，enabled。
- 网关 status：running=true、healthy=true；13 项迁移已应用，0 项待应用。
- 从开发机使用 curl `--cacert` 校验证书并跨机器访问：`/healthz` 200；`/v1/auth/methods` 200；`/admin` 404。

隔离验证补充：开发机真实 Worker fixture 在 300 秒内未完成；远端临时数据目录的独立网关检查在 120 秒内未完成。两次均超时，不能视为通过。生产地址的只读 HTTPS 检查结果不替代隔离业务验证，注册、权限、积分和中继联调仍未验证。
- 未对部署后的真实数据库执行测试注册、积分修改或推理请求；以上不证明手机/桌面中继完整链路或上游推理可用。

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
