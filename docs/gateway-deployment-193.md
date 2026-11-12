# 192.168.66.193 网关部署

## 部署记录

- 地址：`https://192.168.66.193:18487`，仅绑定该内网地址。
- 服务：`hezuo-gateway.service`，已启用开机启动，运行账号 `hezuo-gateway`。
- 源码：`/opt/hezuo-gateway/app`。
- 独立 Node 24.16.0：`/opt/hezuo-gateway/runtime/node_modules/node/bin/node`；未替换系统 Node。
- 数据和配置：`/var/lib/hezuo-gateway/`、`/var/lib/hezuo-gateway/gateway.json`。
- 证书：`/var/lib/hezuo-gateway/tls/gateway-cert.pem`；私钥只留服务器。
- 本机证书副本：`.omb-scratch/remote-gateway-193/gateway-cert.pem`。

全新部署，未迁移原电脑数据库、账户或上游凭据。密码登录已开启；管理员 `fuhaoliang@admin.com` 已按用户授权创建并显式加入运营者配置。未配置邮件、上游模型或价格，因此邮箱验证码和 AI 推理未启用。没有修改现有 nginx 或其他服务。

管理网页：`https://192.168.66.193:18487/admin`。已部署实现提交 `9b0e3cb4e`，远端记录在 `/opt/hezuo-gateway/deployed-commit`。随机管理员初始密码保存在服务器 `/root/hezuo-admin-initial-credentials.json`（root，0600），不进入 Git。通过 SSH 私下读取，不粘贴到联调日志。

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
- 从开发机使用 curl `--cacert` 校验证书并跨机器访问：`/healthz` 200；`/v1/auth/methods` 200；部署后 `/admin` 200。
- `tsc --noEmit -p gateway/control-plane/tsconfig.json` 通过。
- `vitest run test/admin.test.ts test/account-ai.test.ts`：2 个文件、21 项测试通过，涵盖运营者权限和现有账本管理行为。
- 独立临时数据库 + 真实网关 CLI + 假上游 fixture 已成功启动；此前直接程序调用的隔离检查曾超时，不作为通过证据。
- 浏览器在 fixture 中实际验证：普通账号拒绝、运营者登录、精确邮箱查询、增加 1.000001 积分、停用/启用 AI、拒绝超出 0.204 积分预占的结算、按 0.1 积分成功结算、系统状态、退出。最终可用 5.900001 积分，预占 0。
- 桌面宽度 1440px、窄屏 390px 已观察真实页面；窄屏无整页横向溢出，localStorage/sessionStorage 均为空，浏览器无页面错误。仅本机一次性 fixture 浏览器放行自签证书；生产跨机器检查使用 CA 校验。
- 生产环境只执行用户授权的管理员注册与授权，没有注入测试积分或推理请求。手机/桌面中继和真实模型推理未验证。

实现包含账号查询、权限启停、增加积分、请求记录/详情/人工结算和系统状态。接口契约见 [gateway-admin-api.md](gateway-admin-api.md)。全局用户列表、设备管理、网页修改模型定价不在此版界面内；不把账号级接口冒充全局运营接口。
