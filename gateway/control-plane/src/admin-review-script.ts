export const adminReviewScript = String.raw`
  const reviewUI = (() => {
    let epoch = 0, page = 0, cursors = [null], next = null, busy = false, pending = null;
    let requests = [];
    const selected = new Set();
    function locks() {
      $("refresh-reviews").disabled = busy || !!pending;
      $("review-prev").disabled = busy || !!pending || page === 0;
      $("review-next").disabled = busy || !!pending || !next;
      $("review-zero").disabled = busy || (!pending && selected.size === 0);
      $("review-reason").disabled = busy || !!pending;
      for (const input of $("review-rows").querySelectorAll("input,button")) input.disabled = busy || !!pending;
      text("review-zero", pending ? "以原操作 ID 重试未完成结算" : "所选请求按零结算");
    }
    function reset() { epoch++; requests = []; selected.clear(); pending = null; busy = false; page = 0; cursors = [null]; next = null; $("review-rows").replaceChildren(); $("review-reason").value = ""; locks(); }
    function render() {
      const rows = $("review-rows"); rows.replaceChildren(); selected.clear();
      for (const request of requests) {
        const tr = node("tr"), choice = node("td"), checkbox = document.createElement("input");
        checkbox.type = "checkbox"; checkbox.setAttribute("aria-label", "选择请求 " + request.id);
        checkbox.addEventListener("change", () => { if (checkbox.checked) selected.add(request.id); else selected.delete(request.id); locks(); });
        choice.append(checkbox);
        const identity = node("td"); identity.append(node("strong", request.email || request.userId), node("span", request.id, "request-id mono"));
        const time = node("td"); time.append(node("span", date(request.createdAt)), node("p", request.settlementReason || "—"));
        const action = node("td"), amount = document.createElement("input"), submit = node("button", "结算");
        amount.type = "text"; amount.inputMode = "decimal"; amount.value = "0"; amount.setAttribute("aria-label", "结算积分 " + request.id);
        submit.type = "button"; submit.addEventListener("click", () => { try { void settle([{ request, amount: parsePoints(amount.value, false) }]); } catch (error) { message("reviews-message", explain(error), true); } });
        action.append(amount, submit); tr.append(choice, identity, node("td", request.model), node("td", points(request.reservedMicroPoints)), time, action); rows.append(tr);
      }
      locks();
    }
    async function load(target = 0) {
      if (busy || pending) return;
      const current = ++epoch, session = state.sessionEpoch; busy = true; locks();
      try {
        const params = new URLSearchParams({ state: "review" }); if (cursors[target]) params.set("cursor", cursors[target]);
        const { body } = await api("/v1/operator/ai/requests?" + params);
        if (current !== epoch || session !== state.sessionEpoch) return;
        requests = body.requests; page = target; next = body.nextCursor; if (next) cursors[page + 1] = next;
        render(); message("reviews-message", requests.length ? "按创建时间倒序。每笔结算独立记录审计。" : "没有待复核请求。");
      } catch (error) { if (current === epoch) message("reviews-message", explain(error), true); }
      finally { if (current === epoch) { busy = false; locks(); } }
    }
    async function settle(items) {
      if (busy) return;
      if (!pending) {
        const reason = $("review-reason").value.trim();
        if (!reason || reason.length > 500 || /[\x00-\x1f\x7f]/.test(reason)) { message("reviews-message", "请填写 1–500 字符的单行结算原因。", true); return; }
        if (!items.length) return;
        if (items.some(({ request, amount }) => amount > (request.settlementReason === "usage_exceeds_reservation" ? request.chargedMicroPoints : request.reservedMicroPoints))) { message("reviews-message", "结算金额不得超过预占或已收取的超额用量款项。", true); return; }
        if (!window.confirm("确认结算 " + items.length + " 笔请求？原因：" + reason)) return;
        pending = { operatorId: state.operator.user.id, items: items.map(({ request, amount }) => ({ id: request.id, body: JSON.stringify({ operationId: crypto.randomUUID(), reason, chargedMicroPoints: amount }) })) };
      }
      if (pending.operatorId !== state.operator?.user.id) { message("reviews-message", "请使用原运营者继续处理。", true); return; }
      busy = true; locks(); const current = epoch;
      try {
        while (pending.items.length) {
          const item = pending.items[0];
          await api("/v1/operator/ai/requests/" + encodeURIComponent(item.id) + "/settle", { method: "POST", body: item.body });
          if (current !== epoch) return;
          pending.items.shift();
        }
        pending = null; busy = false; cursors = [null]; await load(0);
      } catch (error) { if (current === epoch) message("reviews-message", "部分结算可能已完成。" + explain(error) + " 请重试，未完成项目保留原操作 ID。", true); }
      finally { if (current === epoch) { busy = false; locks(); } }
    }
    $("refresh-reviews").addEventListener("click", () => { cursors = [null]; void load(0); });
    $("review-prev").addEventListener("click", () => void load(page - 1));
    $("review-next").addEventListener("click", () => void load(page + 1));
    $("review-zero").addEventListener("click", () => void settle(requests.filter((request) => selected.has(request.id)).map((request) => ({ request, amount: 0 }))));
    return { load, reset, hasPending: () => !!pending || busy };
  })();
`;
