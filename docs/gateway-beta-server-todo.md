# 网关内测服务端待办

面向服务端开发者。基线：`personal/backend/task-aware-billing` `8594436cb`，193 已部署 `89e3991c6`。这些问题来自桌面端在 193 上联调时的实测。范围、分支和部署规则沿用 [gateway-v1-server-tasks.md](gateway-v1-server-tasks.md)：只改 `gateway/` 和 `docs/gateway-*.md`；可能已经到达上游的请求不自动重放；部署前要先停服务并做完整备份。

优先级：S1、S2 是内测必须做的，S3–S7 可以在内测期间完成。

## S1 预占按请求实际大小算，不按模型上限算（必须）

现状：每条请求预占的是"模型剩余上下文 + 输出上限"的价格（`task-billing.ts` 约 159 行 `maxInputTokens = model.maxContextTokens - maxOutputTokens`；固定费率路径也一样）。193 上以 128000 上下文计算，Luna 每条冻结约 77 积分，Sol 约 794 积分，Astra 约 3829 积分，而实际扣费只有它的零头。用户余额够付实际费用，却不够预占，结果发不出消息。

要求：
- 纯文本请求的输入预占上限 = `min(maxContextTokens - maxOutputTokens, ceil(estimatedInputTokens × INPUT_RESERVE_FACTOR) + INPUT_RESERVE_MARGIN)`。两个值都写成命名常量，初始值 1.5 和 2048；带图片的请求保持现有做法（预占全部剩余上下文）。
- 固定费率模型和任务计费模型使用同一套规则。`/v1/ai/quote` 返回的 `reservedMicroPoints` 也按新规则计算。
- 实际用量超过预占时：先从可用余额补扣差额，并在同一个事务里完成；可用余额不足以补扣时，按预占额加全部可用余额扣费，再标记 `review`，`settlement_reason = usage_exceeds_reservation`。不能把用户余额扣成负数，也不能少记用量。

验收：
- 单元测试：纯文本请求的预占额按公式计算；带图片的请求保持原值；预占额不超过模型上限。
- 单元测试：实际用量高于预占且余额足够时，补扣后状态为 `settled`、`reserved = 0`；余额不足时状态为 `review`，`available` 不为负。
- 在 193 上用测试账号发一条约 3.5 万 token 的 Responses 请求（Luna），预占不超过 30 积分，结算后 `reserved = 0`。
- 现有的计费测试全部通过，`verify-gateway-admin.mjs --task-billing --smoke` 通过。

## S2 客户端断开后不再冻结积分；后台能集中处理待复核（必须）

现状：
- 流式请求中途客户端断开（退出登录、关闭 app、取消），走的是 `ai-gateway.ts` 约 664 行 `cancel()`，直接 `markReview(..., "client_disconnected")`；进程退出或上游一直不返回的请求，由定时清理改成 `stale_reservation`（`ai-wallet.ts` `recoverStaleRequests`）。
- 联调中每次重启或退出登录都会冻结 1–4 笔，每笔 132 积分（S1 之前的预占额），只能由管理员按邮箱逐笔手动结算。

要求：
1. 客户端断开后，网关不再中断上游连接，而是在后台继续读完上游流（不向客户端发送），拿到可信 usage 后按实际用量结算，`settlement_reason = client_disconnected_settled`。超过 `DISCONNECT_DRAIN_MS`（命名常量，初始 120000 ms）还没拿到 usage，或者上游出错，才标记 `review`（`client_disconnected`）。后台读取要用 `ctx.waitUntil` 之类的机制，保证进程不会提前结束。
2. 运营者接口 `GET /v1/operator/ai/requests?state=review` 允许不传 `userId`，返回所有账号的待复核请求，按 `created_at` 倒序，每条带账号邮箱，沿用现有的游标分页。
3. `/admin` 新增"待复核"页：列出上面接口的结果，可以逐笔按 0 或指定积分结算，也可以勾选多笔批量按 0 结算。批量结算的每一笔都要单独生成 `operationId` 并写审计，跟单笔结算一样。

验收：
- 测试：流式请求在 `response.completed` 之前取消，假上游后来返回完整 usage，请求状态为 `settled`，扣费等于用量乘以单价，`reserved = 0`。
- 测试：取消后假上游一直不结束，超过 `DISCONNECT_DRAIN_MS` 后状态为 `review`、`settlement_reason = client_disconnected`。
- 测试：不带 `userId` 的列表接口能返回两个不同账号的 `review` 请求；普通账号调用返回 403。
- 测试：批量结算 3 笔后，3 个账号的 `reserved` 都归 0，审计记录有 3 条；重复提交同一个 `operationId` 不会重复结算。
- 在 193 上：桌面端登录测试账号，新建 bot 后立刻退出登录，5 分钟内 `/admin` 的待复核页里没有这个账号的新记录，账号 `reserved = 0`。

## S3 在生产上验证任务计费

现状：193 上任务计费策略 revision 2 已经启用，但样本数为 0。真实上游返回的 usage、采购成本和毛利都没有核对过。

要求：先由运营者授权一个测试账号并加积分。用这个账号在 193 上对 Luna、Sol、Astra 和 `auto-responses` 各发至少 5 条请求，非流式和流式都要有；其中至少 2 条带工具定义，至少 1 条带图片。

验收：
- 所有请求的状态都是 `settled`，`cost_status` 不是 `unknown`，`reserved = 0`。
- 用 `auto-responses` 时，简单、标准、复杂三类请求分别选中 Luna、Sol、Astra。附上每条请求的 `x-ai-model` 和 `complexity`。
- 每条请求的用量要和中转站后台显示的用量对上，误差不超过 1%。附上对照表，包括请求 ID、网关用量、中转站用量、扣费积分、采购成本。
- `/v1/operator/billing/metrics` 的 `settledCount` 不少于 20。毛利只报告实测值，不能写成"达标"。

## S4 193 配置 Chat 模型

现状：193 只有 Responses 模型，Chat 接口和 `auto-chat` 都不可用。

要求：在 `/admin` 给中转站渠道发布至少一个 Chat Completions 模型，配好任务计费档案和采购价，并让 `auto-chat` 出现在模型目录里。

验收：
- `GET /v1/ai/models` 返回 Chat 模型和 `auto-chat`。
- 测试账号向 `/v1/ai/chat/completions` 发非流式、流式各 1 条，状态都是 `settled`。
- 再带工具发 1 条，返回的 `tool_calls` 格式正确。

## S5 修掉网关本地中继的 lint 警告

现状：`gateway/local/local-gateway/companion-relay.mjs` 约 48 行有一个没用到的函数，导致整个仓库的推送前检查一直不通过，每次推送都得用 `--no-verify`。

验收：`npx oxlint --deny-warnings gateway/local/local-gateway/companion-relay.mjs` 输出 0 个警告，并且网关本地中继的测试通过。

## S6 运营者可以停用和删除账号；清理测试账号

现状：193 上留着 `lan-test-a@hezuo.lan`、`lan-test-b@hezuo.lan`、`beta-a@hezuo.test`、`beta-b@hezuo.test` 四个测试账号，网关没有删除账号的接口。

要求：
- 运营者接口：可以停用账号（停用后不能登录，已有会话和模型令牌立即失效）。
- 运营者接口：可以删除账号，但只能删除 `reserved = 0` 且没有 `review` 请求的账号。删除时账本流水保留并做匿名处理，不能物理删除。
- 两个操作都要求填写原因和 `operationId`，并写审计。
- `/admin` 的账号卡片上提供这两个操作。

验收：
- 测试：停用后登录返回 401，旧模型令牌返回 401。
- 测试：有预占或有待复核请求的账号不能删除，返回 409。
- 测试：删除后账本条数不变，账本里查不到原邮箱。
- 在 193 上删除上面四个测试账号，`journalctl` 里没有错误。S3 用的测试账号测完后同样删除。

## S7 运营者重置密码（不依赖邮件）

现状：没有配置邮件，用户忘记密码后无法找回。按内测"不依赖外部服务"的原则，不接邮件服务。

要求：运营者接口和 `/admin` 提供"重置密码"：生成一个随机临时密码，只显示一次；该账号所有现有会话立即失效；用户下次登录后必须修改密码。临时密码长度和服务端注册规则一致。

验收：
- 测试：重置后旧密码和旧会话都失效，临时密码可以登录，登录后的响应要求修改密码，修改完成后临时密码失效。
- 审计记录里不包含临时密码明文。

## 检查命令

```sh
export PATH="$HOME/.local/nodejs/node-v24.16.0-darwin-arm64/bin:$PATH"
pnpm --dir gateway/control-plane typecheck
pnpm --dir gateway/control-plane exec vitest run \
  test/task-billing.test.ts test/task-billing-api.test.ts test/ai-wallet.test.ts \
  test/admin.test.ts test/channel-management.test.ts test/ai-gateway.test.ts \
  test/control-plane.test.ts test/account-ai.test.ts
env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u http_proxy -u https_proxy -u all_proxy \
  node scripts/verify-gateway-admin.mjs --task-billing --smoke
npx oxlint --deny-warnings gateway/local/local-gateway/companion-relay.mjs
```

## 交付

每一项单独提交，交回时提供：
- 分支名、每项的提交 SHA，以及 193 上 `/opt/hezuo-gateway/deployed-commit` 的值；
- 上面检查命令的通过数和失败数；
- S1、S2、S3 在 193 上的实测数据，包括请求 ID、预占、扣费、余额；
- 未完成的项要如实写明，不能写成已完成。

联调由桌面端负责人执行：桌面端会接 `auto-responses`、报价和 `billing.maxMicroPoints`，所以 S1 和 S2 完成后要先通知桌面端负责人。
