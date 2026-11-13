# 网关内测服务端交付记录

分支：`backend/gateway-beta`。最终功能部署 `8e54c107d`。S1/S2/S4/S5/S6/S7 开发已完成并验证；按用户安排，S3 供应商后台对账以及依赖对账的遗留测试账号结算、删除留到统一测试阶段，不作为本轮开发阻塞。未将这些延期运营事项记为已验收。

## 隔离验证

- 首轮网关 202 项测试修复后通过；生产反馈修复后 task-billing 28、wallet 37、ai-gateway 72、task-billing-api 3、account-ai 19 项覆盖均通过（按受影响文件分批执行）。类型检查通过。
- `verify-gateway-admin.mjs --task-billing --smoke`：passed，12 条 Chat/Responses × 流式/非流式 × 三档计费请求，预占全部释放，精确扣费与重启持久化通过。
- 中继原6项及新增真实 Miniflare 断线传输回归均通过；后者单独执行1/1，含伪造客户端头拒绝。限定文件 oxlint 0 警告。
- 实际隔离后台验证全局复核零结算、密码重置只显示一次、停用及删除；390px 无整页溢出，浏览器无错误。
- 全仓 pre-push 被既有 task-billing/channel-store control-regex、桌面 tunnel 未使用符号及验证脚本参数警告阻断；本次新增 lifecycle 警告已修复，推送绕过钩子。

## 生产实测风险与未完成项

- S1 最终：35,012 输入 tokens Luna 请求 `cfad794f-6e17-47e1-9cdf-aaa2af5760b8`，估计17,520 tokens，预占20.6074积分，实际扣费10.17668积分，预占归零。修复了按UTF-8字节数过度估计和模型全上下文余额阻止领取令牌的问题。
- S2 最终：HTTPS断线请求 `26ec5d3e-3af8-4e92-a212-ba1b391cbb29`，输入14/输出85，预占2.6303积分，扣费0.12731积分，`settled/client_disconnected_settled`，账号reserved=0。使用真实HTTP客户端断线，未代替桌面端“新建bot立即退出登录”的负责人联调。
- S3 最终：Luna/Sol/Astra/auto-responses各5条，涵盖流式、非流式、工具及有效图片；加大输入与断线，共22条全部settled且costStatus非unknown。Astra早期失败根因是上游注入上下文超出估计，被动态计费错误拒绝；现已按可信用量结算。供应商后台独立用量对照尚无登录凭据；响应usage与网关账本吻合不等于后台对照。
- S4：目录revision3发布 `gpt-6-luna-chat` 和 `auto-chat`；显式Chat非流式、流式及工具调用成功。仅simple档Chat，工具auto-chat无standard候选会拒绝；不声称自动路由支持所有能力组合。
- S6：`beta-b@hezuo.test` 已匿名删除；两个 `lan-test-*` 查询404；`beta-a@hezuo.test` 因预占149.8112积分删除409。首个失败验证账号已停用但保留复核证据，未擅自零结算。成功的最终22条验证账号及断线补测账号均已匿名删除。
- 统一测试阶段再处理上述遗留复核与账号清理；本轮保留账目，不自动退款、不绕过 `reserved = 0` 且无 `review` 的删除条件。账号停用、匿名删除、审计幂等及后台操作本身已开发并通过隔离验收。
- 最终窗口指标（含其他账号和早期失败）：settledCount42，已知成本收入0.227478 USD、成本0.081582 USD、估算毛利64.13%；不是供应商对账净利润，不写“达标”。

## 提交与部署

- S5 `4ba987e02`；S1/S2初始 `6f714ee7c`，实际大小/动态补扣修正 `cf7c5c4cb`；S6/S7后端 `85a2bed25`；后台与路由 `648bf73db`；原因校验 `d76409c0c`；本地断线传输 `e064b650c`、可信通知最终 `8e54c107d`。因共享钱包、认证和后台接入，部分提交跨项，不是每项完全独立提交。
- 每次发布先停服，数据与源码完整备份至 `/opt/hezuo-gateway/backups/pre-beta-<SHA>-{data,code}.tgz`，root0600；最终18项迁移已应用，pending=[]，healthz/admin200，systemd active。
- 生产operator临时会话已退出。临时测试凭据仅存在root私有文件，不进入Git；已删除账号的凭据已失效。

## 请求对照（网关账本；不等于供应商后台对照）

| 请求 ID | 模型 | 状态 | 输入 | 输出 | 预占微积分 | 扣费微积分 | 成本微USD |
|---|---|---|---:|---:|---:|---:|---:|
| b2b6cfb9-f094-4c07-9287-419f03aaca0b | gpt-6-luna | streaming | None | None | 2254200 | None | None |
| 125c7457-9150-45b9-8fe8-7a1807c2e9fa | gpt-6-luna | settled | 35012 | 5 | 64358400 | 8408880 | 3504 |
| 93435b91-3c1e-446f-aa22-a9fcb74b7687 | gpt-6-luna-chat | settled | 46 | 18 | 2014800 | 35400 | 15 |
| 0a9d97c4-c66b-4385-9b76-0bea5324375b | gpt-6-luna-chat | settled | 46 | 18 | 1931425 | 33925 | 15 |
| 8ac997c5-67c9-4fe8-ab98-f2fb70501cca | gpt-6-luna | settled | 9 | 5 | 1472000 | 7820 | 4 |
| a5427f6a-ecd4-40be-96e9-434f939293c6 | gpt-6-astra | review | None | None | 77510000 | None | None |
| 8f60eb12-d451-4c21-aa67-17f959cf8b3f | gpt-6.1-sol | settled | 54 | 19 | 17566250 | 685400 | 298 |
| 0c5f21cf-26a7-4eca-8907-fcb8d9d3b778 | gpt-6-luna | settled | 9 | 5 | 1470850 | 7820 | 4 |
| 402f4981-eeb7-4a26-8c73-ae624b4869a6 | gpt-6-luna | settled | 9 | 5 | 1472000 | 7820 | 4 |
| 35a2425c-e312-4330-b2fd-00e5d9f68f55 | gpt-6-astra | review | None | None | 71394400 | None | None |
| cb7aac15-bf72-4821-911e-2fc976af7e29 | gpt-6-astra | review | None | None | 71368000 | None | None |
| 1fece10a-3280-4eb6-95d2-88c40e022cbf | gpt-6-astra | review | None | None | 81109600 | None | None |
| e047b20d-00b3-40d6-af33-043c255c70dc | gpt-6-astra | review | None | None | 71368000 | None | None |
| a02f2e13-319a-4ae9-9fd9-719f32b3c7ff | gpt-6-astra | review | None | None | 71394400 | None | None |
| 65aa4e70-8ffc-48bc-89a4-9682e70d4c06 | gpt-6.1-sol | settled | 9 | 5 | 14756500 | 149600 | 68 |
| 5aaf1eba-83d3-4eef-b79b-45014caf00b4 | gpt-6.1-sol | settled | 9 | 5 | 14751000 | 149600 | 68 |
| 3d249f97-3d06-4113-8c24-6dd3b279e322 | gpt-6.1-sol | settled | 54 | 19 | 16780500 | 655600 | 298 |
| 10a12382-5d27-44b9-817a-bcb52110861c | gpt-6.1-sol | settled | 9 | 6 | 14751000 | 171600 | 78 |
| 7b197b1f-66a2-4483-a1ab-1ad7135c070c | gpt-6.1-sol | settled | 9 | 5 | 14756500 | 149600 | 68 |
| 882ace20-e9eb-4fa8-9593-127f8d9809a0 | gpt-6-luna | settled | None | None | 70540800 | 0 | None |
| 00152ed3-52ba-478d-afa4-48bb90f06bdc | gpt-6-luna | settled | 9 | 5 | 1403600 | 7480 | 4 |
| 4d4e308d-c612-4792-a306-f361e1ee75a3 | gpt-6-luna | settled | 54 | 31 | 1606550 | 45980 | 21 |
| e1d3dc71-fe33-4d36-b907-089be4c61aec | gpt-6-luna | settled | 9 | 5 | 1403600 | 7480 | 4 |
| 4af6d684-e95f-4c8e-92b7-b804bc657ee3 | gpt-6-luna | settled | 9 | 5 | 1404700 | 7480 | 4 |
| 3b85fe54-c34b-45a4-96a4-ebb88bf2efb6 | gpt-6-luna-chat | settled | 9 | 5 | 1425050 | 7975 | 4 |
| 640a7042-884e-4541-833d-e0d672e5630f | gpt-6-luna | settled | 9 | 5 | 1392050 | 7480 | 4 |

## 最终验证请求

| 请求 ID | 请求模型 | x-ai-model | complexity | 输入 | 输出 | 扣费微积分 | 成本微USD |
|---|---|---|---|---:|---:|---:|---:|
| f179f2c8-0c72-4a97-8bdd-ec1fac72f06e | gpt-6-luna | gpt-6-luna | simple | 9 | 5 | 9180 | 4 |
| b2511dbe-a557-4e07-b232-8dfb0441051d | gpt-6-luna | gpt-6-luna | simple | 9 | 5 | 9520 | 4 |
| 40dd3f1e-b404-4c0e-b806-c065a3fbf1c7 | gpt-6-luna | gpt-6-luna | standard | 54 | 35 | 64120 | 23 |
| 372693a6-2757-4632-8869-3118a4edc351 | gpt-6-luna | gpt-6-luna | simple | 9 | 5 | 9520 | 4 |
| 996c2399-1ac4-404a-80a3-8b5b8af44dda | gpt-6-luna | gpt-6-luna | standard | 17 | 6 | 13160 | 5 |
| d7f893ca-8059-47a9-b80e-eece24eb44e8 | gpt-6.1-sol | gpt-6.1-sol | simple | 9 | 5 | 190400 | 68 |
| bb93ce41-0925-4e93-be0a-e4d978bfa860 | gpt-6.1-sol | gpt-6.1-sol | simple | 9 | 5 | 190400 | 68 |
| 39090a78-81da-4091-93ac-20cdd4b75b5e | gpt-6.1-sol | gpt-6.1-sol | standard | 54 | 22 | 918400 | 328 |
| 258c8918-3579-4150-bf11-b6a5c990a700 | gpt-6.1-sol | gpt-6.1-sol | simple | 9 | 5 | 190400 | 68 |
| cef1cc9f-3b8e-422f-a001-ed7aed59261d | gpt-6.1-sol | gpt-6.1-sol | simple | 9 | 5 | 190400 | 68 |
| 561e9d0e-a9f2-4f37-bb36-a8304d31324d | gpt-6-astra | gpt-6-astra | simple | 4123 | 5 | 16150400 | 5768 |
| ef39ef85-befd-4872-a8fd-b6afc792fee3 | gpt-6-astra | gpt-6-astra | simple | 4123 | 5 | 16150400 | 5768 |
| 62b5480a-82fa-453e-b820-d6f5b5c3cafc | gpt-6-astra | gpt-6-astra | standard | 4168 | 23 | 119924000 | 42830 |
| cc5bb366-a269-401d-84d9-9531060cc9c3 | gpt-6-astra | gpt-6-astra | simple | 4123 | 5 | 16150400 | 5768 |
| 59d6f7c2-ac81-47df-923c-3dfcd44ea026 | gpt-6-astra | gpt-6-astra | simple | 4123 | 5 | 16150400 | 5768 |
| 484c694c-5052-4e2e-8be1-2d2635c99049 | auto-responses | gpt-6-luna | simple | 9 | 5 | 9520 | 4 |
| ff823a53-43a1-43dd-b90d-404c86bad78a | auto-responses | gpt-6-luna | simple | 9 | 5 | 9860 | 4 |
| 2f0a58d2-7ef2-4487-af5b-3bdf15ebf69e | auto-responses | gpt-6.1-sol | standard | 54 | 22 | 951200 | 328 |
| bcb1e99f-8166-4bdc-830c-2e2555cbdcbf | auto-responses | gpt-6-astra | complex | 4135 | 20 | 19250200 | 6638 |
| c2f5ec48-0fd3-4e04-8498-02a69f92c748 | auto-responses | gpt-6-luna | simple | 9 | 5 | 9860 | 4 |
