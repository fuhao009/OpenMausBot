# 192.168.66.193 网关部署

## 部署记录

- 地址：`https://192.168.66.193:18487`，仅绑定该内网地址。
- 服务：`hezuo-gateway.service`，已启用开机启动，运行账号 `hezuo-gateway`。
- 源码：`/opt/hezuo-gateway/app`。
- 独立 Node 24.16.0：`/opt/hezuo-gateway/runtime/node_modules/node/bin/node`；未替换系统 Node。
- 数据和配置：`/var/lib/hezuo-gateway/`、`/var/lib/hezuo-gateway/gateway.json`。
- 证书：`/var/lib/hezuo-gateway/tls/gateway-cert.pem`；私钥只留服务器。
- 本机证书副本：`.omb-scratch/remote-gateway-193/gateway-cert.pem`。

本次为全新部署，未迁移原电脑数据库、账户或上游凭据。密码登录能力已开启；未配置邮件、上游模型、价格或运营者，因此邮箱验证码和 AI 推理未启用。没有修改现有 nginx 或其他服务。

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
