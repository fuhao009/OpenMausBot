export const adminChannelHTML = `
    <section id="channels-view" hidden aria-labelledby="channels-title">
      <div class="page-heading"><div><p class="eyebrow">CHANNELS &amp; MODELS</p><h1 id="channels-title">渠道与模型</h1><p class="muted">独立配置上游渠道与公开模型。所有编辑先暂存，填写原因后统一保存。</p></div><button id="catalog-reload" type="button">重新读取</button></div>
      <section class="card">
        <div class="card-heading"><h2>配置版本 <span id="catalog-revision">—</span></h2><span id="catalog-dirty" class="tag">未读取</span></div>
        <p id="catalog-message" class="message" role="status" aria-live="polite"></p>
        <p class="footnote">密钥只写入、不回显；页面内存暂存，保存、退出或会话过期即清除。修改地址必须重新填写密钥。渠道为运营者信任的 HTTPS 上游，可访问内部网络，请审慎配置。</p>
        <form id="catalog-save-form" class="search-row"><div class="grow"><label for="catalog-reason">保存原因（必填）</label><input id="catalog-reason" maxlength="500" required autocomplete="off" placeholder="说明本次渠道、模型或价格变更"></div><button id="catalog-save" class="primary" type="submit" disabled>保存全部变更</button></form>
      </section>
      <fieldset id="catalog-editors" class="catalog-editors" disabled>
        <div class="catalog-grid">
          <section class="card"><div class="card-heading"><h2>渠道</h2><button id="channel-new" type="button">新增渠道</button></div><div id="channel-list" class="catalog-list"></div>
            <form id="channel-form" class="catalog-form">
              <h3 id="channel-form-title">新增渠道</h3>
              <label for="channel-id">渠道 ID</label><input id="channel-id" required maxlength="128" autocomplete="off">
              <label for="channel-name">名称</label><input id="channel-name" required maxlength="120" autocomplete="off">
              <label for="channel-url">上游 API 地址（HTTPS）</label><input id="channel-url" type="url" required maxlength="2048" placeholder="https://api.example.com/v1" autocomplete="off">
              <label for="channel-key">API 密钥（留空保留原密钥）</label><input id="channel-key" type="password" minlength="8" maxlength="512" autocomplete="new-password" spellcheck="false"><p id="channel-key-state" class="footnote">新渠道必须填写密钥。</p>
              <label class="check-label"><input id="channel-enabled" type="checkbox" checked>启用渠道</label>
              <button id="channel-stage" type="submit">暂存渠道</button><p id="channel-message" class="message" role="status"></p>
            </form>
          </section>
          <section class="card"><div class="card-heading"><h2>模型</h2><button id="model-new" type="button">新增模型</button></div><div id="model-list" class="catalog-list"></div>
            <form id="model-form" class="catalog-form">
              <h3 id="model-form-title">新增模型</h3>
              <label for="model-id">公开模型 ID</label><input id="model-id" required maxlength="128" autocomplete="off">
              <label for="model-label">显示名称</label><input id="model-label" required maxlength="120" autocomplete="off">
              <label for="model-channel">绑定渠道</label><select id="model-channel" required></select>
              <label for="model-upstream">上游模型 ID</label><input id="model-upstream" required maxlength="256" autocomplete="off">
              <label for="model-protocol">协议</label><select id="model-protocol"><option value="chat">Chat Completions</option><option value="responses">Responses</option></select>
              <div id="model-chat-field"><label for="model-chat-tokens">Chat 输出上限字段</label><select id="model-chat-tokens"><option value="max_completion_tokens">max_completion_tokens</option><option value="max_tokens">max_tokens</option></select></div>
              <label for="model-pricing-version">计价版本</label><input id="model-pricing-version" required maxlength="128" autocomplete="off">
              <p class="footnote">价格单位：每百万 tokens 的整数微积分。必须明确填写，0 表示显式免费。缓存输入是输入的子集。</p>
              <label for="model-input-price">输入价格</label><input id="model-input-price" type="number" min="0" step="1" required>
              <label for="model-cached-price">缓存输入价格</label><input id="model-cached-price" type="number" min="0" step="1" required>
              <label for="model-output-price">输出价格</label><input id="model-output-price" type="number" min="0" step="1" required>
              <label for="model-context">最大上下文 tokens</label><input id="model-context" type="number" min="1" step="1" required>
              <label for="model-output">最大输出 tokens</label><input id="model-output" type="number" min="1" step="1" required>
              <label class="check-label"><input id="model-enabled" type="checkbox">发布 / 启用模型</label>
              <button id="model-stage" type="submit">暂存模型</button><p id="model-message" class="message" role="status"></p>
            </form>
          </section>
        </div>
        <section class="card"><h2>默认模型与发现</h2><label for="catalog-default">默认公开模型（仅启用模型和启用渠道）</label><select id="catalog-default"><option value="">无默认模型</option></select>
          <p class="footnote">存在可用模型时必须选择默认模型。发现只读取已保存渠道的 /models，不保存、发布或修改价格，也不发起推理。</p>
          <div class="search-row"><div class="grow"><label for="discovery-channel">已保存渠道</label><select id="discovery-channel"></select></div><button id="channel-probe" type="button">发现模型</button></div>
          <p id="discovery-message" class="message" role="status"></p><div id="discovery-results" class="catalog-list"></div>
        </section>
      </fieldset>
    </section>
`;
