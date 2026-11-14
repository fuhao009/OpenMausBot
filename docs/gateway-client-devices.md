# 客户端设备、桌面中继与推送 API

本文面向桌面和原生手机客户端。账号登录及 AI 调用见 [客户端 API 总览](gateway-client-api.md)。以下契约按仓库实现编写；示例 UUID、时间和凭据均为占位值，不是可用账号或生产响应。

## 1. 部署与凭据边界

- **账号 bearer**：登录获得，用于列出、创建、轮换和撤销本人桌面安装，以及手机访问本人桌面。
- **安装凭据**：`omb_install_<lookup>.<secret>`，仅桌面/宿主持有，用于 `self`、托管端点、推送及桌面隧道握手。账号 bearer 与安装凭据不可互换。
- **原生手机不得为了连接而注册桌面安装**，也不得伪装为 `darwin`、`windows` 或 `linux`。手机持账号会话，选择同账号已注册的桌面即可。
- 本地 Node 网关提供 `/v1/companion/relay` 及 `/v1/companion/:installationId/*`。只有控制平面 Worker 的部署没有这两个数据平面入口，不能把 Worker 域名当作 Node 中继地址。托管 Cloudflare endpoint 是另一条部署路径，不是 Node 中继的前置条件。
- [当前远端部署](gateway-deployment-193.md)的网关地址为 `https://192.168.66.193:18487`。此本地 Node 部署**没有配置托管 Cloudflare Tunnel 或 APNs**，不要因接口存在就显示已开通：端点 `POST`/`DELETE` 缺配置返回 `503 endpoint_unavailable`；端点 `GET` 仍可查询数据库（未分配时为 `null`）；推送 `register`/`send` 缺配置返回 `503 push_unavailable`。`unregister` 实现不检查 APNs 配置，仍可删除本安装注册记录并返回 `204`。

### TLS 信任和调用准备

手机必须能路由到网关地址；手机上的 `127.0.0.1` 是手机本身。当前远端是内网地址，不表示公网可达。使用可验证的 HTTPS，或从可信运维渠道取得并显式信任网关 PEM 证书；不要关闭 TLS 校验。

当前部署的证书位于服务器 `/var/lib/hezuo-gateway/tls/gateway-cert.pem`；本机证书副本路径见部署文档。手机可在网关设置粘贴证书或安装该 CA。桌面绑定同一个网关 origin 和 CA；证书域名/IP 校验仍须成功。证书公钥可交付客户端，**私钥永不交付**。

下文 shell 示例假定已安全设置变量；不要把真实 bearer 写进文档、代码、截图、遥测、URL、shell 历史或共享日志：

```sh
GATEWAY='https://192.168.66.193:18487'
CA='/absolute/private-copy/gateway-cert.pem'
# ACCOUNT_TOKEN：通过登录流程取得；INSTALL_CREDENTIAL：桌面安全存储读取。
# INSTALLATION_ID：从创建或列表结果读取，不能使用 clientInstanceId 代替。
```

API 的时间字段是 Unix 毫秒数。控制平面响应为 `Cache-Control: no-store`；示例没有展示所有安全响应头。

## 2. 桌面安装管理

权威实现：[installations.ts](../gateway/control-plane/src/installations.ts)、[路由](../gateway/control-plane/src/index.ts)。路径精确匹配，示例不带尾随 `/`。

### 2.1 列表：`GET /v1/installations`

需要账号 bearer，无请求体。只返回当前账号未撤销的安装，按 `createdAt ASC, id ASC` 排序；无分页，最多 100 条（同时也是活跃安装上限）。列表不包含安装凭据或凭据到期时间。

```sh
curl --cacert "$CA" "$GATEWAY/v1/installations" \
  -H "Authorization: Bearer $ACCOUNT_TOKEN"
```

`200` 示例：

```json
{
  "installations": [{
    "id": "123e4567-e89b-42d3-a456-426614174000",
    "clientInstanceId": "desktop-7c0a",
    "name": "工作电脑",
    "platform": "darwin",
    "appVersion": "0.1.104",
    "createdAt": 1800000000000,
    "updatedAt": 1800000000000,
    "lastSeenAt": null
  }]
}
```

`appVersion` 未上报时为 `null`；从未使用安装凭据时 `lastSeenAt` 为 `null`。空列表为 `{"installations":[]}`，不是在线桌面清单；在线性由后续中继连接决定。

### 2.2 创建：`POST /v1/installations`

需要账号 bearer 和 `Content-Type: application/json`。严格对象，不接受额外字段：

| 字段 | 契约 |
| --- | --- |
| `clientInstanceId` | 必填、稳定的客户端实例标识；1–128 字符，正则 `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$` |
| `name` | 必填；trim 后 1–80 字符，不含字符码小于 32 或等于 127 的控制字符 |
| `platform` | 必填；仅 `darwin`、`windows`、`linux` |
| `appVersion` | 可选；trim 后 1–64 字符，同样禁止上述控制字符 |

```sh
curl --cacert "$CA" -X POST "$GATEWAY/v1/installations" \
  -H "Authorization: Bearer $ACCOUNT_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"clientInstanceId":"desktop-7c0a","name":"工作电脑","platform":"darwin","appVersion":"0.1.104"}'
```

`201` 示例（`credential` 为不可直接使用的说明性占位）：

```json
{
  "installation": {
    "id": "123e4567-e89b-42d3-a456-426614174000",
    "clientInstanceId": "desktop-7c0a",
    "name": "工作电脑",
    "platform": "darwin",
    "appVersion": "0.1.104",
    "createdAt": 1800000000000,
    "updatedAt": 1800000000000,
    "lastSeenAt": null
  },
  "credential": "omb_install_<22-char-base64url>.<43-char-base64url>",
  "credentialExpiresAt": 1807776000000
}
```

原始凭据只在创建或轮换时返回，立即存入操作系统安全凭据库。服务端只存 SHA-256 摘要。有效期 **90 天**，使用不会延长有效期。同一账号活跃安装的 `clientInstanceId` 必须唯一，重复创建为 `409 installation_exists`，不是幂等返回旧凭据；撤销后才可重新注册该稳定 ID。其他账号可独立使用相同 ID。活跃安装达到 100 为 `409 installation_limit_reached`；创建尝试每账号每小时最多 100，超限为 `429 rate_limited`。

### 2.3 自检：`GET /v1/installations/self`

只接受安装凭据，无请求体；记录凭据使用及安装 `lastSeenAt`，不续期。

```sh
curl --cacert "$CA" "$GATEWAY/v1/installations/self" \
  -H "Authorization: Bearer $INSTALL_CREDENTIAL"
```

`200` 示例：

```json
{
  "installation": {
    "id": "123e4567-e89b-42d3-a456-426614174000",
    "clientInstanceId": "desktop-7c0a",
    "name": "工作电脑",
    "platform": "darwin",
    "appVersion": "0.1.104",
    "createdAt": 1800000000000,
    "updatedAt": 1800000000000,
    "lastSeenAt": 1800000001000
  },
  "credentialExpiresAt": 1807776000000
}
```

无效、到期、已轮换或已撤销的凭据返回 `401 {"error":"unauthorized"}`。

### 2.4 轮换：`POST /v1/installations/:id/credentials/rotate`

需要**拥有该安装的账号 bearer**，不是旧安装凭据；无请求体。

```sh
curl --cacert "$CA" -X POST \
  "$GATEWAY/v1/installations/$INSTALLATION_ID/credentials/rotate" \
  -H "Authorization: Bearer $ACCOUNT_TOKEN"
```

`201` 示例：

```json
{
  "credential": "omb_install_<new-22-char-base64url>.<new-43-char-base64url>",
  "createdAt": 1800000060000,
  "credentialExpiresAt": 1807776060000
}
```

轮换原子撤销所有旧安装凭据，没有重叠有效期；安全保存新值并用新值重建隧道。不存在、非本人或已撤销安装为 `404 not_found`。一分钟轮换冷却超限为 `429 credential_rotation_rate_limited`；竞争冲突为 `409 credential_rotation_conflict`。响应丢失时不能从 GET 恢复原始凭据，不要无限自动重放轮换；通过账号恢复流程重新取得凭据并遵守冷却。

### 2.5 撤销：`DELETE /v1/installations/:id`

需要拥有者账号 bearer，无请求体：

```sh
curl --cacert "$CA" -X DELETE "$GATEWAY/v1/installations/$INSTALLATION_ID" \
  -H "Authorization: Bearer $ACCOUNT_TOKEN"
```

成功为 **`204` 空响应体**；本人已撤销安装重复调用仍为 `204`，未知/非本人安装为 `404 not_found`。先撤销安装和全部凭据、删除推送注册，再异步尽力清理托管端点；Cloudflare 清理失败不恢复凭据。重复 DELETE 可重新触发保留资源的清理。活跃列表不再返回已撤销项。

## 3. 桌面到网关的 WebSocket 隧道

权威实现：[Node 中继](../gateway/local/local-gateway/companion-relay.mjs)、[桌面连接器](../desktop/electron/gateway-companion-tunnel.mjs)、[帧协议编码器/解码器](../desktop/electron/companion-relay-frames.mjs)。这是专用二进制隧道，不是聊天 JSON WebSocket。

桌面向同一 HTTPS 网关发起 WSS 握手（`ws` 库也支持把 HTTPS URL 作为输入），在升级请求头发送安装凭据；不把凭据放 query、子协议或首条业务消息，无额外 hello 消息：

```http
GET /v1/companion/relay HTTP/1.1
Host: 192.168.66.193:18487
Authorization: Bearer <installation credential>
Connection: Upgrade
Upgrade: websocket
Sec-WebSocket-Version: 13
Sec-WebSocket-Key: <WebSocket library generated key>
```

成功是标准 `101 Switching Protocols`。网关通过 `/v1/installations/self` 验证凭据及桌面平台，失败在升级前返回 `401`；安装查询故障为 `502`，均关闭连接且不保证 JSON 体。每安装只保留一个在线隧道，新连接替换旧连接，旧连接收到关闭码 `4000`、原因 `replaced`；网关关闭为 `1001 gateway stopping`。注册表仅进程内存，重启须重连；桌面实现重试退避从 1 秒起，上限默认 30 秒。

### 二进制帧

每帧是 `9-byte header + payload`：

| 偏移 | 长度 | 含义 |
| --- | --- | --- |
| 0 | 4 | 无符号 stream ID，big-endian |
| 4 | 1 | 类型：`OPEN=0`、`DATA=1`、`END=2`、`RESET=3` |
| 5 | 4 | payload 字节数，big-endian |
| 9 | 指定长度 | payload 原始字节 |

单帧 payload 最大 64 KiB，解码器缓存上限 1 MiB；帧可跨 WebSocket message 分片，也可在一个 message 中连续携带多个帧。网关分配 stream ID（1 起，32 位回绕），发送空 payload 的 `OPEN`；桌面为该流连接本次启动的私有 companion origin。`DATA` 承载原始 HTTP/1.1 请求/响应字节（包括 SSE 和升级后的 WebSocket 流量），不是 JSON/base64；`END` 结束写入，`RESET` 中止流。协议实现和具体分块行为以链接源码为准，不可将整个 HTTP 请求随意包装成一个超限 DATA 帧。

**生命周期注意**：网关只在桌面握手时验证安装凭据，没有承诺到期/撤销会主动踢掉已建立的桌面隧道；手机每个新请求仍会验证账号会话及当前安装归属，撤销后不再通过归属检查。手机 WS 升级后的字节流也不是逐消息重新鉴权。退出、轮换、撤销或切换账号时，客户端应关闭旧连接，不应把长连接视为凭据永久有效的证明。

## 4. 手机 HTTP / WebSocket 调用桌面

手机先在**同一网关、同一账号**登录，通过安装列表取得桌面 UUID。基础地址是：

```text
https://192.168.66.193:18487/v1/companion/<installation UUID>
```

每次 HTTP 请求及 WS 升级均发送 `Authorization: Bearer <account token>`。网关并行查 `/v1/me` 和 `/v1/installations` 校验会话、安装归属及桌面平台，再查在线隧道。既不需要配对码、二维码或 iOS handoff，也不把安装凭据交给手机。companion 仍执行自身 allowlist，不是管理接口或任意 harness 代理；同账号设备默认不因此取得 cloud desktop/browser control 能力。

### 路径、健康与流

- `/v1/companion/:id` 和 `/v1/companion/:id/` 均转为桌面的 `/`；companion 不提供桌面网页，`/` 不是健康检查。
- 前缀精确小写 `/v1/companion/`，ID 是 UUID，内部转小写；剥离该前缀和 ID，保留后续路径及 query。错误格式路径不会进入中继，会落到普通网关路由。不要把 `clientInstanceId` 当作 UUID。
- 网关健康检查是无鉴权 `GET /healthz`，基础成功响应 `200 {"ok":true,"service":"openmausbot-control-plane"}`；配置允许时可附 `capacity`。鉴权配置错误为 `503 {"error":"misconfigured"}`。**它不证明任何桌面在线，也不证明 Cloudflare/APNs/AI 已就绪。**
- 桌面端健康检查是经中继 `GET /api/health`；虽然 companion 本身允许公开健康路径，网关前缀仍要求账号鉴权和归属。正常 `200 {"app":"hezuo"}`，不会泄露 harness pid 等字段。
- `/api/events` 是 SSE，不是 WebSocket。WS 路径由 companion 的实际业务/查看器会话返回，网关不另设通用手机 WS 路径；应在返回的路径前加当前安装中继前缀，并在升级头中带账号 bearer。不能向桌面专用 `/v1/companion/relay` 发送手机业务消息。
- 原生客户端不发送 `Origin`；companion 拒绝带 Origin 的请求/升级。不要把这套原生连接方式直接放进浏览器：浏览器原生 WebSocket API 也不能自定义 Authorization 头。

```sh
# 网关健康（不含桌面在线状态）
curl --cacert "$CA" "$GATEWAY/healthz"

# 桌面健康：200 {"app":"hezuo"}
curl --cacert "$CA" \
  "$GATEWAY/v1/companion/$INSTALLATION_ID/api/health" \
  -H "Authorization: Bearer $ACCOUNT_TOKEN"

# 持续读取允许的 SSE；断线应按业务游标/事件契约恢复，不盲目重放写请求。
curl --cacert "$CA" -N \
  "$GATEWAY/v1/companion/$INSTALLATION_ID/api/events" \
  -H "Authorization: Bearer $ACCOUNT_TOKEN"
```

手机 WS 握手结构（`<returned companion WS path>` 必须是实际会话返回的路径，不是字面占位端点）：

```http
GET /v1/companion/<installation UUID>/<returned companion WS path> HTTP/1.1
Authorization: Bearer <account token>
Connection: Upgrade
Upgrade: websocket
Sec-WebSocket-Version: 13
Sec-WebSocket-Key: <WebSocket library generated key>
```

### 中继错误处理

手机 HTTP 的**网关中继层**错误使用嵌套形状，例如：

```json
{"error":{"code":"desktop_offline","message":"desktop_offline"}}
```

| 状态/代码 | 含义和客户端处理 |
| --- | --- |
| `401 unauthorized` | 缺/失效账号会话、安装非本人或不在活跃桌面列表；重新确认登录和列表，不用安装凭据替换 |
| `503 desktop_offline` | 当前进程没有此桌面在线隧道；显示离线，不当作密码错误 |
| `502 gateway_unavailable` | 网关账号/安装查询失败 |
| `502 desktop_unavailable` | 桌面响应头超时（默认 15 秒）、断流或无效响应 |
| `413 request_too_large` | 中继收集 HTTP 请求体上限 32 MiB；连接也可能已被销毁，不保证能收到 JSON |

WS 升级前鉴权、查询、离线失败分别返回 `401`、`502`、`503` HTTP 后断开，没有上述 JSON 保证；升级后失败通常体现为断流。桌面业务响应状态/体会转发，其错误结构不必等同于中继错误。中继请求体上限不表示 companion 各业务都支持该大小；SSE/WS 断开不证明先前写操作未执行，不能自动重放非幂等操作。

## 5. 托管 endpoint：GET / POST / DELETE

这是可选 Cloudflare 路径，完整的分配、配额、重试、回收及多账号契约见 **[Managed endpoint contract](../gateway/control-plane/README.md#managed-endpoint-contract)**；当前实现：[endpoints.ts](../gateway/control-plane/src/endpoints.ts)。当前远端没有该服务的提供者配置；Node 中继不需要它。

三个方法路径均为 `/v1/installations/self/endpoint`，使用安装凭据：

```sh
curl --cacert "$CA" "$GATEWAY/v1/installations/self/endpoint" \
  -H "Authorization: Bearer $INSTALL_CREDENTIAL"

# 无请求体也合法；上报版本时仅允许 appVersion 字段。
curl --cacert "$CA" -X POST "$GATEWAY/v1/installations/self/endpoint" \
  -H "Authorization: Bearer $INSTALL_CREDENTIAL" \
  -H 'Content-Type: application/json' --data '{"appVersion":"0.1.104"}'

curl --cacert "$CA" -X DELETE "$GATEWAY/v1/installations/self/endpoint" \
  -H "Authorization: Bearer $INSTALL_CREDENTIAL"
```

- GET：`200 {"endpoint":null}`，或 `{"endpoint":{...}}`。非空对象的精确字段为 `url`、`hostname`、`status`、`generation`、`updatedAt`、`lastReconciledAt`、`lastErrorCode`。状态为 `pending|provisioning|ready|deleting|deleted|error`，`deleted` 对外返回 `null`；时间/错误字段可为 `null`。GET 永不返回 connector token。
- POST：成功 `200 {"endpoint":{...},"connectorToken":"<secret>"}`。无 body 或空 body 合法；非空 body 需 JSON，仅可选 printable `appVersion`（trim 后 1–64 字符）。token 只在 tunnel 配置和 DNS 就绪后取得，直接写入 OS 安全凭据库，不在 UI/日志显示，不能从 GET 恢复。接口没有给出固定 connector token TTL，不能假定等于安装凭据 90 天。
- DELETE：完成/已删除为 `204` 空体；部分提供者清理失败 `503 endpoint_cleanup_pending`；忙为 `409 endpoint_busy`、`Retry-After: 2`。
- 分配每安装每小时 20 次，删除 30 次；容量不足 `503 endpoint_capacity`、`Retry-After: 600`，提供者限流 `503 endpoint_rate_limited`、`Retry-After` 30–300 秒（缺省 60），其他提供者失败 `502 endpoint_unavailable`。这些与缺部署配置的 `503 endpoint_unavailable` 应结合状态处理。
- 回收后 POST 可在同一 hostname 后重建 tunnel。端点拥有者和安全清理规则、15 分钟 GET 对账/账号恢复策略以权威详细文档为准，不在手机中实现提供者分配。

## 6. 手机推送 register / unregister / send

完整 APNs 配置、payload、提供者错误映射见 **[Phone push relay](../gateway/control-plane/README.md#phone-push-relay)**；精确 schema/返回值以 [push.ts](../gateway/control-plane/src/push.ts) 为准。[iOS companion](ios-companion.md)描述手机和宿主集成。**这里的调用者是持安装凭据的桌面/宿主，不是持账号会话的原生手机**；手机把 APNs token 通过其 companion 业务流程交给宿主，不能因此持有安装凭据。

三个方法均为 `POST`、`application/json`、安装 bearer，严格对象；所有 token 均须为 **64–200 个小写十六进制字符**。以下是格式有效的虚构 token：

```sh
PUSH_TOKEN='0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'

# 成功：200 {"registered":true}
curl --cacert "$CA" -X POST "$GATEWAY/v1/installations/self/push/register" \
  -H "Authorization: Bearer $INSTALL_CREDENTIAL" \
  -H 'Content-Type: application/json' \
  --data "{\"v\":1,\"token\":\"$PUSH_TOKEN\",\"environment\":\"production\"}"

# 成功：202 {"sent":true}
curl --cacert "$CA" -X POST "$GATEWAY/v1/installations/self/push/send" \
  -H "Authorization: Bearer $INSTALL_CREDENTIAL" \
  -H 'Content-Type: application/json' \
  --data "{\"v\":1,\"token\":\"$PUSH_TOKEN\",\"notification\":{\"kind\":\"approval\",\"title\":\"需要你的确认\",\"botId\":\"bot-1\",\"botName\":\"助手\",\"threadId\":\"thread-1\"}}"

# 成功：204 空体（幂等删除）
curl --cacert "$CA" -X POST "$GATEWAY/v1/installations/self/push/unregister" \
  -H "Authorization: Bearer $INSTALL_CREDENTIAL" \
  -H 'Content-Type: application/json' \
  --data "{\"v\":1,\"token\":\"$PUSH_TOKEN\"}"
```

精确字段：

- register：`{v:1, token, environment:"production"|"sandbox"}`，重复注册更新环境；环境不在部署允许列表为 `400 push_environment_not_allowed`。每安装最多 50 token（`409 push_device_limit`），每小时 120 次注册。
- unregister：`{v:1, token}`；未知 token 也是 `204`。**实现没有 APNs 配置检查**，所以不要套用旧详细文档“所有 push 路由缺配置均 503”的概括到 unregister。
- send：`{v:1, token, pairing?, notification:{kind,title,botId,botName,threadId,roomId?,roomName?}}`。`pairing` 正则 `^[A-Za-z0-9_-]{8,64}$`；`kind` 为 `^[a-z][a-z-]{0,39}$`；所有 ID 为 `^[\w-]{1,120}$`；`title` 1–200 Unicode 字符，名称 1–80，无首尾空白、控制字符或 U+2028/U+2029。其他字段一律拒绝（例如 `body`、消息正文），不得把聊天文本送到 Apple。
- send 只接受**本安装已注册**的 token；否则 `404 push_device_unknown`，宿主可重新注册后重试一次。APNs 已判失效为 `410 push_device_unregistered`，宿主应丢弃记录，等待手机新注册。
- 每安装每小时 600 次发送、每 token 每小时 60 次；超限/APNs 限流为 `429 rate_limited`、`Retry-After: 60`。无/无效 APNs 配置或提供者鉴权失败为 `503 push_unavailable`，其他发送失败为 `502 push_failed`。现有宿主对不可用配置退避一小时。
- APNs token 不由网关签发，无固定 90 天有效期；按手机更新和 APNs 失效响应处理。撤销安装删除其注册。Apple 通知设置 24 小时 expiration，这不是手机 token 或安装凭据有效期。APNs 签名私钥、team/key 配置永远只在部署端。

## 7. 控制平面通用失败与安全处理

与中继嵌套错误不同，上述安装、endpoint、push 控制平面错误为：

```json
{"error":"unauthorized"}
```

通用：缺/错凭据 `401 unauthorized`；严格 schema/坏 JSON `400 invalid_request`；非 JSON 媒体类型 `415 unsupported_media_type`；默认控制平面请求体上限 16 KiB，超限 `413 request_too_large`；未匹配的路径或方法通常 `404 not_found`，不保证 `405`。带浏览器 Origin 的请求受精确 allowlist 约束，未允许为 `403 origin_not_allowed`。控制平面提供 `x-request-id` 可用于排错，不记录敏感请求体/凭据。

安装凭据到期前用有效账号会话轮换；到期后 `self` 返回 401 不表示应注册重复安装。账号会话的有效期/退出行为由登录契约决定，不等于安装 90 天；模型凭据也不是这里可用的认证材料。凭据持久化用平台安全存储，不用普通前端存储或 URL；诊断时只记录状态、稳定错误码与请求 ID。重试遵守 `Retry-After`，对于响应丢失的创建、轮换、写入或发送，不假定请求没有执行。
