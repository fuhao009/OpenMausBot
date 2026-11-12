# 网关管理网页接口契约

## 边界

管理网页由网关同源 `/admin` 提供，管理账号 AI 权限、积分、请求结算和渠道模型配置，不访问桌面对话和文件。桌面端和手机端无需修改。静态登录页面公开；每个运营者 API 都由服务端验证权限。

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

所有金额内部为安全整数微积分，1 积分 = 1,000,000 微积分。增加积分不是覆盖余额；未知结果重试必须保留原操作 ID 和原始请求。结算不允许超出预占或重复结算。

## 渠道与模型

`GET/POST /v1/operator/channels` 提供版本化目录，`POST /v1/operator/channels/:id/probe` 查询上游模型。完整字段、密钥保留规则、409 冲突和旧配置切换约定见 [渠道接口契约](gateway-channels.md#api)。公共账号模型 API 保持原格式，不向客户端暴露渠道地址或凭据。


## Git 联调约定

每个开发者使用独立 clone/worktree。后端变更在 `backend/gateway-deploy-admin-193`，客户端不需要合并网关实现，只需按契约联调。部署记录必须注明实际部署提交与验证范围；设计和未部署提交不代表在线能力。问题记录包括客户端提交、后端部署提交、脱敏请求/响应、时间和 request ID，不能提交密码、令牌、上游 key。
