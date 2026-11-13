# 网关管理网页接口契约

## 边界

管理网页由网关同源 `/admin` 提供，管理账号 AI 权限、积分、请求结算、渠道模型和任务计费策略，不访问桌面对话和文件。桌面端和手机端无需修改既有调用；自动路由、报价和预算上限按客户端契约接入。静态登录页面公开；每个运营者 API 都由服务端验证权限。

## GET /v1/operator/me

请求头 `Authorization: Bearer <账号会话令牌>`。模型凭据和安装凭据不能替代账号会话。

- 401：未登录或会话失效。
- 403：已登录但不在运营者配置中。
- 200：当前运营者和脱敏能力信息。

```json
{
  "user": { "id": "operator-account-id", "email": "operator@example.com", "name": "Operator" },
  "capabilities": {
    "ai": false,
    "password": true,
    "emailCode": false,
    "emailVerification": "off"
  },
  "models": []
}
```

`ai` 表示模型、默认模型和上游凭据配置满足转发条件，不证明上游网络可达或推理成功。`models` 为启用模型的公开目录，包含公开模型 ID、名称、协议、价格版本、输入/缓存输入/输出微积分单价和 token 限额；不包含上游密钥或内部上游模型名。响应不返回其他运营者 ID 或服务器配置。

## 现有管理接口

| 方法 | 路径 | 行为 |
| --- | --- | --- |
| GET | `/v1/operator/ai/account?email=…` | 精确邮箱查询；按部署邮箱验证策略返回账户 |
| POST | `/v1/operator/ai/account` | `{operationId,userId,enabled,reason}`，启停 AI |
| POST | `/v1/operator/ai/balance` | `{operationId,userId,amountMicroPoints,reason}`，增加积分 |
| GET | `/v1/operator/ai/requests?userId=…&cursor=…` | 当前账号请求与游标分页 |
| POST | `/v1/operator/ai/requests/:id/settle` | `{operationId,chargedMicroPoints,reason}`，人工结算 |
| GET | `/v1/operator/ai/requests?state=review&cursor=…` | 所有账号待复核请求，创建时间倒序；每条新增 `email` |
| POST | `/v1/operator/accounts/:userId/disable` | `{operationId,reason}`，停用整个账号并撤销会话和模型令牌 |
| POST | `/v1/operator/accounts/:userId/delete` | `{operationId,reason}`，保留匿名账本；有预占或待复核时 409 |
| POST | `/v1/operator/accounts/:userId/reset-password` | `{operationId,reason}`，撤销会话并返回一次性 `temporaryPassword` |

所有金额内部为安全整数微积分，1 积分 = 1,000,000 微积分。增加积分不是覆盖余额；未知结果重试必须保留原操作 ID 和原始请求。普通复核结算不允许超出预占；`usage_exceeds_reservation` 复核已收取费用且不再冻结余额，人工结算不得超过已收取的 `chargedMicroPoints`，差额退款。重复使用同一操作 ID 返回已有结果，不重复记账。待复核页批量零结算逐笔调用单笔接口，每笔独立 UUID 与审计；允许部分成功，重试保留各笔原 ID。

账号生命周期操作响应含 `operationId,userId,kind,replayed`。重置密码的明文只在首次成功响应出现，幂等重放不会再次返回；丢失响应时先以同 ID 确认，再明确发起新的重置。审计不包含密码明文。删除不可恢复，历史流水不物理删除，原邮箱替换为匿名标识。

临时密码登录响应含 `requiresPasswordChange: true`；受限会话不能访问普通账号和模型功能。客户端以账号 Bearer 调用 `POST /v1/account/change-password`，提交 `{currentPassword,newPassword}`，新密码遵守注册规则（10–128 字符）且不得与临时密码相同。成功 `{changed:true,requiresSignIn:true}`，所有会话撤销，使用新密码重新登录。

## 渠道与模型

`GET/POST /v1/operator/channels` 提供版本化目录，`POST /v1/operator/channels/:id/probe` 查询上游模型。完整字段、密钥保留规则、409 冲突和旧配置切换约定见 [渠道接口契约](gateway-channels.md#api)。公共账号模型 API 保持原格式，不向客户端暴露渠道地址或凭据。

## 智能计费

| 方法 | 路径 | 行为 |
| --- | --- | --- |
| GET | `/v1/operator/billing` | 返回 `{revision,policy,controller}`；没有保存记录时 revision 为 0、功能关闭 |
| POST | `/v1/operator/billing` | 提交完整 `{revision,reason,policy}`；保存策略并记录审计 |
| GET | `/v1/operator/billing/metrics` | 请求结算指标、当前控制器、分模型统计、最近请求、只读采购费率 |

均使用运营者账号会话，不接受模型令牌。保存请求最大 64 KiB；`reason` 必填、最多 500 字符、不含控制字符。保存使用 revision 比较交换；冲突返回 409 `billing_revision_conflict`，重新读取并人工合并，不能无条件覆盖。非法策略返回 400 `invalid_billing_policy`，不可安全表示的价格返回 400 `billing_price_limit`。修改仅作用于后续请求；在途请求仍按准入时的不可变快照结算。

### 策略字段

比例单位为基点：10000 = 100% 或 1 倍。

| 字段 | 初始值 | 含义 / 范围 |
| --- | --- | --- |
| `enabled` | false | 显式开启；不自动变更生产价格 |
| `currency` | USD | 采购成本估值币种，仅支持 USD |
| `pointsPerCurrency` | 1000 | 每 USD 对应积分；整数 1–1000000，仅估值，不是兑换或支付接口 |
| `targetMarginBps` | 5000 | 目标估算毛利率，0–9500 |
| `overheadBps` | 1000 | 运营风险附加比例，0–10000 |
| `minMultiplierBps` / `maxMultiplierBps` | 10000 / 50000 | 倍率边界，各 10000–1000000；必须夹住成本定价下限 |
| `maxStepBps` | 1000 | 单次最大调整幅度，1–10000 |
| `minSamples` | 20 | 最少终态样本数，1–1000 |
| `cooldownSeconds` | 60 | 两次控制器调整间隔，1–86400 秒 |
| `windowMinutes` | 60 | 观察窗口，1–10080 分钟 |
| `profiles` | [] | 最多 50 项，公开模型 ID 不重复；每项 `{modelId,capacity,tools,vision}` |

`capacity` 为 `simple|standard|complex`，表示运营者声明的能力档位，不是自动测评结果。`tools` / `vision` 为布尔值。档案只参与已发布、启用、协议匹配且采购费率已知的模型；不会创建渠道或赋予上游原本没有的能力。自动路由选满足任务档位、工具/图片需求和上下文容量的估算低价模型；指定模型仍尊重其 ID。未列入档案或没有采购价的指定模型继续使用原积分费率。

成本定价下限为 `(1 + overheadBps/10000) / (1 - targetMarginBps/10000)`，向上取整到基点；初始策略为 2.2 倍。控制器在请求结算及定时维护时运行：达到样本数、冷却期，并有上次调整之后的新终态数据才调整。待复核/未知成本占比超过 10%，或足够已知成本样本的估算毛利低于目标时，最多上调一步；否则最多下调一步回到定价下限。上限、冷却和比较交换约束仍生效。每次策略或倍率变化均写入 `ai_billing_policy_audit`，无新数据不反复涨价。目标不保证实现；这些指标不是供应商账单利润，也不是净利润。

### 成本和观测口径

- 采购价来源为运营者提供的估算表，`source: operator_supplied_estimate`，单位 USD / 百万 tokens。API 中 `rates` / `longRates` 是每百万 tokens 的整数微 USD，1 USD = 1000000 微 USD。界面只读，不抓取供应商账单，不推断汇率。
- 输入总数包含互斥的普通输入、缓存读取、缓存写入、一小时缓存写入，不能重复累加。未提供费率返回 null，不等于免费。已报告正数缓存写入却没有费率、分区总量超过输入、usage 超出锁定边界等均不能自动结算，保留待复核。
- 缓存用量细项缺失时，允许按已知输入类最高价作保守估算并标记 `conservative`；完整可信细项为 `estimated`。两者都不是已确认账单成本。拒绝释放或人工结算只能确定用户积分，采购成本仍为 `unknown` / null。
- 长上下文阈值、服务档位、北京时间工作日时段按采购表处理并锁进每次请求快照；不随结束时间或后续政策改变。带 `-ultrafast` 的独立模型费率已包含倍率，不再重复乘 6。
- 统计只含窗口内带任务计费快照的最近 1000 条请求；旧固定费率请求不混入。`recent` 最多 50 条。普通客户端流水不包含采购成本或运营毛利。
- 指标返回 `sampleCount,settledCount,reviewCount,unknownCostCount` 和 `models` 分组。`chargedMicroPoints,estimatedRevenueMicroCurrency,estimatedCostMicroCurrency,estimatedProfitMicroCurrency,estimatedMarginBps` 只统计已结算且成本已知的样本；收入按各请求锁定的积分/USD 换算，未知成本不填零、不计入毛利。
- `controller` 返回 `multiplierBps,lastAdjustedAt,reason`；指标平铺为 `multiplierBps,lastAdjustedAt,adjustmentReason`。最近请求含公开实际模型、复杂度、扣费、成本证据状态和耗时，不含 prompt、上游密钥或完整请求体。

后台“智能计费”页提供策略编辑、模型档案、指标刷新、最近请求和只读费率。指标每 15 秒自动刷新；隐藏标签页、切换导航、退出或会话过期时暂停，避免请求重叠和过期响应覆盖。复杂度只影响选模，不另收复杂度费。客户端报价与预算协议见 [客户端任务计费](gateway-client-api.md#任务计费报价与预算)。



## Git 联调约定

每个开发者使用独立 clone/worktree。任务计费交付分支为 `backend/task-aware-billing`，基于 `backend/gateway-v1-lan`；客户端不需要合并网关实现，只需按契约联调。部署记录必须注明实际部署提交与验证范围；设计和未部署提交不代表在线能力。问题记录包括客户端提交、后端部署提交、脱敏请求/响应、时间和 request ID，不能提交密码、令牌、上游 key。
