import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, RefreshCw, Terminal } from "lucide-react";
import { api, useStore } from "@/state/store";
import { t } from "@/lib/i18n";
import { lacksAdminScope } from "@/lib/admin-scope";
import type { LocaleKey } from "@/locales";
import type { ApproveExecutionTask, CreateExecutionConnector, ExecutionConnector, ExecutionConnectorList, ExecutionLocation, ExecutionTask, ExecutionTool, StartExecutionTask } from "../../shared/execution-connectors";

const tools: { id: ExecutionTool; name: string }[] = [{ id: "claude", name: "Claude Code" }, { id: "codex", name: "Codex" }, { id: "omp", name: "OMP" }];
const button = "ui-button text-[12px] disabled:opacity-40";
const input = "w-full rounded-lg border border-hairline/40 bg-raised/50 px-3 py-2 text-[13px] text-ink focus:outline-none focus:ring-1 focus:ring-focus";
const root = "/api/execution-connectors";
const taskState: Record<ExecutionTask["status"], LocaleKey> = { running: "execution.status.running", approval: "execution.status.awaiting_approval", completed: "execution.status.completed", failed: "execution.status.failed", cancelled: "execution.status.cancelled" };

export function ExecutionConnectorsSection({ search, connectedOnly, onConnections, onConnectedCount }: { search: string; connectedOnly: boolean; onConnections: (connected: boolean) => void; onConnectedCount: (count: number) => void }) {
  const { state } = useStore();
  const [inventory, setInventory] = useState<ExecutionConnectorList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<ExecutionTool | null>(null);
  const [location, setLocation] = useState<ExecutionLocation>("local");
  const [remoteUrl, setRemoteUrl] = useState("");
  const [remoteToken, setRemoteToken] = useState("");
  const [consent, setConsent] = useState(false);
  const [botIds, setBotIds] = useState<string[]>([]);
  const [prompts, setPrompts] = useState<Record<string, string>>({});
  const [taskBots, setTaskBots] = useState<Record<string, string>>({});
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [disconnecting, setDisconnecting] = useState<string | null>(null);
  const generation = useRef(0);
  const alive = useRef(true);
  const busyRef = useRef(false);
  const inventoryError = useRef(false);
  const bots = state.bots.filter((bot) => !bot.hidden);
  const remoteClient = window.ogb?.remoteClient?.active === true;
  const localAvailable = inventory?.localAvailable === true && !remoteClient;
  const canManage = inventory?.canManage === true;
  const refresh = useCallback(async (background = false) => {
    const request = ++generation.current;
    try {
      const next = await api<ExecutionConnectorList>(root, { background });
      if (!alive.current || request !== generation.current) return;
      setInventory(next); setStale(false);
      if (!background || inventoryError.current) setError(null);
      inventoryError.current = false;
    } catch (cause) {
      if (!alive.current || request !== generation.current) return;
      setStale(true);
      inventoryError.current = true;
      setError(lacksAdminScope(cause) ? t("execution.adminOnly") : cause instanceof Error ? cause.message : String(cause));
    }
  }, []);
  useEffect(() => {
    alive.current = true;
    void refresh();
    const timer = setInterval(() => { if (!busyRef.current) void refresh(true); }, 3000);
    return () => { alive.current = false; ++generation.current; clearInterval(timer); };
  }, [refresh]);
  async function mutate(action: () => Promise<unknown>, done?: () => void) {
    if (busyRef.current) return;
    busyRef.current = true; inventoryError.current = false; ++generation.current; setBusy(true); setError(null);
    try { await action(); if (alive.current) done?.(); await refresh(); }
    catch (cause) { if (alive.current) setError(lacksAdminScope(cause) ? t("execution.adminOnly") : cause instanceof Error ? cause.message : String(cause)); }
    finally { busyRef.current = false; if (alive.current) setBusy(false); }
  }
  const matching = tools.filter((tool) => `${tool.name} execution coding 执行 编程`.toLowerCase().includes(search.trim().toLowerCase()));
  useEffect(() => {
    onConnections(Boolean(inventory?.connectors.some((connector) => connector.state === "connected" && matching.some((tool) => tool.id === connector.tool))));
  }, [inventory, search, onConnections]);
  useEffect(() => {
    onConnectedCount(new Set(inventory?.connectors.filter((connector) => connector.state === "connected").map((connector) => connector.tool)).size);
  }, [inventory, onConnectedCount]);
  if (!matching.length) return null;
  function grants(connector?: ExecutionConnector) {
    const selected = connector?.botIds ?? botIds;
    return <fieldset className="space-y-1.5"><legend className="mb-1 text-[12px] font-medium">{t("execution.bot")}</legend>
      {!bots.length && <p className="text-[12px] text-ink-secondary">{t("execution.noBots")}</p>}
      {bots.map((bot) => <label key={bot.id} className="flex items-center gap-2 text-[12px]"><input type="checkbox" checked={selected.includes(bot.id)} disabled={busy || !canManage || stale} onChange={(event) => {
        const next = event.target.checked ? [...selected, bot.id] : selected.filter((id) => id !== bot.id);
        if (connector) void mutate(() => api(`${root}/${encodeURIComponent(connector.id)}`, { method: "PATCH", body: JSON.stringify({ botIds: next }) }));
        else setBotIds(next);
      }} />{bot.name}</label>)}
    </fieldset>;
  }
  function renderTask(task: ExecutionTask) {
    return <div key={task.id} className="space-y-2 rounded-lg border border-hairline/40 p-3 text-[12px]">
      <div className="flex items-center justify-between gap-2"><span>{bots.find((bot) => bot.id === task.botId)?.name ?? task.botId} · {t(taskState[task.status])}</span>
        {(task.status === "running" || task.status === "approval") && <button type="button" className={button} disabled={busy || !canManage} onClick={() => void mutate(() => api(`${root}/tasks/${encodeURIComponent(task.id)}/cancel`, { method: "POST" }))}>{t("execution.cancel")}</button>}
      </div>
      {task.text && <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words font-sans">{task.text}</pre>}
      {task.error && <p role="alert" className="text-danger">{task.error}</p>}
      {task.approvals.map((approval) => <div key={approval.id} className="space-y-2 rounded-lg bg-control p-3">
        <p className="font-medium">{t(approval.kind === "question" ? "execution.question" : "execution.approval")}: {approval.title}</p>
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words">{approval.detail}</pre>
        {approval.kind === "question" && <>
          {approval.choices?.length ? <div className="flex flex-wrap gap-2">{approval.choices.map((choice) => <button key={choice} type="button" className={button} disabled={busy || stale || !canManage} onClick={() => setAnswers((previous) => ({ ...previous, [approval.id]: choice }))}>{choice}</button>)}</div> : null}
          <textarea className={input} rows={2} aria-label={t("execution.answer")} placeholder={t("execution.answer")} value={answers[approval.id] ?? ""} disabled={busy || !canManage} onChange={(event) => setAnswers((previous) => ({ ...previous, [approval.id]: event.target.value }))} />
        </>}
        <div className="flex gap-2">{[true, false].map((allow) => <button key={String(allow)} type="button" disabled={busy || stale || !canManage || (allow && approval.kind === "question" && !answers[approval.id]?.trim())} className={button} onClick={() => {
          const body: ApproveExecutionTask = { requestId: approval.id, allow, ...(allow && approval.kind === "question" ? { answer: answers[approval.id].trim() } : {}) };
          void mutate(() => api(`${root}/tasks/${encodeURIComponent(task.id)}/approve`, { method: "POST", body: JSON.stringify(body) }), () => setAnswers((previous) => { const next = { ...previous }; delete next[approval.id]; return next; }));
        }}>{t(allow ? approval.kind === "question" ? "execution.sendAnswer" : "execution.approve" : "execution.deny")}</button>)}</div>
      </div>)}
    </div>;
  }
  return <section data-product-execution-connectors className="mb-6 space-y-3" aria-labelledby="execution-tools-title">
    <div className="flex items-center justify-between gap-3"><h3 id="execution-tools-title" className="text-[15px] font-semibold text-ink">{t("execution.title")}</h3><button type="button" className={button} disabled={busy} onClick={() => void refresh()}><RefreshCw size={13} className="me-1 inline" />{t("execution.refresh")}</button></div>
    <p className="text-[12px] text-ink-secondary">{t("execution.description")}</p>
    {error && <p role="alert" className="text-[12px] text-danger">{error}</p>}
    {stale && inventory && <p className="text-[12px] text-danger">{t("execution.stale")}</p>}
    {!inventory && !error && <p role="status" className="text-[12px]"><Loader2 size={14} className="me-2 inline animate-spin" />{t("execution.loading")}</p>}
    {inventory && !canManage && <p className="text-[12px] text-ink-secondary">{t("execution.adminOnly")}</p>}
    {inventory && inventory.connectors.length === 0 && <p className="text-[12px] text-ink-secondary">{t("execution.noConnections")}</p>}
    <div className="grid items-start gap-3 sm:grid-cols-2">{matching.map((tool) => {
      const connections = inventory?.connectors.filter((connector) => connector.tool === tool.id) ?? [];
      if (connectedOnly && !connections.some((connector) => connector.state === "connected")) return null;
      return <article key={tool.id} className="min-w-0 space-y-3 rounded-xl border border-hairline/40 bg-menu p-4" data-execution-tool={tool.id}>
        <div className="flex items-center gap-2"><Terminal size={18} /><h4 className="flex-1 text-[14px] font-semibold">{tool.name}</h4><button type="button" className={button} disabled={busy || stale || !canManage} onClick={() => { setEditing(editing === tool.id ? null : tool.id); setConsent(false); setRemoteToken(""); setLocation(localAvailable ? "local" : "server"); setBotIds([]); }}>{t("execution.configure")}</button></div>
        {connections.map((connector) => {
          const allowed = bots.filter((bot) => connector.botIds.includes(bot.id));
          const botId = allowed.some((bot) => bot.id === taskBots[connector.id]) ? taskBots[connector.id] : allowed[0]?.id ?? "";
          return <div key={connector.id} className="space-y-3 border-t border-hairline/40 pt-3">
            <div className="flex flex-wrap items-center justify-between gap-2 text-[12px]"><span>{t(connector.location === "local" ? "execution.local" : "execution.server")} · {t(connector.state === "connected" ? "execution.status.ready" : "execution.status.disconnected")}</span>{connector.state === "connected" && <button type="button" className={button} disabled={busy || !canManage} onClick={() => setDisconnecting(connector.id)}>{t("execution.disconnect")}</button>}</div>
            {disconnecting === connector.id && <div role="group" aria-label={t("execution.disconnect")} className="space-y-2 rounded-lg border border-hairline/40 p-3">
              <p className="text-[12px]">{t("execution.disconnectConfirm")}</p>
              <div className="flex flex-wrap gap-2">
                <button type="button" autoFocus className={button} disabled={busy} onClick={() => setDisconnecting(null)}>{t("organization.keepConnection")}</button>
                <button type="button" className={button} disabled={busy || !canManage} onClick={() => {
                  if (!canManage || busyRef.current) return;
                  void mutate(() => api(`${root}/${encodeURIComponent(connector.id)}`, { method: "DELETE" }), () => setDisconnecting(null));
                }}>{t("execution.disconnect")}</button>
              </div>
            </div>}
            <details className="group rounded-lg bg-raised/40 px-3 py-2">
              <summary className="cursor-pointer text-[12px] font-medium text-ink">{t("execution.configure")}</summary>
              <div className="space-y-3 pt-3">
            {grants(connector)}
            {canManage && <form className="space-y-2" onSubmit={(event) => {
              event.preventDefault();
              const prompt = prompts[connector.id]?.trim() ?? "";
              if (busyRef.current || stale || !canManage || connector.state !== "connected" || !botId || !prompt) return;
              const body: StartExecutionTask = { botId, prompt };
              void mutate(() => api(`${root}/${encodeURIComponent(connector.id)}/tasks`, { method: "POST", body: JSON.stringify(body) }), () => setPrompts((previous) => ({ ...previous, [connector.id]: "" })));
            }}>
              <select className={input} aria-label={t("execution.bot")} value={botId} onChange={(event) => setTaskBots((previous) => ({ ...previous, [connector.id]: event.target.value }))} disabled={busy}>{!allowed.length && <option value="">{t("execution.bot")}</option>}{allowed.map((bot) => <option key={bot.id} value={bot.id}>{bot.name}</option>)}</select>
              <textarea className={input} rows={3} aria-label={t("execution.prompt")} placeholder={t("execution.prompt")} value={prompts[connector.id] ?? ""} onChange={(event) => setPrompts((previous) => ({ ...previous, [connector.id]: event.target.value }))} />
              <button type="submit" className={`${button} ui-button-primary`} disabled={busy || stale || connector.state !== "connected" || !botId || !prompts[connector.id]?.trim()}>{t("execution.start")}</button>
            </form>}
              </div>
            </details>
            {inventory?.tasks.filter((task) => task.connectorId === connector.id).map(renderTask)}
          </div>;
        })}
        {editing === tool.id && <form className="space-y-3 border-t border-hairline/40 pt-3" onSubmit={(event) => {
          event.preventDefault();
          if (busyRef.current || stale || !canManage || !consent || !botIds.length || (location === "local" ? !localAvailable : !remoteUrl.trim() || !remoteToken.trim())) return;
          const body: CreateExecutionConnector = { tool: tool.id, location, consent: true, botIds, ...(location === "server" ? { remoteUrl: remoteUrl.trim(), remoteToken } : {}) };
          void mutate(() => api<ExecutionConnector>(root, { method: "POST", body: JSON.stringify(body) }), () => { setEditing(null); setRemoteToken(""); setConsent(false); });
        }}>
          <select aria-label={t("execution.title")} value={location} className={input} disabled={busy} onChange={(event) => { setLocation(event.target.value as ExecutionLocation); setConsent(false); }}><option value="local" disabled={!localAvailable}>{t("execution.local")}</option><option value="server">{t("execution.server")}</option></select>
          <p className="text-[12px] text-ink-secondary">{t(location === "local" ? "execution.localHint" : "execution.serverHint")}</p>
          {!localAvailable && <p className="text-[12px] text-ink-secondary">{t("execution.localUnavailable")}</p>}
          {location === "server" && <><label className="block space-y-1 text-[12px]">{t("execution.endpoint")}<input type="url" required className={input} value={remoteUrl} onChange={(event) => setRemoteUrl(event.target.value)} placeholder="https://" autoComplete="off" /></label><label className="block space-y-1 text-[12px]">{t("execution.token")}<input type="password" required className={input} value={remoteToken} onChange={(event) => setRemoteToken(event.target.value)} autoComplete="new-password" /></label></>}
          {grants()}
          <label className="flex items-start gap-2 text-[12px]"><input type="checkbox" className="mt-1" checked={consent} onChange={(event) => setConsent(event.target.checked)} />{t("execution.consent")}</label>
          <button type="submit" className={`${button} ui-button-primary`} disabled={busy || stale || !canManage || !consent || !botIds.length || (location === "local" ? !localAvailable : !remoteUrl.trim() || !remoteToken.trim())}>{busy && <Loader2 size={12} className="me-1 inline animate-spin" />}{t("execution.connect")}</button>
        </form>}
      </article>;
    })}</div>
  </section>;
}
