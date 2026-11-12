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

## 验证限制

Android core 已通过代理下载 Gradle 并开始编译，但在 `mobile/android/core/src/main/kotlin/com/openmausbot/companion/core/Failover.kt:126` 失败：`when` 未覆盖 `Unexpected`。这是 Kotlin 分支完整性问题，不是路径解析错误；本次未扩展到安卓功能代码修复。Android 测试不能宣称通过。JDK 使用缓存 JBR 21，Java 17 toolchain 同样存在。

macOS 产物未签名、未公证，仅本机安装验证；未发布 Windows/Linux 或推送代码。

## 暂缓需求

1. 混合模型统一计费：简单 gpt-6.1-sol、复杂 gpt-6-astra；每百万 token 输入1000、缓存250、输出4000积分。开始前需确认跨档失败回退策略。尚未改路由、价格或真实网关配置。
2. 管理后台：账号、积分、安装设备、审计；远程 bot 管理权限边界需先确认。
3. 安卓新功能：桌面一致的部门排序、群成员、会话文件夹操作。

真实凭据不保存在此文档。
