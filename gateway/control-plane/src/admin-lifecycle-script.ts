export const adminLifecycleScript = String.raw`
  const lifecycleUI = (() => {
    let draft = null, pending = null, busy = false;
    const names = { disable: "停用账号", delete: "删除账号", "reset-password": "重置密码" };
    function clearSecret() { text("temporary-password", ""); $("temporary-password-panel").hidden = true; }
    function reset() { clearSecret(); draft = null; pending = null; busy = false; $("lifecycle-dialog").close(); }
    function open(kind) {
      if (busy) return;
      if (pending) { $("lifecycle-dialog").showModal(); return; }
      if (!state.account) return;
      draft = { kind, userId: state.account.userId, email: state.account.email };
      clearSecret(); $("lifecycle-form").reset(); $("lifecycle-reason").readOnly = false;
      $("lifecycle-submit").hidden = false; $("lifecycle-submit").disabled = false;
      text("lifecycle-title", names[kind]); text("lifecycle-target", draft.email);
      text("lifecycle-warning", kind === "delete" ? "不可撤销。仅无预占且无待复核请求时允许删除；账本保留并匿名化。" : kind === "disable" ? "账号将无法登录，已有会话和模型令牌立即失效。" : "旧密码与所有会话立即失效。临时密码只返回一次；网络丢失时无法再次获取，须核对后重新重置。");
      message("lifecycle-message", ""); $("lifecycle-dialog").showModal();
    }
    function close() { if (busy || pending) { message("lifecycle-message", "操作结果尚未确认，请以原操作 ID 重试。", true); return; } clearSecret(); $("lifecycle-dialog").close(); }
    async function submit() {
      if (busy || !draft) return;
      if (!pending) {
        const reason = $("lifecycle-reason").value.trim();
        if (!reason || reason.length > 500 || /[\x00-\x1f\x7f]/.test(reason)) { message("lifecycle-message", "请填写有效的单行原因。", true); return; }
        if (!window.confirm(names[draft.kind] + "：" + draft.email + "？原因：" + reason)) return;
        pending = { operatorId: state.operator.user.id, body: JSON.stringify({ operationId: crypto.randomUUID(), reason }) };
      }
      if (pending.operatorId !== state.operator?.user.id) { message("lifecycle-message", "请使用原运营者重试。", true); return; }
      busy = true; $("lifecycle-submit").disabled = true; $("lifecycle-reason").readOnly = true;
      try {
        const { body } = await api("/v1/operator/accounts/" + encodeURIComponent(draft.userId) + "/" + draft.kind, { method: "POST", body: pending.body });
        pending = null; $("lifecycle-submit").hidden = true;
        message("lifecycle-message", body.replayed && draft.kind === "reset-password" ? "重置已执行。临时密码不会重复返回，请关闭后重新重置以获取新密码。" : "操作成功。");
        if (body.temporaryPassword) { text("temporary-password", body.temporaryPassword); $("temporary-password-panel").hidden = false; }
        if (draft.kind === "delete") { state.account = null; state.requests = []; $("account-card").hidden = true; $("requests-card").hidden = true; $("account-empty").hidden = false; accountLocks(); }
        else { try { await refreshAccount(); } catch { message("global-message", "操作已完成，账号信息刷新失败，请重新查询。", true); } }
      } catch (error) {
        if (!error.network && error.status < 500 && error.status !== 401 && error.status !== 408) { pending = null; $("lifecycle-reason").readOnly = false; }
        message("lifecycle-message", explain(error) + (pending ? " 重试会复用原操作 ID。" : ""), true);
      } finally { busy = false; $("lifecycle-submit").disabled = false; }
    }
    for (const kind of Object.keys(names)) $("account-" + kind).addEventListener("click", () => open(kind));
    $("lifecycle-close").addEventListener("click", close);
    $("lifecycle-dialog").addEventListener("cancel", (event) => { event.preventDefault(); close(); });
    $("lifecycle-form").addEventListener("submit", (event) => { event.preventDefault(); void submit(); });
    return { reset, clearSecret, hasPending: () => busy || !!pending };
  })();
`;
