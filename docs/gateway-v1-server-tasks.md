# 网关第一版（局域网内测）服务端开发任务

面向接手的服务端开发者。目标：桌面端通过 `https://192.168.66.193:18487` 与网关全链路可用，内测达到商用级的计费正确性和用户体验。完成后按“交付”一节交回，由桌面端负责人联调。

## 范围与原则

- 最小可用。只做本文列出的任务，不做冗余功能。
- 上游只有 OpenAI 兼容的中转站（Chat Completions / Responses），由运营者在 `/admin` 自行配置。不做订阅账号、多 key 轮换、自定义请求头、代理、协议转换。
- 不做依赖外部服务的功能：邮件、Cloudflare 托管端点、APNS、HighLevel、域名与公网证书、外部告警。
- 不做备份、部署脚本、后台用户列表 / 设备 / 审计查询、系统状态扩展。
- 计费原则不变：可能已到达上游的请求不自动重放；用量缺失进入 `review`，不自动退款。本文只放开一种可证明的情况（T1）。

## 代码与分支

- 基线：`personal/backend/gateway-deploy-admin-193`，当前提交 `f2521a4be`，已部署实现 `64b453286`。
- 新建独立 worktree，不要在他人目录切分支：

  ```sh
  git fetch personal backend/gateway-deploy-admin-193
  git worktree add ../HezuoBot-gw-v1 -b backend/gateway-v1-lan personal/backend/gateway-deploy-admin-193
  ```

- 只改 `gateway/`、`docs/gateway-*.md`。不改 `desktop/`、`mobile/`、`packages/shared/`（如确需改共享类型，先和桌面端负责人确认）。
- 遵守仓库根目录 `AGENTS.md` 的注释规则；新 migration 递增，不改历史 migration（本文任务预计不需要 migration）。
- 必读：`docs/backend-development.md`、`docs/gateway-client-api.md`、`docs/gateway-channels.md`。

环境：

```sh
export PATH="$HOME/.local/nodejs/node-v24.16.0-darwin-arm64/bin:$PATH"
pnpm install --frozen-lockfile
pnpm --dir gateway/control-plane types   # 生成 worker-configuration.d.ts，否则 tsc 报 TS2688
```

本机有 `127.0.0.1:7890` 代理；跑回环 fixture 前取消所有代理变量（`HTTP_PROXY HTTPS_PROXY ALL_PROXY` 及小写）。

## 任务

### T1 中转站明确拒绝时释放预占

现状：`gateway/control-plane/src/ai-gateway.ts` `dispatch` 中，上游非 2xx 且响应体没有可信 usage 时一律 `markReview(..., "upstream_status_<status>")`，积分冻结等待人工结算。中转站限流（429）、key 失效（401/403）、模型不存在（404）、参数错误（400）在内测中很常见，会大量冻结用户积分。

要求：

- 上游 HTTP 状态为 `400, 401, 403, 404, 408, 409, 413, 422, 429`，且 `failureUsage` 没有返回可信 usage 时，调用已有的 `releaseRequest(env, requestId, "upstream_refused_<status>")`（`ai-wallet.ts`），预占全额释放，`charged_micro_points = 0`。
- 响应体带了可信 usage 的，仍按 usage 结算（现有行为不变）。
- `5xx`、其他状态、`content-encoding` 非 identity、重定向（3xx）、网络错误、超时、流中途失败：保持 `review`，不变。
- 释放只发生在拿到完整 HTTP 状态之后，流式响应 200 之后的任何错误都不属于本规则。
- 状态码集合写成一个命名常量，例如 `UPSTREAM_REFUSAL_STATUSES`，不要散落在条件里。
- 返回给客户端的错误见 T2。

验收：

- `test/ai-gateway.test.ts` 新增用例：对上述每个状态（至少 400、401、404、429）断言请求行 `state = settled`、`charged_micro_points = 0`、`settlement_reason = upstream_refused_<status>`，余额 `available` 恢复、`reserved = 0`。
- 新增用例：500、502、503 和重定向仍为 `review`，余额 `reserved` 不变。
- 新增用例：429 响应体带合法 usage 时按 usage 结算，不释放。
- 现有用例 `refuses a redirect and keeps the reservation for review`、`settles usage an error response still reported…` 仍通过。

### T2 推理错误返回客户端可分辨的稳定错误码

桌面端要根据错误码给用户不同的提示（见“客户端提示对照”），并如实告诉用户是否扣了积分。现在上游非 2xx 一律返回 `502 upstream_error`，客户端分不清“没扣费”和“正在核对”。

要求（推理错误包络 `{error:{code,type,message}}` 不变，只新增 code）：

| 情况 | HTTP | `error.code` | 积分 |
| --- | --- | --- | --- |
| T1 释放，上游 429 | 503 | `ai_temporarily_busy` | 已释放 |
| T1 释放，上游其余拒绝状态 | 503 | `ai_temporarily_unavailable` | 已释放 |
| 进入 `review` 的上游失败（非流式） | 502 | `upstream_error`（不变） | 冻结待核对 |
| 流式 200 后进入 `review`（`event: error`） | — | `upstream_error`，或上游自带的合法 code（现有行为） | 冻结待核对 |
| 账号并发已满 | 429 | `ai_busy`（不变） | 未预占 |

- 新 code 的 `message` 用中性英文，不含上游名、URL、上游原文或 key，例如 `The AI service is busy. No points were charged.` / `The AI service is temporarily unavailable. No points were charged.`。
- `x-request-id` 已由 `index.ts` → `http.ts` `secureResponse` 给所有 `/v1/ai/*` 响应设置，但它是每次 HTTP 请求新生成的 UUID（`index.ts` 约 253 行），不是账本请求行的 `id`（`reserve` 生成）。新增响应头 `x-ai-request-id`，值为账本请求 `id`：凡是已经 `reserve` 的请求（成功、T1 释放、review、SSE）都要带；预占之前就失败的请求（401、402、403、429 `ai_busy`、400、413、503 `ai_unavailable`）不带。运营者凭这个值在 `/admin` 找到对应请求。
- `ai_busy`（账号并发满，429）响应加 `Retry-After: 2`，写成命名常量。
- 更新 `docs/gateway-client-api.md` 的“错误与重试”表：新增两个 code，注明“积分已释放，可以重新发送”；注明 `x-ai-request-id` 的含义；注明 `ai_busy` 带 `Retry-After`。

验收：

- `test/ai-gateway.test.ts`：T1 的每个释放用例断言状态码 503 和对应 code；review 用例断言仍为 502 `upstream_error`；成功、释放、review、流式用例断言 `x-ai-request-id` 等于请求行 `id`；402、`ai_busy` 用例断言没有 `x-ai-request-id`；`ai_busy` 用例断言 `retry-after: 2`。
- 断言所有新 message 不包含上游返回体里的任何文本（沿用现有 `never leaks the upstream body` 的写法）。

### T3 未配置的定时任务不再每分钟报错

现状：`gateway/control-plane/src/index.ts` `scheduled` 中，没有配置 Cloudflare 托管端点时 `readConfig(env)` 失败，每分钟输出一次 `managed endpoint cleanup sweep failed … misconfigured`。193 的 journal 全是这一行，真实错误会被淹没。

要求：

- 托管端点未配置（`readConfig` 因缺少托管端点配置而失败）时，跳过托管端点的 scan 和 sweep，不输出错误日志。
- 配置存在但执行失败时，保持现有错误日志。
- 其他 sweep（验证码、HighLevel、预占恢复）不受影响。
- 区分“未配置”和“配置错误”要基于明确的配置字段判断，不要用吞掉所有异常的方式实现。

验收：

- 新增或更新测试：未配置托管端点时调用 `scheduled`，`console.error` 不包含 `managed endpoint`；配置存在且 sweep 抛错时仍输出错误。
- `node scripts/verify-gateway-admin.mjs --smoke` 的日志中不再出现 `cleanup sweep failed … misconfigured`。

### T4 检查命令可直接运行

- `gateway/control-plane/package.json` 增加 `typecheck` 脚本：先 `types` 再 `tsc --noEmit -p tsconfig.json`；或在 `docs/backend-development.md` “检查命令”中写明先执行 `pnpm --dir gateway/control-plane types`。二选一，选前者更好。

验收：在全新 worktree 中按文档命令执行，类型检查一次通过，无需手动生成文件。

## 不需要改的

- 鉴权在扣费之前：`ai-gateway.ts` `authenticateModelToken` 先于 `reserve`，401 `ai_token_invalid` 不计费，保持不变。
- 流式 usage：网关已强制 `stream_options.include_usage`，保持不变。
- `accept-encoding: identity`、拒绝重定向、HTTPS only：保持不变。

## 检查命令（全部必须通过）

```sh
pnpm --dir gateway/control-plane typecheck        # T4 完成后；否则 types + tsc
pnpm --dir gateway/control-plane exec vitest run \
  test/ai-gateway.test.ts test/ai-wallet.test.ts test/account-ai.test.ts \
  test/admin.test.ts test/channel-management.test.ts test/control-plane.test.ts
env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u http_proxy -u https_proxy -u all_proxy \
  node scripts/verify-gateway-admin.mjs --smoke
```

## 部署到 193

完成并自测后才部署，部署前告知桌面端负责人和运营者。

1. 提交并推送 `backend/gateway-v1-lan` 到 `personal`，记录 SHA。
2. 按 `docs/backend-development.md` “生产部署维护”：停 `hezuo-gateway`，备份 `/var/lib/hezuo-gateway` 和 `/opt/hezuo-gateway/app` 到 `/opt/hezuo-gateway/backups/`（root 0600），同步源码（不同步 `node_modules`、数据、凭据），启动。
3. 检查：`systemctl is-active hezuo-gateway` 为 active；status 中 migrations pending = 0；从开发机 `curl --cacert <193 证书> https://192.168.66.193:18487/healthz` 返回 200；`/admin` 返回 200；`journalctl -u hezuo-gateway -n 50` 无 `cleanup sweep failed`。
4. 更新 `/opt/hezuo-gateway/deployed-commit` 和 `docs/gateway-deployment-193.md`。
5. 不向生产注入测试积分、测试上游或测试账号。生产验证由桌面端负责人联调时完成。

## 交付

交回时提供：

- 分支名和提交 SHA；193 上 `/opt/hezuo-gateway/deployed-commit` 的值。
- 上面“检查命令”三条的完整输出摘要（通过数、失败数）。
- `--smoke` 输出的 `{"smoke":"passed",…}` 一行。
- T1/T2 新增测试用例名称列表。
- 部署检查第 3 步的实际输出。
- 已知未完成项（如有），不要写成已完成。

## 联调验收（桌面端负责人执行，服务端配合）

前置：运营者已在 193 `/admin` 配置至少一个中转站渠道、Chat 和/或 Responses 模型、价格与默认模型。桌面端在 193 创建测试账号 A（开通、少量积分）和 B（开通、零积分）。

| # | 场景 | 期望 |
| --- | --- | --- |
| 1 | 登录、退出 | 成功，退出后旧模型令牌不可用 |
| 2 | A 发送 Chat 非流式 / 流式各一条 | 成功；账本 `settled`，扣费 = 用量 × 价格；不进入 `review` |
| 3 | A 发送 Responses 非流式 / 流式各一条（如配置了） | 同上 |
| 4 | B 发送 | 402，桌面提示积分不足，无上游调用 |
| 5 | 运营者在后台把中转站 key 改成错误值后，A 发送 | 503 `ai_temporarily_unavailable`；账本 `settled`、扣费 0；余额无冻结；桌面提示“暂时不可用，本次没有扣除积分” |
| 6 | 中转站返回 429（可用低额度 key 或并发压测触发，能触发才测） | 503 `ai_temporarily_busy`；扣费 0 |
| 7 | A 发送后中途停止 | 账本 `review`；后台可按邮箱找到并人工结算；桌面提示“用量正在核对” |
| 8 | A 并发超过账号上限 | 429 `ai_busy` 带 `Retry-After`；桌面显示排队，不报错 |
| 9 | 工具调用授权 / 拒绝 | 与隔离验收一致 |
| 10 | 193 journal | 无 `cleanup sweep failed … misconfigured` 刷屏 |

## 客户端提示对照（桌面端实现，供服务端理解错误码用途）

主文案只说“服务”，不提中转站、上游或状态码；积分情况如实说明；详情折叠区显示请求编号。

| 错误码 | 用户看到 |
| --- | --- |
| `ai_busy`（等待中） | 对话内一行“正在排队，马上开始…”，自动等待 |
| `ai_busy`（等待超时）/ `ai_temporarily_busy` | 服务当前繁忙，请稍后再试。本次没有扣除积分。 |
| `ai_temporarily_unavailable` / `ai_unavailable` | AI 服务暂时不可用，请稍后再试。本次没有扣除积分。 |
| `upstream_error` / 流中断 | 这条回复没有完成，请重新发送。本次用量正在核对，核对完成前约 {n} 积分暂时冻结，可在账户页查看。 |
| `insufficient_balance` | 积分不足，暂时无法发送。当前可用 {n} 积分，请联系管理员充值。 |
| `ai_not_enabled` / `ai_suspended` | 你的账户还没有开通 AI 功能，请联系管理员。 |
| `ai_token_invalid` | 自动续签并重试一次；失败则“登录已过期，请重新登录。” |
