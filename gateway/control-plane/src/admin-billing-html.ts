export const adminBillingHTML = `
<section id="billing-view" hidden aria-labelledby="billing-title">
  <div class="page-heading"><div><p class="eyebrow">TASK-AWARE BILLING</p><h1 id="billing-title">智能计费</h1><p class="muted">启发式任务评估、模型能力配置与有界价格控制。</p></div><button id="billing-reload" type="button">重新读取策略</button></div>
  <section class="card"><h2>计价边界</h2><p>采购成本由运营者提供的费率估算，并非供应商账单。保守估算不等于已确认成本，未知成本不得视为零。目标毛利不保证实现，也不代表扣除全部经营费用后的净利润。</p><p>积分与 USD 的换算仅用于估值，不提供现金兑付、充值收款或支付履约。预占积分不是已结算收入。每次请求使用接入时锁定的快照，修改策略不改变进行中的请求。</p></section>
  <section class="card"><div class="card-heading"><h2>策略与模型能力</h2><span id="billing-revision" class="tag">未读取</span></div><p id="billing-message" class="message" role="status" aria-live="polite"></p>
  <form id="billing-form"><fieldset id="billing-fields" disabled><legend>计费策略（比例单位为基点，10000 = 100% / 1 倍）</legend>
    <label><input id="billing-enabled" type="checkbox"> 启用任务感知计费</label>
    <div class="form-grid">
      <label>估值币种<input id="billing-currency" value="USD" readonly></label>
      <label>每 USD 积分数<input id="billing-pointsPerCurrency" type="number" min="1" step="1" required></label>
      <label>目标毛利（基点）<input id="billing-targetMarginBps" type="number" min="0" max="9999" step="1" required></label>
      <label>运营风险附加（基点）<input id="billing-overheadBps" type="number" min="0" step="1" required></label>
      <label>最小倍率（基点）<input id="billing-minMultiplierBps" type="number" min="1" step="1" required></label>
      <label>最大倍率（基点）<input id="billing-maxMultiplierBps" type="number" min="1" step="1" required></label>
      <label>最大调整步长（基点）<input id="billing-maxStepBps" type="number" min="1" step="1" required></label>
      <label>最少样本数<input id="billing-minSamples" type="number" min="1" step="1" required></label>
      <label>调整冷却（秒）<input id="billing-cooldownSeconds" type="number" min="1" step="1" required></label>
      <label>统计窗口（分钟）<input id="billing-windowMinutes" type="number" min="1" step="1" required></label>
    </div>
    <h3>模型能力档案</h3><p class="footnote">仅选择已保存的渠道模型，最多 50 项。配置能力不会自动发布或启用模型；自动路由还会检查渠道状态、协议与上下文限制。未配置或无采购费率的显式模型保留原计价方式。</p>
    <div id="billing-profiles"></div><button id="billing-add-profile" type="button">增加模型档案</button>
    <label for="billing-reason">保存原因（必填）</label><input id="billing-reason" maxlength="500" required autocomplete="off">
    <button id="billing-save" class="primary" type="submit">保存策略</button>
  </fieldset></form></section>
  <section class="card"><div class="card-heading"><h2>实时估算指标</h2><button id="billing-refresh" type="button">刷新指标</button></div><p id="billing-metrics-message" class="message" role="status" aria-live="polite">仅在此页可见且已登录时，每 15 秒读取。</p><div id="billing-facts" class="facts"></div><p class="footnote">窗口最多取最近 1000 条动态计费记录；成本已知的已结算样本用于收入、估算毛利和毛利率，未知成本与复核请求单独显示，不计为免费利润。</p>
    <div class="table-scroll"><table><caption>按模型汇总</caption><thead><tr><th>模型</th><th>样本 / 结算 / 复核 / 未知</th><th>扣费积分</th><th>估算成本 USD</th><th>平均耗时 ms</th></tr></thead><tbody id="billing-model-rows"></tbody></table></div>
    <div class="table-scroll"><table><caption>最近请求（不包含提示词或密钥）</caption><thead><tr><th>请求 / 实际模型</th><th>复杂度</th><th>状态</th><th>扣费积分</th><th>成本 USD / 证据</th><th>耗时 ms</th><th>时间</th></tr></thead><tbody id="billing-recent-rows"></tbody></table></div>
  </section>
  <section class="card"><h2>只读采购费率</h2><p class="footnote">单位：USD / 百万 tokens。输入总数包含互斥的缓存读取、普通写入和一小时写入；空费率表示未提供，不是免费。长上下文、时间与服务档位条件由服务端提供，本页不修改费率或推断汇率。</p><p id="billing-tariff-message" class="message" role="status"></p><div class="table-scroll"><table><caption>运营者提供的估算采购价</caption><thead><tr><th>模型 / 条件</th><th>输入</th><th>输出</th><th>缓存读取</th><th>缓存写入</th><th>一小时写入</th></tr></thead><tbody id="billing-tariff-rows"></tbody></table></div></section>
</section>`;
