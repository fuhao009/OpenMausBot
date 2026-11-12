# 交接文档：Hezuo 未完成事项

写于 2026-11-12。仓库 `/Users/a1234/Desktop/OpenMausBot`。
本文只记录**没完成**的事，已经完成的放在最后一节，只作为背景。

---

## 0. 先看这个：当前仓库处于什么状态

| 项目 | 状态 |
|---|---|
| 最近提交（HEAD） | `0b9b8f094`，前面三个修复提交都在，没推送 |
| 工作区 | **有一次未提交、没做完的目录拆分**：约 5900 个文件被 `git mv` 过（4332 个纯重命名、1238 个重命名加改动、396 个改动、1 个新增） |
| 已装的 App | `/Applications/Hezuo.app`，是**拆分之前**的代码，能正常用 |
| 网关服务 | launchd `com.hezuo.gateway` 在运行，healthz 200，**仍指向旧路径** `scripts/local-gateway.mjs` |
| 网关数据 | `~/Library/ApplicationSupport/HezuoGateway/`，没有被拆分改动 |

**重要风险**：
1. 网关服务指向的 `scripts/local-gateway.mjs` 已经被拆分移走。**只要重启网关就会起不来。** 在拆分做完并重新安装服务之前，不要重启它，也不要重启电脑。
2. 工作区里根目录已经没有 `tsconfig.json`、`src/`、`server/` 等，在这个状态下直接打包或跑测试会失败（见 1.2）。

**撤回拆分的办法**（会丢掉所有未提交的拆分改动，前三个修复提交不受影响）：
```
cd /Users/a1234/Desktop/OpenMausBot
git reset --hard HEAD && git clean -fd desktop mobile gateway packages
```
没有经过用户确认，不要执行。

---

## 1. 目录拆分（做到约七成）

### 1.1 目标结构
```
desktop/    src/ server/ electron/ companion/ public/ build/ 各 *.html
            vite.config.ts tsconfig*.json
mobile/     android/ ios/
gateway/    control-plane/（原 cloudflare/control-plane）
            composio-broker/（原 cloudflare/composio-broker）
            local/（原 scripts/local-gateway.mjs 和 scripts/local-gateway/，含其测试）
            scripts/（account-ai-admin.mjs、deploy-product-service.mjs 及其测试）
packages/   shared/（原 shared/）
根目录保留  package.json  pnpm-lock.yaml  pnpm-workspace.yaml  electron-builder.yml
            scripts/（桌面构建、打包、仓库工具）  apps/docs  docs/  evals/  connector/
            enterprise/  deploy/  skills/  third_party/  Dockerfile  compose.yaml
            dist* 和 release/ 等产物目录（位置不变）
```

### 1.2 已经做完的
- 所有目录已用 `git mv` 移到新位置，历史可追溯。
- 约 908 个文件里对 `shared/` 的引用已改成 `packages/shared/`，旧引用已经为 0。
- 已改过的配置：`package.json`（`main` 指向 `desktop/electron/main.mjs`）、`vite.config.ts`、各 `tsconfig`、`pnpm-workspace.yaml`、oxlint 配置、`electron-builder.yml`、`Dockerfile`、CI 的 yml、`scripts/ci-scope.mjs`、网关路径。
- 改写脚本和进度：`/tmp/restructure/`（`STATUS.md`、`rewrite.py`、`tokens.py`、`segments.py`、`rel2.py`、`baseline/`、`after/`）。**这是 /tmp，重启会丢**，需要的话先复制走。

### 1.3 基线（拆分前 HEAD `0b9b8f094`，日志在 `/tmp/restructure/baseline/`）
| 检查项 | 基线结果 |
|---|---|
| `npx tsc -b` | 通过 |
| `npx tsc -p tsconfig.server.build.json --noEmit` | 通过 |
| `npx oxlint --deny-warnings src` | 0 警告 |
| `pnpm build`、`build:server`、`build:companion` | 通过 |
| `pnpm test:electron` | 1573 个测试，1564 通过，0 失败 |
| `pnpm control-plane:test` | 12 个文件 245 个测试通过 |
| vitest（`server/drivers server/product-ai src/components/Sidebar src/lib`） | 408 个文件通过，1 个已知失败（codex whop-env，拆分之前就有） |
| 网关 vitest | 4 个文件 34 个测试通过 |
| 网关 `node --test` 的 companion-relay | 5 个通过 |
| `pnpm i18n:check` | 通过 |

### 1.4 拆分后检查与基线不一致的 4 项（日志在 `/tmp/restructure/after/`）
| 检查项 | 退出码 | 原因 |
|---|---|---|
| `tsc-b` | 1 | `Cannot read file '/Users/a1234/Desktop/OpenMausBot/tsconfig.json'`：命令还在根目录找 tsconfig，而它已搬到 `desktop/`。要改根目录的 `package.json` 脚本（`typecheck`、`build`、`test`），或在根目录放一个指向 `desktop/tsconfig.json` 的引用配置 |
| `test-electron` | 1 | 3 个失败：`packaged-imports.node-test.mjs` 报 `no electron/main.mjs under …/desktop`，该测试按旧的根目录结构找文件，要改成在 `desktop/` 下找；另外两个是 account root 和 sidecar 存储的测试，大概率同样是路径问题，要逐个看 |
| `gateway-vitest` | 1 | `gateway/local/local-gateway/companion-relay.test.mjs` 报 `No test suite found`：这个文件是 `node --test` 写法，被 vitest 的 include 路径误收了，要把它排除出 vitest 的范围（基线是 4 个文件，现在多收了这一个） |
| `vitest` | 1 | `desktop/src/lib/app-loading.test.ts` 报 `ENOENT … /OpenMausBot/src/App.tsx`：测试读源文件用的是写死的根目录路径，要改成 `desktop/src/App.tsx`。codex whop-env 那个失败是基线就有的，可以留着 |

其余 8 项（`tsc-server`、`oxlint`、`build`、`build-server`、`build-companion`、`control-plane`、`gateway-node`、`i18n`）拆分后都是通过的。

### 1.5 还没做的步骤（按顺序）
1. 修好 1.4 里的 4 项，直到结果和 1.3 基线一致（失败数、通过数都一致）。
2. 把文档里的旧路径改成新路径（只做机械替换）：`docs/*.md`、各层 `AGENTS.md`、各 README、`.claude/skills/verify-omb` 和 `.claude/skills/windows-release` 的 SKILL.md。
   - 例如 `scripts/local-gateway.mjs` → `gateway/local/local-gateway.mjs`，`cloudflare/control-plane` → `gateway/control-plane`，`shared/` → `packages/shared/`，`android`、`ios` → `mobile/android`、`mobile/ios`。
3. 跑 `pnpm install --frozen-lockfile --offline`（失败再用 `pnpm install`），确认工作区能解析。`pnpm-workspace.yaml` 里的 `cloudflare/control-plane` 已应改为 `gateway/control-plane`，要核对。
4. 检查 `mobile/android` 和 `mobile/ios` 有没有引用自己目录之外的东西（Gradle、`project.yml`、`scripts/capture-companion-fixtures.mjs` 写入的夹具路径），有 JDK 的话跑一次 `./gradlew :core:test`。
5. 重新打包并验收：
   ```
   export PATH=$HOME/.local/nodejs/node-v24.16.0-darwin-arm64/bin:$PATH
   unset ELECTRON_RUN_AS_NODE
   NODE_USE_ENV_PROXY=1 OMB_PRODUCT_SERVICE_URL="https://127.0.0.1:18487" \
     pnpm product:package --platform mac --arch arm64 --local-origin \
     --gateway-ca "$HOME/Library/ApplicationSupport/HezuoGateway/tls/gateway-cert.pem" --unsigned
   ```
   然后：
   - 在解开的 asar 上跑 `PACKAGED_ROOT=<asar 目录> node --test desktop/electron/packaged-imports.node-test.mjs`；
   - 清掉所有代理环境变量后跑 `node scripts/verify-product-account.mjs --app <新包路径>`（要求 21 步全过）。
   - 产物在 `release/product/mac-arm64/Hezuo.app`。
6. **用新路径重新安装网关服务并重启**（拆分的最后一步，务必做）：
   - 先在一个临时数据目录里用 `gateway/local/local-gateway.mjs start` 试起，确认 `/healthz` 返回 200、Worker 能从 `gateway/control-plane` 打包；
   - 再用 `node gateway/local/local-gateway.mjs service install …` 重装 launchd 服务（命令见 `docs/local-gateway.md`），指向新路径；
   - `launchctl print gui/$(id -u)/com.hezuo.gateway` 确认 state 是 running，`curl -sk https://127.0.0.1:18487/healthz` 返回 200。
7. 搜一遍残留旧路径：`cloudflare/control-plane`、`"../shared/`、`scripts/local-gateway`、`from "../../shared`（排除 `node_modules/`、`release/`），有剩余的逐个说明原因。
8. 全部通过后把拆分单独做成一个提交（不要和别的改动混在一起），**不推送**。
9. 把新包装进 `/Applications`（先退出 Hezuo，旧包移到废纸篓，不要永久删除），打开确认保持登录、数据都在。

### 1.6 拆分后仍然存在的跨目录依赖（保留，写进架构文档）
- `gateway/local/` 依赖 `desktop/electron/companion-relay-frames.mjs`（隧道帧编码）和 `desktop/electron/control-plane-client.mjs`。
- 三端共享的类型：`packages/shared/`（`desktop/` 和 `gateway/control-plane/` 都引用）。

---

## 2. 架构和配置文档（未写）

要在拆分完成后写 `docs/architecture.md`，用拆分后的新路径。内容要覆盖：

1. **整体图**：桌面 Hezuo、手机 App、网关三者的关系（桌面 `127.0.0.1:8799` 的本地服务存 bot、对话、部门；网关 `127.0.0.1:18487` 管账号、积分、模型转发、手机中继；两者数据不共享）。
2. **网关对外接口表**：
   - `/api/auth/*`、`/v1/auth/methods`（登录注册）
   - `/v1/me`
   - `/v1/ai/models`、`/v1/ai/chat/completions`、`/v1/ai/responses`
   - `/v1/account/ai`、`/v1/account/ai/ledger`、`/v1/account/ai/tokens`
   - `/v1/installations/*`
   - `/v1/companion/relay`、`/v1/companion/*`
   - `/v1/operator/ai/*`（仅 `operatorIds` 里的账号）
   - `/healthz`、`/v1/highlevel/*`
3. **配置项在哪里改**：
   | 配置 | 位置 |
   |---|---|
   | 上游地址 | 网关配置 `~/Library/ApplicationSupport/HezuoGateway/gateway.json` 的 `upstreamBase` |
   | 上游 key | `<数据目录>/secrets/upstream-key`，或 `~/.omp/agent/models.yml` 里 provider 的 `apiKey`（每次启动重新读，OMP 也在用它） |
   | 模型、单价、上下文上限 | `gateway.json` 的 `models` 数组（对应 Worker 的 `AI_MODELS`） |
   | 默认模型 | `defaultModel`（`AI_DEFAULT_MODEL`） |
   | 管理员账号 | `operatorIds`（`AI_OPERATOR_USER_IDS`） |
   | 登录方式 | `emailVerification`（`required`/`off`），SMTP 在 `secrets/smtp-url` |
   | TLS 证书 | `<数据目录>/tls/` 或 `--cert`/`--key` |
   | 桌面端固定的网关地址和证书 | 打包参数 `OMB_PRODUCT_SERVICE_URL` 和 `--gateway-ca`，写进包内 `product-service.json` |
   | 手机端网关地址 | 登录页手动输入网关地址（Android `AccountLoginScreen`，iOS `AccountLoginView`） |
   | 云端部署 | `gateway/control-plane/wrangler.jsonc`（vars、D1、secrets），用 `scripts/deploy-product-service.mjs` |
4. **两种部署方式**：本地网关（Miniflare、TLS 自签、launchd 常驻）和 Cloudflare Worker，两者是同一份代码。
5. **本地环境约定**：`node` 不在 PATH，用 `~/.local/nodejs/node-v24.16.0-darwin-arm64/bin`；`pnpm` 在 `~/.local/bin/pnpm`；运行 Electron 前 `unset ELECTRON_RUN_AS_NODE`。
6. **注意事项**：网关访问上游要走能解析域名的 DNS（本机已把 DNS 改成公共 DNS，见第 6 节）。

---

## 3. 混合模型计费（用户端无感）——只定了方案，没写代码

**已确定的需求**（用户在对话里选的）：
- 扣费方式：**统一单价**。用户只看到一个模型；不管后台用哪个，按 token 乘固定单价扣积分。
- 统一单价：每百万 token，**输入 1000 积分、缓存输入 250 积分、输出 4000 积分**（现在是输入输出都 1000）。1 积分 = 100 万微积分，所以对应微积分是输入 1,000,000,000、缓存 250,000,000、输出 4,000,000,000。
- 选模型：**按请求复杂度自动挑**。简单请求用 `gpt-6.1-sol`，复杂请求（带工具、长上下文、派任务）用 `gpt-6-astra`。
- 测试环境：用户说测试环境可以全用 DeepSeek（`deepseek-v4.1-flash`）。这条上游线用户后来说**先不管**，不要做。

**现状（要改的地方）**：
- 当前只有一个公开模型 `gpt-6-astra`，一条上游，价格在 `gateway.json` 的 `models`。
- `gateway/control-plane/src/ai-config.ts`：`AiModelConfig` 一个模型一个 `upstreamModel`、一套价格。
- `gateway/control-plane/src/ai-gateway.ts`：
  - `preparedRequest()` 按请求里的 `model` 找模型；
  - `prepareChat` / `prepareResponses` 把 `model` 改成 `upstreamModel`；
  - `reserve()` 用该模型的价格和上限预扣；
  - `rewriteModel()` 把响应里的上游模型名改回公开名。
- `gateway/control-plane/src/ai-wallet.ts`：`reserveRequest` → `settleRequest`，价格取自预扣时的快照。

**建议做法**（未实现，需要设计评审）：
1. 在 `AiModelConfig` 增加一个"路由"概念：一个公开模型对应一组上游档位（`simple`、`complex`），每档有 `upstreamModel`、`maxContextTokens`、`maxOutputTokens`。价格统一放在公开模型上，不随档位变。
2. `preparedRequest` 里按规则挑档位：有 `tools`，或输入估算超过阈值，或请求里已有 `function_call_output`（说明在多轮工具对话中）→ 复杂档；否则简单档。规则要写成纯函数并充分测试。
3. 预扣按**两档里较大的上限**算，保证不会少扣；结算按统一单价乘实际 token。
4. 记录实际用的上游模型到请求表（新增一列，要写迁移，当前最新是 `0013_account_ai_points.sql`），便于对账和后台展示。
5. 客户端的模型目录（`/v1/ai/models`）仍只显示一个模型。
6. 要有"上游某档失败时是否降级到另一档"的决定，用户没说过，**开工前要问**。
7. 注意：上游那个 key 现在只能用 `gpt-6-luna`、`gpt-6.1-sol`、`gpt-6-astra` 三个（`deepseek-v4.1-flash` 返回 403）。

**验收**：控制平面的测试覆盖路由规则、预扣取较大值、结算金额、响应里模型名不泄露；再在装好的软件里跑一遍所有 bot 对话和总管委派。

---

## 4. 网关管理后台 `/admin`——只定了方案，没开始

**需求**（用户确认过）：账号和 AI 开关、积分管理；安装和设备列表；远程管理 bot。

**现状**：
- 只有命令行工具 `gateway/scripts/account-ai-admin.mjs`（原 `scripts/account-ai-admin.mjs`），调用 `/v1/operator/ai/*`：`account`、`balance`、`requests`（查账号、开关 AI、充积分、结算停留的请求）。
- 管理员身份来自配置 `operatorIds`（Worker 里是 `AI_OPERATOR_USER_IDS`）。
- 没有任何网页界面。

**要做的**：
1. 在 Worker 里加 `/admin` 的页面和接口（静态页面加 `/v1/operator/*` 的新接口），权限只给 `operatorIds` 里的账号，沿用现有的登录会话。
2. 账号：列表、搜索、AI 开关、查看和调整积分、查看请求流水、处理停留的 `review` 请求（现在要用命令行结算）。
3. 安装和设备：列出 `account_ai_tokens`、installations 表里的设备，能撤销令牌。
4. 远程管理 bot：需要通过网关的 `/v1/companion/*` 中继到该账号的桌面端，范围和权限边界要先和用户确认。
5. 所有写操作要有审计记录（现有 `account_ai_adjustments` 表可参考）。
6. 测试和安全评审：越权、CSRF、会话固定。

---

## 5. 安卓端——只定了方案，没开始

**需求**：和电脑端的拖拽语义保持一致，通过现有客户端接口同步，可以操作电脑端 bot 信息。
- Bot 进出部门、部门内排序：`/api/sidebar-sections`、`/api/bots/order`。
- 群成员增减：`/api/groups` 的 `memberIds` 更新。
- 会话进出文件夹：项目和文件夹相关接口。

**现状**：
- 安卓有部门分区，也能把 bot 指派到部门，**没有拖拽**，也**没有**群加人减人、会话进出文件夹的界面。
- 手机通过 `mobile/android/core` 里的 `AccountGateway.kt` 用账号登录网关，再通过网关中继连电脑端。
- 电脑端各动作的真实调用写在 `desktop/src/lib/bot-chat-drop.ts`、`desktop/src/lib/thread-folder-drop.ts`、`desktop/src/components/SidebarBotDrag.tsx`，可对照。
- iOS 有同类缺口，用户这次只提了安卓。

**要做的**：按桌面语义先写协议层（`core` 模块，带单元测试），再做 Compose 界面（长按拖动或菜单），最后用真机或模拟器验证。

---

## 6. 本机环境事项（不是代码，但会影响后续工作）

- **DNS**：本机路由器 DNS 查不到 `api.muzeai.top`，已改成公共 DNS（`223.5.5.5`、`119.29.29.29`），改动在系统网络设置里，要还原的话在"系统设置 → 网络"里删掉。
- **积分**：因断网卡住的请求预扣了积分，已通过管理员接口结算退回；之后又出现的卡住请求只有 `13:29:24` 那条（`stale_reservation`，状态 `review`），可用 `account-ai-admin.mjs` 结算。
- **账号**：`desktop-demo-20261106-174607@example.com`，密码 `Hezuo-3d418128`（已重置，重置前的数据库备份在 `~/hezuo-gateway-db-backup-20261112063418.sqlite`）。它是唯一的管理员（`operatorIds`），AI 已开启，点数余额很大。
- **旧的用户数据目录**：`~/Library/Application Support/OpenMausBot Product.backup-20261112`，只存当天早上的登录状态，确认不需要后可以删。
- **测试遗留数据**：用户真实数据里留有测试时建的 bot `Pickle` 和群 `Luna & co.`；"新部门"可双击改名或删除。用户已知并说是自己在拖动测试。
- **已装应用**：`/Applications/Hezuo.app`（`com.hezuo.product`，0.1.139，未签名，固定连 `https://127.0.0.1:18487`，只适合本机自用）。旧版本在废纸篓里（`Hezuo-0.1.139-old-*.app`）。
- **驱动已装应用的调试脚本**（在 `/tmp`，重启会丢）：`hz-drive.mjs`（CDP 求值、点击、截图）、`hz-clickxy.mjs`（按坐标点击）、`hz-drag.mjs`（原生拖拽）。启动参数 `--remote-debugging-port=9556`，页面在 `http://127.0.0.1:8799/`。
- **已知的、与本工作无关的失败测试**：`desktop/server/drivers/codex.test.ts`（whop-env）；之前还有 `server/system-prompt.test.ts`、`server/index.test.ts` 的 persona 用例、`scripts/ci-scope.test.ts`，都是品牌改名后断言没跟上，基线就已失败。
- **全量 vitest 太慢**（约 30 分钟只跑了 62/2200 个文件），只跑相关目录。
- **`pnpm typecheck` 和 `pnpm lint`** 在 `companion/`、`electron/gateway-companion-tunnel.mjs`、`scripts/local-gateway/` 上拆分前就失败，见根 `AGENTS.md`。
- **所有改动没推送**，只有本地的 3 个修复提交。

---

## 7. 背景：已经完成的（不用再做）

三个已提交的修复，每个都在装好的软件里实测过：

| 提交 | 内容 |
|---|---|
| `8fc4123ea` | 打包版启动报错：`ws` 和 `scripts/` 里的模块不在 asar 里；新增 `electron/companion-relay-frames.mjs`、`electron/vendor/ws.cjs`、打包导入检查测试。网关前端把 Node 自带的 `Request` 传给 Miniflare 导致所有请求 502，已改成传 URL 和选项 |
| `a87395607` | 对话稳定性：`ai_busy` 时排队等槽位（最多 10 分钟）；流中断自动重试 2 次；网关把上游真实错误码和原因带给客户端并记一行日志；总管委派后空回复不再报红字 |
| `0b9b8f094` | 拖拽：Bot 进出部门和群；成员头像拖出群；会话进出文件夹；空部门放置区；"移出部门"改成浮层；群成员超过 3 个时悬停展开；找回登录模式下的"新建机器人"入口 |

实测结果：登录、退出、错误密码、Bot 对话、群聊、总管把任务派给 3 个 bot 并汇总都通过。

---

## 8. 建议的执行顺序

1. 先做完或撤回目录拆分（第 1 节），因为后面所有开发都建立在最终目录结构上。
2. 写架构和配置文档（第 2 节）。
3. 混合计费（第 3 节）→ 管理后台（第 4 节）→ 安卓（第 5 节）。
4. 每一步结束都：跑相关测试，重新打包，装到 `/Applications`，在装好的软件里实测，再提交（不推送）。
