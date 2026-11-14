export const adminBillingScript = String.raw`
  const billingUI = (() => {
    const numeric = ["pointsPerCurrency", "targetMarginBps", "overheadBps", "minMultiplierBps", "maxMultiplierBps", "maxStepBps", "minSamples", "cooldownSeconds", "windowMinutes"];
    let current = null, models = [], dirty = false, policyBusy = false, metricsBusy = false;
    let active = false, generation = 0, metricsGeneration = 0, timer = null;
    function visible() { return active && !document.hidden && !!state.token && !$('workspace').hidden; }
    function valid(run, session) { return run === generation && session === state.sessionEpoch && !!state.token && active; }
    function locks() {
      $('billing-fields').disabled = policyBusy || !current;
      $('billing-reload').disabled = policyBusy;
      $('billing-refresh').disabled = metricsBusy || !visible();
    }
    function changed() { dirty = true; }
    function stop() { clearTimeout(timer); timer = null; metricsGeneration++; }
    function schedule() { clearTimeout(timer); timer = visible() ? setTimeout(() => void metrics(), 15000) : null; }
    function pause() { active = false; generation++; if (policyBusy) { current = null; dirty = false; } stop(); locks(); }
    function reset() {
      pause(); current = null; models = []; dirty = false;
      $('billing-form').reset(); $('billing-profiles').replaceChildren();
      for (const id of ['billing-facts', 'billing-model-rows', 'billing-recent-rows', 'billing-tariff-rows']) $(id).replaceChildren();
      text('billing-revision', '未读取'); message('billing-message', ''); message('billing-metrics-message', '未读取'); message('billing-tariff-message', '未读取'); locks();
    }
    function profileRow(profile = { modelId: '', capacity: 'standard', tools: false, vision: false }) {
      const row = node('div', undefined, 'catalog-item'); row.dataset.billingProfile = '';
      const modelLabel = node('label', '已保存模型'); const select = node('select'); select.dataset.field = 'modelId'; select.required = true;
      const placeholder = node('option', '选择已保存模型'); placeholder.value = ''; select.append(placeholder);
      for (const model of models) {
        const option = node('option', model.id + ' · ' + model.channelId + (model.enabled ? '' : '（模型停用）')); option.value = model.id; select.append(option);
      }
      if (profile.modelId && !models.some((item) => item.id === profile.modelId)) { const missing = node('option', profile.modelId + '（已不在保存的目录中，请替换或移除）'); missing.value = profile.modelId; select.append(missing); }
      select.value = profile.modelId; modelLabel.append(select);
      const capacityLabel = node('label', '能力档位'); const capacity = node('select'); capacity.dataset.field = 'capacity';
      for (const [value, label] of [['simple', '简单'], ['standard', '标准'], ['complex', '复杂']]) { const option = node('option', label); option.value = value; capacity.append(option); } capacity.value = profile.capacity; capacityLabel.append(capacity);
      row.append(modelLabel, capacityLabel);
      for (const [key, label] of [['tools', '工具'], ['vision', '图像']]) { const wrapper = node('label', label); const input = node('input'); input.type = 'checkbox'; input.dataset.field = key; input.checked = profile[key]; wrapper.prepend(input); row.append(wrapper); }
      const remove = node('button', '移除', 'danger-text'); remove.type = 'button'; remove.addEventListener('click', () => { row.remove(); changed(); }); row.append(remove); $('billing-profiles').append(row);
    }
    function renderPolicy(body) {
      current = body; dirty = false;
      text('billing-revision', '版本 ' + body.revision + ' · 当前倍率 ' + (body.controller.multiplierBps / 10000).toFixed(4) + ' · ' + body.controller.reason);
      $('billing-enabled').checked = body.policy.enabled; $('billing-currency').value = body.policy.currency;
      for (const key of numeric) $('billing-' + key).value = body.policy[key];
      $('billing-profiles').replaceChildren(); for (const profile of body.policy.profiles) profileRow(profile);
      $('billing-reason').value = '';
    }
    async function load(force = false, notice = '') {
      if (!active || !state.token || policyBusy || (current && !force)) return;
      if (dirty && !window.confirm('重新读取将丢弃未保存的计费策略，继续？')) return;
      const run = generation, session = state.sessionEpoch; policyBusy = true; locks(); message('billing-message', '正在读取策略与已保存模型…');
      try {
        const [{ body }, { body: catalog }] = await Promise.all([api('/v1/operator/billing'), api('/v1/operator/channels')]);
        if (!valid(run, session)) return;
        models = catalog.models; renderPolicy(body); message('billing-message', notice || '已读取服务端策略。修改仅影响后续请求。');
      } catch (error) { if (valid(run, session)) message('billing-message', explain(error), true); }
      finally { policyBusy = false; locks(); if (active && run !== generation && !current) void load(); }
    }
    function payload() {
      const policy = { enabled: $('billing-enabled').checked, currency: 'USD', profiles: [] };
      for (const key of numeric) { const value = Number($('billing-' + key).value); if (!Number.isSafeInteger(value) || value < 0) throw new Error('所有数值须为非负安全整数；具体范围由服务端校验。'); policy[key] = value; }
      const rows = [...$('billing-profiles').children]; if (rows.length > 50) throw new Error('模型档案最多 50 项。');
      const ids = new Set();
      for (const row of rows) {
        const get = (field) => row.querySelector('[data-field="' + field + '"]'); const modelId = get('modelId').value;
        if (!models.some((model) => model.id === modelId) || ids.has(modelId)) throw new Error('请选择已保存且不重复的模型。'); ids.add(modelId);
        policy.profiles.push({ modelId, capacity: get('capacity').value, tools: get('tools').checked, vision: get('vision').checked });
      }
      const reason = $('billing-reason').value.trim(); if (!reason || reason.length > 500 || /[\x00-\x1f\x7f]/.test(reason)) throw new Error('请填写 1–500 字符的单行操作原因。');
      return { revision: current.revision, reason, policy };
    }
    async function save() {
      if (!current || policyBusy || !active) return;
      let input; try { input = payload(); } catch (error) { message('billing-message', error.message, true); return; }
      const run = generation, session = state.sessionEpoch; policyBusy = true; locks(); message('billing-message', '正在保存策略…');
      let conflict = false;
      try { const { body } = await api('/v1/operator/billing', { method: 'POST', body: JSON.stringify(input) }); if (!valid(run, session)) return; renderPolicy(body); message('billing-message', '保存成功，已显示服务端策略版本 ' + body.revision + '。'); }
      catch (error) { if (!valid(run, session)) return; conflict = error.status === 409; if (conflict) { dirty = false; current = null; } message('billing-message', error.network ? '保存结果未知，请重新读取服务端策略核对；不要把此提示当作保存成功。' : explain(error), true); }
      finally { policyBusy = false; locks(); if (active && (conflict || (!current && run !== generation))) void load(true, conflict ? '版本冲突：未保存本次修改，已重新读取最新策略。' : ''); }
    }
    function usd(value) { return value == null ? '未知' : (Number(value) / 1000000).toLocaleString('en-US', { maximumFractionDigits: 6 }); }
    function cellRow(values) { const row = node('tr'); for (const value of values) row.append(node('td', String(value))); return row; }
    function renderMetrics(body) {
      facts($('billing-facts'), [
        ['窗口 / 样本', body.windowMinutes + ' 分钟 / ' + body.sampleCount], ['已结算 / 待复核 / 成本未知', body.settledCount + ' / ' + body.reviewCount + ' / ' + body.unknownCostCount],
        ['已扣费积分（非预占）', points(body.chargedMicroPoints)], ['估值换算（非现金兑付）', body.pointsPerCurrency + ' 积分 / ' + body.currency],
        ['已知成本样本 · 估算收入 USD', usd(body.estimatedRevenueMicroCurrency)], ['已知成本样本 · 估算成本 USD', usd(body.estimatedCostMicroCurrency)],
        ['已知成本样本 · 估算毛利 USD（非净利）', usd(body.estimatedProfitMicroCurrency)], ['估算毛利率', body.estimatedMarginBps == null ? '未知 / 样本不足' : (body.estimatedMarginBps / 100).toFixed(2) + '%'],
        ['当前倍率', (body.multiplierBps / 10000).toFixed(4) + ' 倍'], ['上次调整', date(body.lastAdjustedAt)], ['控制器原因', body.adjustmentReason || '未提供']
      ]);
      const modelRows = $('billing-model-rows'); modelRows.replaceChildren();
      for (const model of body.models) modelRows.append(cellRow([model.model, model.sampleCount + ' / ' + model.settledCount + ' / ' + model.reviewCount + ' / ' + model.unknownCostCount, points(model.chargedMicroPoints), usd(model.estimatedCostMicroCurrency), model.latencyAvgMs ?? '未知']));
      if (!body.models.length) modelRows.append(cellRow(['窗口内暂无模型样本', '—', '—', '—', '—']));
      const recent = $('billing-recent-rows'); recent.replaceChildren();
      for (const request of body.recent) recent.append(cellRow([request.id + ' / ' + request.model, ({ simple: '简单', standard: '标准', complex: '复杂' })[request.complexity] || '未知', labels[request.state] || request.state, points(request.chargedMicroPoints), (request.costStatus === 'unknown' ? '未知' : usd(request.costMicroCurrency)) + ' / ' + (({ estimated: '估算', conservative: '保守估算', unknown: '未知' })[request.costStatus] || '未知'), request.latencyMs ?? '未知', date(request.createdAt)]));
      if (!body.recent.length) recent.append(cellRow(['窗口内暂无请求', '—', '—', '—', '—', '—', '—']));
      renderTariffs(body.tariffs);
    }
    function renderTariffs(tariffs) {
      const rows = $('billing-tariff-rows'); rows.replaceChildren();
      for (const tariff of tariffs) {
        const condition = tariff.id + ' · ' + tariff.condition + ' · 档位：' + tariff.tiers.join(', ');
        for (const [rates, length] of [[tariff.rates, tariff.longRates ? ' · 基础长度段' : ''], ...(tariff.longRates ? [[tariff.longRates, ' · 总输入 ' + (tariff.longInclusive ? '≥ ' : '> ') + tariff.longThreshold]] : [])]) {
          rows.append(cellRow([condition + length, usd(rates.input), usd(rates.output), usd(rates.cached), rates.write == null ? '未提供' : usd(rates.write), rates.writeHour == null ? '未提供' : usd(rates.writeHour)]));
        }
      }
      message('billing-tariff-message', tariffs.length ? '运营者提供的估算价，非账单；优先 / 快速等档位条件见各行说明。' : '服务端未提供费率；不得视为零成本。');
    }
    async function metrics() {
      if (!visible() || metricsBusy) return;
      clearTimeout(timer); timer = null; metricsBusy = true; locks();
      const run = metricsGeneration, session = state.sessionEpoch;
      try { const { body } = await api('/v1/operator/billing/metrics'); if (run !== metricsGeneration || session !== state.sessionEpoch || !visible()) return; renderMetrics(body); message('billing-metrics-message', '读取于 ' + date(Date.now()) + '；页面可见时每 15 秒刷新。'); }
      catch (error) { if (run === metricsGeneration && session === state.sessionEpoch && visible()) message('billing-metrics-message', '刷新失败，已显示数据可能过期：' + explain(error), true); }
      finally { metricsBusy = false; locks(); if (visible() && run !== metricsGeneration) void metrics(); else schedule(); }
    }
    function enter() { active = true; generation++; stop(); locks(); void load(!dirty); void metrics(); }
    $('billing-form').addEventListener('input', changed);
    $('billing-form').addEventListener('change', changed);
    $('billing-form').addEventListener('submit', (event) => { event.preventDefault(); void save(); });
    $('billing-reload').addEventListener('click', () => void load(true));
    $('billing-refresh').addEventListener('click', () => void metrics());
    $('billing-add-profile').addEventListener('click', () => { if ($('billing-profiles').children.length >= 50) { message('billing-message', '模型档案最多 50 项。', true); return; } profileRow(); changed(); });
    document.addEventListener('visibilitychange', () => { stop(); locks(); if (visible()) void metrics(); });
    window.addEventListener('pagehide', pause);
    return { enter, pause, reset, hasChanges: () => dirty, isBusy: () => policyBusy };
  })();
`;
