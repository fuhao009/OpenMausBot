import { useEffect, useRef, useState } from "react";
import { t } from "@/lib/i18n";
import { SettingRow } from "./SettingsPrimitives";
import { Select } from "./Select";

type Policy = "ask" | "allow" | "deny";

export function ComputerUsePolicyRow() {
  const bridge = typeof window === "undefined" ? undefined : window.ogb?.computerUsePolicy;
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const saving = useRef(false);
  useEffect(() => {
    let active = true;
    if (bridge) void bridge.get().then(value => { if (active) setPolicy(value); }, () => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [bridge]);
  const save = async (next: Policy) => {
    if (!bridge || saving.current || next === policy) return;
    saving.current = true;
    setBusy(true);
    setFailed(false);
    try { setPolicy(await bridge.set(next)); }
    catch { setFailed(true); }
    finally { saving.current = false; setBusy(false); }
  };
  return <SettingRow title={t("settings.computerPolicy.title")}
    subtitle={t(bridge ? "settings.computerPolicy.description" : "settings.computerPolicy.localOnly")}
    message={failed ? <span role="alert" className="text-danger">{t("settings.computerPolicy.failed")}</span> : undefined}>
    <Select variant="ghost" aria-label={t("settings.computerPolicy.title")} value={policy ?? "ask"}
      disabled={!bridge || policy === null || busy} onChange={event => void save(event.target.value as Policy)}>
      <option value="ask">{t("settings.computerPolicy.ask")}</option>
      <option value="allow">{t("settings.computerPolicy.allow")}</option>
      <option value="deny">{t("settings.computerPolicy.deny")}</option>
    </Select>
  </SettingRow>;
}
