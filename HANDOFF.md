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

## 待办：前端（桌面端 + 手机端）

分工：本分支 `feat/bot-panel-unify`（目录 `/Users/a1234/Desktop/HezuoBot`）只做桌面端和手机端；服务端由他人在 `backend/gateway-deploy-admin-193`（worktree `/Users/a1234/Desktop/HezuoBot-backend`）开发。凡涉及后端接口与契约，一律以后端分支为准，本分支不改 `desktop/server/`、`gateway/`。截至后端 `fbe737aaf`，后端分支只有文档提交（`docs/gateway-admin-design.md`、`docs/gateway-deployment-193.md`），没有接口变更；下面的待办都不需要新接口。

以下均未开始，没有任何代码改动。方案是设计意见，实施前可调整。

### TODO 1：右上角"小电脑"和"任务/资料"并入 bot 资料栏（桌面端）

现状：
- 聊天头部右上角两个按钮：任务（`ListChecks`，`data-product-work-entry="tasks"`）和小电脑（`Monitor`，`data-product-work-entry="computer"`），在 `desktop/src/components/ChatView.tsx` 约 1050–1077 行。
- 产品模式下两者打开 `desktop/src/components/WorkPanel.tsx`（活动 / 资料库 / 电脑 三个标签）；非产品模式打开独立的 `ComputerPanel` / `ActivityPanel`（`desktop/src/App.tsx` 约 457–484 行）。
- 点 bot 头像胶囊打开的资料栏是 `BotSettingsDialog` → `desktop/src/components/bot-panel/PanelShell.tsx`（`BotPanel`），已有 详情 / 资料库 / 电脑 三个标签（`bot-panel/page-registry.ts` 的 `PANEL_TABS`），其中"电脑"只是一张截图缩略图（`bot-panel/ComputerTab.tsx`）。

方案：
- [ ] 范围：简单模式和产品模式（`!remoteClient && (product || !advanced)`）。高级模式和远程客户端保持现状。
- [ ] 不改 reducer：简单模式下 `computerOpen` = 资料栏开在"电脑"标签，`activityOpen` = 开在"活动"标签，`settingsOpen` = 详情/资料库。已有的 `toggleComputer` 深链（`lib/place-view.ts`、`lib/page-open.ts`、`openSignIn`、`openDataResult`、`TeamMapPage`、`GuidedTour`、`AccessSection`、`ChatMoreMenu` 手机菜单）会自动落到对应标签。
- [ ] `App.tsx`：简单模式下 `settingsOpen || computerOpen || activityOpen` 任一为真就渲染同一个 `BotSettingsDialog`（key 不变，切标签不重挂载）；删除 `WorkPanel` 的渲染；独立 `ComputerPanel` / `ActivityPanel` 只在非简单模式渲染。
- [ ] 删除 `WorkPanel.tsx` 和 `styles.css` 中 `[data-product-details-*]`、`[data-product-work-*]` 样式；`WorkspaceResizeEdge.tsx` 里对 `data-product-work-panel` 的兄弟判断改成新的 `data-bot-panel`。
- [ ] `ChatView.tsx`：简单模式隐藏任务和小电脑两个按钮；`ChatHeadPill` 的打开状态取三者之一，点击时任一打开就全部关闭，否则打开详情。
- [ ] `BotPanel` 改为四个标签：详情 / 活动 / 资料库 / 电脑。新增 `botPanel.tab.activity` 文案（en、zh、zh-tw 等已有 `botPanel.tab.details` 的语言）。标签与 store 双向同步；关闭按钮和 Esc 同时关三个状态；`data-tour="computer"` 移到"电脑"标签上；正在使用浏览器时，在"电脑"标签上显示原来头部按钮上的绿色呼吸点。
- [ ] "活动"标签：用 `<ActivityPanel embedded />`，并重新定义 `embedded`（原本只有 WorkPanel 用）：不要标题行、不自带滚动、日期标题不吸顶、背景透明。详情页 `DetailsTab` 的 `CONVERSATION_ITEMS` 里去掉 `activity`。
- [ ] "电脑"标签：缩略图换成真正的 `ComputerPanel`。给它加 `embedded`：无拖宽手柄、无关闭、无齿轮、无自身边框和固定宽度；保留 屏幕 / 浏览器 / 数据 / 文件 子标签。下方一行轻量入口跳到已有页面 `where`（在哪工作）和 `browser`（已登录网站数）。`onOpenVmWorkspace` 从 App 一路传进来。
- [ ] 在"电脑"标签上隐藏大头像区（`PanelHero`），在顶部拖拽条左侧显示小头像加名字；面板加宽到 `var(--workspace-width, 460px)`，宽度用 200ms 过渡（减少动态效果时不过渡），并加 `WorkspaceResizeEdge`（360–720px，`omb-bot-panel-computer-width`）。产品模式窗口窄于 1200px 时以浮层显示，不挤压聊天区。
- [ ] 测试：更新受影响的 vitest（ChatView 头部、PanelShell、page-registry、GuidedTour、ComputerPanel）；新增"四个标签""点电脑标签置 computerOpen""activityOpen 选中活动"，以及"简单模式头部没有两个按钮、高级模式仍有小电脑"。
- [ ] `scripts/verify-product-account.mjs` 约 525–620 行的布局检查依赖 `data-product-work-entry` / `data-product-work-panel`，要改成：从头像胶囊打开 → 点 `[data-panel-tab="computer"]` → 对 `[data-bot-panel]` 断言（1440×900 停靠，1000×800 浮层并可 Esc 关闭），同时断言头部不再有 `data-product-work-entry`。截图名保持不变，另补拍 详情 / 活动 / 电脑 三个标签的截图。
- [ ] 验证：`npx tsc -b desktop`、`npx oxlint --deny-warnings desktop/src scripts/verify-product-account.mjs`、相关 vitest；再用 `scripts/verify-product-account.mjs` 跑隔离验收（不碰 `/Applications/Hezuo.app` 和真实数据）。

### TODO 2：手机端同步（Android）

- [ ] `mobile/android/app/src/main/kotlin/com/openmausbot/companion/ui/ChatScreen.kt` 的 `ChatHeader`（约 1159–1172 行）去掉 `ic_display` 小电脑按钮，保留通话按钮。
- [ ] 点头像打开的 `AgentProfileSheet.kt` 顶部加一张"电脑"卡片：16:10 圆角块，有现成帧数据就显示最新屏幕，否则显示头像加"正在工作 / 休息中"；点击后关闭资料页并调用原来的 `onOpenComputer(bot.id)`（新增参数，从 ChatScreen 传入）。斜杠命令和 `ChatActionId` 打开电脑的路径保留。
- [ ] 先修编译：`mobile/android/core/src/main/kotlin/com/openmausbot/companion/core/Failover.kt:126` 的 `when` 未覆盖 `Unexpected`。需要先判断 `Unexpected` 该不该换路由重试，再补分支，不要随手加 `else`。
- [ ] 验证：`./gradlew :app:assembleDebug :app:testDebugUnitTest`，没实际跑通就不能宣称通过。
- [ ] iOS（`mobile/ios`）有对应的 `AgentProfileView.swift`，本次不在范围内，需要时另行确认。

### TODO 3：bot 头像形状可选，先留扩展口

用户要求：头像可以有多种形状供自己选择，现在先把扩展口留好，形状后面再加。

现状：
- 上传图片的形状只有 圆 / 圆角 / 方 三种，写死在 `desktop/src/components/bot-panel/AvatarEditorCard.tsx` 第 27–32 行（`IMAGE_CROPS`、`CROP_KEY`）。实际绘制用 `packages/shared/bot-avatar` 的 `avatarCropRadius(crop)`，只能表达圆角半径。
- 吉祥物头像的形状是"身体"（`packages/shared/mascot-bodies` 的 `MASCOT_BODIES` / `MASCOT_BODY_IDS`），已经是登记表，编辑器按表渲染。
- 取值表是 `packages/shared/bot-avatar.ts` 的 `BOT_AVATAR_CROPS = ["mascot","circle","rounded","square"]` 和 `botAvatarCropSchema`；服务端 `desktop/server/bot-profile.ts` 用它校验写入。bot 打包导入导出另有一份 `packages/shared/package-format.ts` 的 `AVATAR_CROPS`（不含 mascot）。新增取值涉及服务端契约和打包格式，必须按后端分支来，不能前端单方面加。

方案：
- [ ] 在 `packages/shared/bot-avatar` 里把形状收成一份登记表：每项包含 id、文案 key，以及绘制方式（CSS `clip-path` 或 SVG mask，不再只靠 `border-radius`）。`avatarCropRadius` 由这份表派生；编辑器的 `IMAGE_CROPS` / `CROP_KEY` 改成读表。以后加形状只需往表里加一项。
- [ ] `BotAvatar`（`desktop/src/components/Avatar.tsx` 第 274–301 行）的图片分支按登记表绘制；侧栏、群成员、通知等所有调用点都走 `BotAvatar`，不用逐个改。
- [ ] 先不新增形状。需要新形状时，先让后端分支在 `BOT_AVATAR_CROPS` 和 `package-format.ts` 的 `AVATAR_CROPS` 里放开新取值，前端再往表里加，同步更新 iOS 的 `BotAvatarRendering.swift` 和 Android 的头像绘制。
- [ ] 待确认：形状是只作用于上传图片，还是也要作用于吉祥物头像（吉祥物目前由身体轮廓决定，没有外框）。

### 分支状态

- 本分支从 `9edf5aecf` 创建。分支上有一个提交 `98ca8e212`，它的提交信息和后端 `fbe737aaf` 相同、哈希不同，不是本线工作产生的，内容只是 `docs/gateway-deployment-193.md` 的两行。是否把本分支改到后端 `fbe737aaf` 上（会改写历史）待确认。
- 未推送。

真实凭据不保存在此文档。
