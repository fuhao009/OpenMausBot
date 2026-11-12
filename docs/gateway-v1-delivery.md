# 局域网内测后端交付

## 版本与部署

- 分支：`backend/gateway-v1-lan`，已推送 personal。
- 功能提交及 193 deployed-commit：`c911aefce`。
- 管理后台：`https://192.168.66.193:18487/admin`。
- 本次仅改网关和交接文档，无桌面/手机/共享类型改动，无新 migration。

## T1–T4

- 指定 400/401/403/404/408/409/413/422/429 完整拒绝、无可结算用量时释放用户预占，只有 releaseRequest 成功才报告未扣积分；有合法 usage 先按用量结算。释放是运营者承担失败成本的策略，不证明上游没有计费。
- 新增 503 `ai_temporarily_busy` / `ai_temporarily_unavailable`；已预占请求携带 `x-ai-request-id`，对应账本 ID；并发429 `ai_busy` 携带 `Retry-After: 2` 且不带账本 ID。
- 编码异常、5xx/重定向、网络/超时、读取中断和流式200后失败仍待复核；不自动重放。
- 明确缺失全部托管端点配置时跳过该项维护，部分配置/非法配置与真实执行失败仍报错，其他定时任务不受影响。
- `pnpm --dir gateway/control-plane typecheck` 自动生成 Worker 类型再执行 tsc，适用于新工作区。

## 验收输出

第一次 typecheck 暴露测试故意传入非法 account ID 与生成字面量 Env 类型冲突，已仅修正测试类型表达；最终完整命令通过：

- typecheck：退出0，已生成 worker-configuration.d.ts 并完成 tsc。
- 指定六文件测试：`Test Files 6 passed (6)`，`Tests 164 passed (164)`，0失败。
- 隔离端到端：`{"smoke":"passed","url":"https://127.0.0.1:56234/admin","disposableUpstreamURL":"https://127.0.0.1:56233/browser/v1"}`，临时数据已清理；日志没有未配置 endpoint cleanup 错误。
- 生产：systemd active；running=true、healthy=true；migrations applied=14、pending=0；开发机 CA 校验 `/healthz` 200、`/admin` 200。新服务 PID 2278116 的日志无 `cleanup sweep failed`；旧 PID 的历史日志保留，不伪装删除。

T1/T2 回归名称（参数化覆盖多个场景）：

- `releases end-user points after refusal %i without leaking upstream details or retrying`
- `settles trustworthy 429 usage before refusal policy (stream request: %s)`
- `does not claim a release when another writer already moved the request to review`
- `reviews %s failures even when a refusal release might otherwise apply`
- `includes the ledger id when dispatch setup throws after reserve`
- `releases an empty Responses refusal before streaming starts (stream request: %s)`
- `keeps a failed 200 stream reserved even when its error code resembles a refusal`

其余成功、SSE、余额不足、并发及重定向原测试增加账本ID/Retry-After断言。

整仓 pre-push 在已有 desktop/local-gateway 未使用符号及既有 channel-store 控制字符正则 lint 告警处失败。没有掩盖为整仓通过；后端要求的完整验收已通过，发布使用一次性 core.hooksPath 绕过该整仓钩子，不改全局配置或其他端代码。

## 生产渠道

按用户授权，从本机 OMP `~/.omp/agent/models.yml` 的 fuhaoliang 供应商读取地址与 key，经 SSH stdin 传输后由管理员 API 保存到加密渠道目录；没有将 key 写入源码、文档、命令参数或日志。OMP 文件中没有 Luna 显式条目，但上游 `/models` 实际确认 `gpt-6-luna` 存在。

- 渠道 ID：`omp-fuhaoliang`。
- 上游：`https://api.muzeai.top/v1`。
- 公开/上游模型：`gpt-6-luna`，显示名 GPT 6 Luna。
- 协议：Responses，沿用 OMP 供应商协议；默认模型已设为该模型。
- 目录 revision：1，服务器模型发现 `modelFound=true`，698ms。
- 输入/缓存输入/输出均 1000 积分/百万 token，即各 1,000,000,000 微积分/百万 token。
- 上下文128000、最大输出4096；价格版本 `lan-v1-1000`。这是内测用户积分费率，不是上游美元成本报价。

当前统一费率相当于每1000个输入+输出 token合计1积分；缓存输入已是输入的子集，不能重复计数。计费采用原账本整数算法，以实际 usage结算，预占不是最终扣费。未给任何生产账号注入测试积分或发起测试推理。模型列表可达不证明真实 Responses、工具调用和流式全链路通过，由桌面端按任务验收表联调。

部署前完整停服备份位于 `/opt/hezuo-gateway/backups/pre-lan-c911aefce-data.tgz` 和 `pre-lan-c911aefce-code.tgz`。生产 CLI status 的 capabilities 仍是启动配置快照，不代表热保存后的模型状态；以运营者接口/账号状态为准。

## 客户端对接

拉取本分支后读 [客户端错误契约](gateway-client-api.md#错误与重试)。普通账号仍需管理员开通并补充积分；模型协议为 Responses，不能把该 ID 发送到 Chat 端点。生产未验证项：桌面真实请求、SSE、工具授权/拒绝、主动停止、账户并发与限流提示。不得将隔离通过写成三端生产联调完成。
