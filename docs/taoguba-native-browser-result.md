# WebContentsView 淘股吧真实模型测试结果

2026-11-14；实际源码 Electron 桌面、隔离账号数据、正常账号网关认证。仅本次测试使用 --mock-keychain，不验证 macOS 系统钥匙串保护。未更新已安装应用。

- Bot：Desktop API Test Bot（a7b024ac-acbf-4976-8d05-13688520a365）。
- 配置模型：product-ai / auto-responses。
- 实际模型：product-ai / gpt-6-astra。
- 任务：打开淘股吧并进入登录页；需要网站凭据或验证时申请用户登录。
- 实际地址：https://www.tgb.cn/（由 https://www.taoguba.com.cn/ 重定向）。
- 任务耗时：37686.41 ms；完整运行约44.05秒。
- 结果：needs-user，无运行错误；登录弹窗已打开，未完成网站登录。

| 步骤 | 实际动作 | 工具耗时 | 结果 |
| --- | --- | ---: | --- |
| 1 | 打开淘股吧 | 2360 ms | 工具返回实际页面标题与元素树 |
| 2 | 点击登录 | 133 ms | 页面出现极速登录、微信扫码、账号登录等内容 |
| 3 | 读取登录弹窗页面 | 51 ms | snapshot 返回4个frame的页面结构 |
| 4 | 截图 | 71 ms | 工具返回1280×800截图；本报告没有保留独立可查看图片，不能以工具文本替代图片验证 |
| 5 | 请求用户登录 | 12 ms | agents_request_sign_in 成功，任务进入needs-user |

上述工具耗时不包含模型推理间隔。派发39.01 ms；提交到首个模型事件136 ms，到首段文本4893 ms，均非完整模型推理耗时。

证据：`.omb-scratch/taoguba-native-result/result.json`。WebContentsView可见页面、隔离、hold与restart另有 `.omb-scratch/embedded-browser-evidence/result.json` 和实际合成窗口截图验证。

测试已关闭并删除临时登录数据，当前不保留可继续扫码的窗口。需要另起受控测试、由用户在网站完成账号/扫码/短信验证，才能核对最终登录状态。Hezuo测试账号不是淘股吧账号，不得混用。
