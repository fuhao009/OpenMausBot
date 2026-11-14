export const adminChannelScript = String.raw`
  const channelUI = (() => {
    let catalog = null;
    let saved = null;
    let dirty = false;
    let busy = false;
    let mustReload = false;
    let generation = 0;
    let editingChannel = null;
    const formDirty = { channel: false, model: false };
    let editingModel = null;
    let savingPayload = null;
    const modelFields = {
      label: "model-label", upstreamModel: "model-upstream", protocol: "model-protocol",
      pricingVersion: "model-pricing-version", inputMicroPointsPerMillion: "model-input-price",
      cachedInputMicroPointsPerMillion: "model-cached-price", outputMicroPointsPerMillion: "model-output-price",
      maxContextTokens: "model-context", maxOutputTokens: "model-output"
    };
    const numericFields = { inputMicroPointsPerMillion: true, cachedInputMicroPointsPerMillion: true, outputMicroPointsPerMillion: true, maxContextTokens: true, maxOutputTokens: true };
    function locks() {
      $("catalog-editors").disabled = busy || mustReload || !catalog;
      $("catalog-save").disabled = busy || mustReload || !catalog || !dirty;
      $("catalog-reload").disabled = busy;
      $("catalog-reason").disabled = busy || mustReload || !catalog;
      $("logout").disabled = busy || state.mutationBusy;
      text("catalog-dirty", mustReload ? "必须重新读取" : dirty ? "有未保存变更" : catalog ? "与服务器一致" : "未读取");
    }
    function markDirty() { dirty = true; locks(); }
    function clearKeys() {
      $("channel-key").value = "";
      if (savingPayload) for (const channel of savingPayload.channels) delete channel.apiKey;
      if (catalog) for (const channel of catalog.channels) delete channel.apiKey;
    }
    function reset() {
      generation++;
      clearKeys();
      catalog = saved = null;
      dirty = busy = mustReload = false;
      editingChannel = editingModel = null;
      formDirty.channel = formDirty.model = false;
      $("channel-form").reset(); $("model-form").reset();
      $("catalog-reason").value = "";
      for (const id of ["channel-list", "model-list", "discovery-results", "model-channel", "discovery-channel", "catalog-default"]) $(id).replaceChildren();
      text("catalog-revision", "—");
      locks();
    }
    function options(id, entries, current, emptyLabel) {
      const select = $(id);
      select.replaceChildren();
      if (emptyLabel) { const option = node("option", emptyLabel); option.value = ""; select.append(option); }
      for (const [value, label] of entries) { const option = node("option", label); option.value = value; select.append(option); }
      select.value = current || "";
    }
    function action(label, callback, className) {
      const button = node("button", label, className);
      button.type = "button"; button.addEventListener("click", callback); return button;
    }
    function effective(model) { return model.enabled && catalog.channels.some((channel) => channel.id === model.channelId && channel.enabled); }
    function render() {
      const available = catalog.models.filter(effective);
      if (!available.some((model) => model.id === catalog.defaultModel)) catalog.defaultModel = available[0]?.id || null;
      text("catalog-revision", String(catalog.revision));
      const channelList = $("channel-list"); channelList.replaceChildren();
      for (const channel of catalog.channels) {
        const row = node("div", undefined, "catalog-item"); row.dataset.channelId = channel.id;
        const info = node("div"); info.append(node("strong", channel.name), node("p", channel.id + " · " + channel.baseURL, "mono"), node("p", (channel.enabled ? "启用" : "停用") + " · " + (channel.apiKey ? "密钥待更新" : channel.hasKey ? "已配置密钥" : "未配置密钥"), "footnote"));
        row.append(info, action("编辑", () => editChannel(channel.id)), action("删除", () => {
          if (catalog.models.some((model) => model.channelId === channel.id)) { message("catalog-message", "请先删除或重新绑定引用此渠道的模型。", true); return; }
          if (!window.confirm("暂存删除渠道 " + channel.name + "？保存后才会生效。")) return;
          catalog.channels = catalog.channels.filter((item) => item.id !== channel.id);
          if (editingChannel === channel.id) editChannel(null);
          markDirty(); render();
        }, "danger-text")); channelList.append(row);
      }
      if (!catalog.channels.length) channelList.append(node("p", "尚无渠道，请新增。", "muted"));
      const modelList = $("model-list"); modelList.replaceChildren();
      for (const model of catalog.models) {
        const row = node("div", undefined, "catalog-item"); row.dataset.modelId = model.id;
        const status = dirty ? (effective(model) ? "暂存启用" : "暂存未生效") : (effective(model) ? "已发布" : "未生效"); const info = node("div"); info.append(node("strong", model.label), node("p", model.id + " → " + model.channelId + " / " + model.upstreamModel, "mono"), node("p", status + (catalog.defaultModel === model.id ? " · 默认" : "") + " · 输入/缓存/输出 " + model.inputMicroPointsPerMillion + "/" + model.cachedInputMicroPointsPerMillion + "/" + model.outputMicroPointsPerMillion, "footnote"));
        row.append(info, action("编辑", () => editModel(model.id)), action("删除", () => {
          if (!window.confirm("暂存删除模型 " + model.id + "？保存后才会生效。")) return;
          catalog.models = catalog.models.filter((item) => item.id !== model.id);
          if (catalog.defaultModel === model.id) catalog.defaultModel = null;
          if (editingModel === model.id) editModel(null);
          markDirty(); render();
        }, "danger-text")); modelList.append(row);
      }
      if (!catalog.models.length) modelList.append(node("p", "尚无公开模型，发现结果不会自动发布。", "muted"));
      options("model-channel", catalog.channels.map((channel) => [channel.id, channel.name + (channel.enabled ? "" : "（停用）")]), $("model-channel").value, "选择渠道");
      options("catalog-default", catalog.models.filter(effective).map((model) => [model.id, model.label + " · " + model.id]), catalog.defaultModel, "无默认模型");
      options("discovery-channel", saved.channels.map((channel) => [channel.id, channel.name]), $("discovery-channel").value, "选择已保存渠道");
      locks();
    }
    function editChannel(id) {
      editingChannel = id;
      formDirty.channel = false;
      $("channel-form").reset(); $("channel-key").value = "";
      $("channel-id").readOnly = !!id;
      const channel = catalog?.channels.find((item) => item.id === id);
      if (channel) {
        $("channel-id").value = channel.id; $("channel-name").value = channel.name;
        $("channel-url").value = channel.baseURL; $("channel-enabled").checked = channel.enabled;
      }
      text("channel-form-title", id ? "编辑渠道" : "新增渠道");
      text("channel-key-state", channel ? (channel.apiKey ? "有待保存密钥；留空保留本次暂存密钥。" : channel.hasKey ? "已有密钥，不可读取。填写新值即可轮换。" : "必须填写密钥。") : "新渠道必须填写密钥。");
      message("channel-message", "");
    }
    function editModel(id, suggestion) {
      editingModel = id; $("model-form").reset(); $("model-id").readOnly = !!id;
      formDirty.model = false;
      const model = catalog?.models.find((item) => item.id === id);
      if (model) {
        $("model-id").value = model.id;
        for (const [field, element] of Object.entries(modelFields)) $(element).value = model[field];
        $("model-channel").value = model.channelId; $("model-enabled").checked = model.enabled;
        $("model-chat-tokens").value = model.chatMaxTokensField || "max_completion_tokens";
      } else if (suggestion) {
        $("model-upstream").value = suggestion.model;
        $("model-channel").value = suggestion.channelId;
        formDirty.model = true;
        $("model-enabled").checked = false;
      }
      $("model-chat-field").hidden = $("model-protocol").value !== "chat";
      text("model-form-title", id ? "编辑模型" : "新增模型（需明确填写价格与限制）");
      message("model-message", suggestion ? "仅填入上游 ID；请填写公开 ID、计价与限制，明确选择是否发布。" : "");
    }
    async function load(force = false, notice = "") {
      if (busy || (catalog && !force)) return;
      if (dirty && !mustReload && !window.confirm("重新读取将丢弃全部未保存编辑，继续？")) return;
      const run = ++generation; busy = true; locks();
      message("catalog-message", "正在读取配置…");
      try {
        const { body } = await api("/v1/operator/channels");
        if (run !== generation || !state.token) return;
        clearKeys(); saved = structuredClone(body); catalog = structuredClone(body);
        dirty = mustReload = false; $("catalog-reason").value = "";
        editChannel(null); editModel(null); $("discovery-results").replaceChildren();
        message("discovery-message", ""); render();
        message("catalog-message", notice || "已读取服务器配置。编辑暂存后统一保存。");
      } catch (error) {
        if (run === generation) { mustReload = true; message("catalog-message", "读取失败，保存已锁定。请重新读取。" + explain(error), true); }
      } finally { if (run === generation) { busy = false; locks(); } }
    }
    $("channel-form").addEventListener("submit", (event) => {
      event.preventDefault(); if (busy || mustReload || !catalog) return;
      try {
        const id = $("channel-id").value.trim();
        const prior = catalog.channels.find((item) => item.id === editingChannel);
        if (!id || (!editingChannel && catalog.channels.some((item) => item.id === id))) throw new Error("渠道 ID 必须唯一且非空。");
        const url = new URL($("channel-url").value.trim());
        if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("请填写无凭证、查询参数和片段的 HTTPS 地址。");
        const baseURL = url.href.replace(/\/+$/, "");
        const key = $("channel-key").value;
        const savedChannel = saved.channels.find((item) => item.id === id);
        const retained = prior?.apiKey && prior.baseURL === baseURL ? prior.apiKey : undefined;
        if (key && (key.length < 8 || key.length > 512 || /\s/.test(key))) throw new Error("密钥为 8–512 字符且不得包含空白。");
        if (!key && !retained && (!savedChannel?.hasKey || savedChannel.baseURL !== baseURL)) throw new Error("新增渠道或修改地址必须提供新密钥。");
        const channel = { id, name: $("channel-name").value.trim(), baseURL, enabled: $("channel-enabled").checked, hasKey: !!savedChannel?.hasKey };
        if (!channel.name) throw new Error("请填写渠道名称。");
        if (key || retained) channel.apiKey = key || retained;
        if (prior) catalog.channels[catalog.channels.indexOf(prior)] = channel; else catalog.channels.push(channel);
        markDirty(); render(); editChannel(id); message("channel-message", "渠道已暂存，尚未保存到服务器。");
      } catch (error) { message("channel-message", error.message, true); }
    });
    $("model-form").addEventListener("submit", (event) => {
      event.preventDefault(); if (busy || mustReload || !catalog) return;
      try {
        const id = $("model-id").value.trim();
        const prior = catalog.models.find((item) => item.id === editingModel);
        if (!id || (!editingModel && catalog.models.some((item) => item.id === id))) throw new Error("公开模型 ID 必须唯一且非空。");
        const model = { id, channelId: $("model-channel").value, enabled: $("model-enabled").checked };
        for (const [field, element] of Object.entries(modelFields)) {
          const value = $(element).value.trim();
          if (numericFields[field]) {
            if (!/^(0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error("价格和 token 限制必须填写安全范围的非负整数。");
            model[field] = Number(value);
          } else { if (!value) throw new Error("请填写全部模型字段。"); model[field] = value; }
        }
        if (!model.maxContextTokens || !model.maxOutputTokens || model.maxOutputTokens > model.maxContextTokens) throw new Error("输出和上下文限制须大于 0，且输出不能超过上下文。");
        const channel = catalog.channels.find((item) => item.id === model.channelId);
        if (!channel || (model.enabled && !channel.enabled && !(prior?.enabled && prior.channelId === channel.id))) throw new Error("请选择渠道；新发布或重新绑定模型需要启用该渠道。");
        if (model.protocol === "chat") model.chatMaxTokensField = $("model-chat-tokens").value;
        if (prior) catalog.models[catalog.models.indexOf(prior)] = model; else catalog.models.push(model);
        if (catalog.defaultModel === id && !effective(model)) catalog.defaultModel = null;
        markDirty(); render(); editModel(id); message("model-message", "模型已暂存，尚未保存到服务器。");
      } catch (error) { message("model-message", error.message, true); }
    });
    $("catalog-save-form").addEventListener("submit", async (event) => {
      event.preventDefault(); if (busy || mustReload || !catalog || !dirty) return;
      if (formDirty.channel || formDirty.model) { message("catalog-message", "表单仍有未暂存编辑。请先点击对应的暂存按钮，或用新增 / 编辑重置表单后再保存。", true); return; }
      const reason = $("catalog-reason").value.trim();
      if (!reason || reason.length > 500 || /[\x00-\x1f\x7f]/.test(reason)) { message("catalog-message", "请填写 1–500 字符的单行保存原因。", true); return; }
      const enabled = catalog.models.filter(effective);
      if ((enabled.length && !enabled.some((model) => model.id === catalog.defaultModel)) || (!enabled.length && catalog.defaultModel !== null)) { message("catalog-message", "请选择有效默认模型；无有效模型时必须选择无默认模型。", true); return; }
      const run = ++generation;
      busy = true; locks(); message("catalog-message", "正在保存配置，请勿重复提交…");
      const payload = {
        revision: catalog.revision, reason, defaultModel: catalog.defaultModel,
        models: catalog.models.map((model) => {
          const wire = { ...model };
          if (wire.protocol === "responses") delete wire.chatMaxTokensField;
          return wire;
        }),
        channels: catalog.channels.map(({ hasKey, ...channel }) => channel)
      };
      savingPayload = payload;
      try {
        const { body } = await api("/v1/operator/channels", { method: "POST", body: JSON.stringify(payload) });
        if (run !== generation || !state.token) return;
        clearKeys(); saved = structuredClone(body); catalog = structuredClone(body);
        dirty = mustReload = false; $("catalog-reason").value = "";
        editChannel(null); editModel(null); render();
        message("catalog-message", "保存成功。当前显示服务器版本 " + body.revision + "；密钥已从页面清除。");
      } catch (error) {
        if (run !== generation) return;
        clearKeys(); mustReload = true;
        message("catalog-message", error.status === 409 ? "版本冲突：其他运营者已更新配置。必须重新读取，再重新编辑；不会覆盖。" : "保存未确认或被拒绝。密钥已清除，必须重新读取服务器状态后再编辑，不会自动重试。" + explain(error), true);
      } finally {
        for (const channel of payload.channels) delete channel.apiKey;
        if (savingPayload === payload) savingPayload = null;
        if (run === generation) { busy = false; locks(); }
      }
    });
    $("channel-probe").addEventListener("click", async () => {
      const id = $("discovery-channel").value;
      if (!id || busy || mustReload) return;
      const run = generation; const session = state.sessionEpoch;
      $("channel-probe").disabled = true; $("discovery-results").replaceChildren();
      message("discovery-message", "正在读取已保存渠道的模型列表（未保存编辑不参与发现）…");
      try {
        const { body } = await api("/v1/operator/channels/" + encodeURIComponent(id) + "/probe", { method: "POST", body: "{}" });
        if (run !== generation || session !== state.sessionEpoch || !state.token) return;
        message("discovery-message", "发现 " + body.models.length + " 个模型，耗时 " + body.latencyMs + " ms。仅建议，不会自动发布。");
        for (const model of body.models) {
          const row = node("div", undefined, "catalog-item");
          row.append(node("span", model, "mono"), action("填入新增模型", () => { if (busy || mustReload) return; editModel(null, { model, channelId: id }); $("model-upstream").focus(); }));
          $("discovery-results").append(row);
        }
      } catch (error) { if (run === generation && session === state.sessionEpoch) message("discovery-message", "发现失败。" + explain(error), true); }
      finally { $("channel-probe").disabled = false; }
    });
    $("channel-new").addEventListener("click", () => editChannel(null));
    $("model-new").addEventListener("click", () => editModel(null));
    $("model-protocol").addEventListener("change", () => { $("model-chat-field").hidden = $("model-protocol").value !== "chat"; });
    $("catalog-default").addEventListener("change", () => { catalog.defaultModel = $("catalog-default").value || null; markDirty(); });
    $("catalog-reload").addEventListener("click", () => void load(true));
    for (const kind of ["channel", "model"]) $(kind + "-form").addEventListener("input", () => { formDirty[kind] = true; markDirty(); });
    return { load, reset, hasChanges: () => dirty || busy };
  })();
`;
