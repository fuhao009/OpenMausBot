# 交接：目录拆分收尾

2026-11-12。当前范围仅目录拆分、打包安装、架构文档；混合计费、管理后台、安卓新功能暂停。

## 已完成

- 目录布局：`desktop/`、`mobile/`、`gateway/`、`packages/shared/`。原拆分已由先前提交 `2e384daf1` 保存，本次继续修复，不改写该提交。
- 修复 Vitest 误收 Node companion-relay 测试、更新器测试两处旧路径、workspace 锁文件入口、CODEOWNERS、CLI 帮助、文档与移动端引用。
- `pnpm install --frozen-lockfile --offline` 通过，未升级依赖。
- `tsc -b desktop` 通过。Electron 全组本轮仅更新器文件失败；修复后该文件 10/10 通过，其余全组通过项未重复执行。
- 网关与 app-loading 26 个测试通过；gateway/scripts 与服务测试 30 个通过；companion-relay Node 测试 5 个通过。
- macOS arm64 产品打包成功；解开 asar 的导入检查 2/2 通过。
- 隔离产品账号验收 21 步通过，receipt：`/private/var/folders/s0/5h112y2d3495p65t6p7cph400000gn/T/omb-product-verify-oAVUH4/evidence/receipt.json`。
- 新入口临时网关执行 13 个迁移，TLS 验证下 healthz 成功，已停止。
- 正式 launchd `com.hezuo.gateway` 已重新安装，指向 `gateway/local/local-gateway.mjs`，state running，证书验证下 healthz 成功。
- 新包已装到 `/Applications/Hezuo.app`，旧包保存在废纸篓 `Hezuo-0.1.139-before-split-*.app`。安装后截图确认仍登录、原有 bot/部门/群和历史对话可见；未向真实账号发送测试消息。
- 架构与配置文档：`docs/architecture.md`，README 已链接。

## 桌面端（新版本）在哪里、怎么构建

只有一个桌面端：`Hezuo`（应用 ID `com.hezuo.product`，版本 0.1.139，macOS arm64，未签名未公证，仅本机自用）。

| 项目 | 位置 |
|---|---|
| 源码 | `desktop/`：入口 `desktop/electron/main.mjs`，界面 `desktop/src/`，本地服务 `desktop/server/`，手机侧车 `desktop/companion/` |
| 已安装的 App | `/Applications/Hezuo.app` |
| 构建产物 | `release/product/mac-arm64/Hezuo.app`，安装包 `release/product/Hezuo-0.1.139-arm64.dmg` 和 `.zip` |
| 运行时本地服务 | `http://127.0.0.1:8799`（bot、对话、部门、群，只在本机） |
| 用户数据 | `~/Library/Application Support/Hezuo Product`；服务数据根 `~/.hezuo` |
| 它连的网关 | `https://127.0.0.1:18487`，在打包时固定进包里的 `product-service.json`，连同网关证书一起 |
| 网关数据 | `~/Library/ApplicationSupport/HezuoGateway/`（配置 `gateway.json`，证书 `tls/gateway-cert.pem`） |

### 构建

```sh
export PATH="$HOME/.local/nodejs/node-v24.16.0-darwin-arm64/bin:$HOME/.local/bin:$PATH"
unset ELECTRON_RUN_AS_NODE            # 否则 Electron 会按 Node 模式运行，窗口出不来
cd /Users/a1234/Desktop/HezuoBot
pnpm install --frozen-lockfile

NODE_USE_ENV_PROXY=1 OMB_PRODUCT_SERVICE_URL="https://127.0.0.1:18487" \
  pnpm product:package --platform mac --arch arm64 --local-origin \
  --gateway-ca "$HOME/Library/ApplicationSupport/HezuoGateway/tls/gateway-cert.pem" --unsigned
```

- `pnpm product:package` 自己会先构建界面、服务和手机侧车，不用另跑 `pnpm build`。
- `NODE_USE_ENV_PROXY=1` 是为了让下载依赖的资源走本机代理，没有代理时可以去掉。
- 网关地址换了（比如部署到云端），就改 `OMB_PRODUCT_SERVICE_URL`，并去掉 `--local-origin` 和 `--gateway-ca`；该地址必须是运营者自己的域名，脚本会拒绝示例域名和上游项目的域名。
- 只想检查参数、不构建：加 `--dry-run`。想要不打包成安装包的目录：加 `--dir`。
- 不要用 `pnpm package:mac`：那是上游项目的通用打包，不会把网关地址固定进包里。

### 构建后验证

1. 解开 `release/product/mac-arm64/Hezuo.app/Contents/Resources/app.asar` 到一个临时目录，再运行
   `PACKAGED_ROOT=<临时目录> node --test desktop/electron/packaged-imports.node-test.mjs`，两项都要通过。它检查启动时加载的每个文件都在安装包里。
2. 清掉所有代理环境变量后运行
   `env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u http_proxy -u https_proxy -u all_proxy -u NODE_USE_ENV_PROXY node scripts/verify-product-account.mjs --app release/product/mac-arm64/Hezuo.app`
   它在一次性的隔离环境里跑 21 步（注册登录、扣积分、工具授权、切换账号），不碰真实数据。有代理时回环地址的假服务会连不上。

### 安装到本机

1. 退出 Hezuo，把 `/Applications/Hezuo.app` 移到废纸篓（不要永久删除，方便回退）。
2. `ditto release/product/mac-arm64/Hezuo.app /Applications/Hezuo.app`，然后打开。
3. 账号、对话数据在 `~/Library/Application Support/Hezuo Product`，重装应用不会动它。
4. 机器上不能同时存在 `Hezuo Product` 和 `OpenMausBot Product` 两个数据目录，新版遇到这种情况会拒绝启动并弹错误框。

## 验证限制

Android core 已通过代理下载 Gradle 并开始编译，但在 `mobile/android/core/src/main/kotlin/com/openmausbot/companion/core/Failover.kt:126` 失败：`when` 未覆盖 `Unexpected`。这是 Kotlin 分支完整性问题，不是路径解析错误；本次未扩展到安卓功能代码修复。Android 测试不能宣称通过。JDK 使用缓存 JBR 21，Java 17 toolchain 同样存在。

macOS 产物未签名、未公证，仅本机安装验证；未发布 Windows/Linux 或推送代码。

## 暂缓需求

1. 混合模型统一计费：简单 gpt-6.1-sol、复杂 gpt-6-astra；每百万 token 输入1000、缓存250、输出4000积分。开始前需确认跨档失败回退策略。尚未改路由、价格或真实网关配置。
2. 管理后台：账号、积分、安装设备、审计；远程 bot 管理权限边界需先确认。
3. 安卓新功能：桌面一致的部门排序、群成员、会话文件夹操作。

真实凭据不保存在此文档。
