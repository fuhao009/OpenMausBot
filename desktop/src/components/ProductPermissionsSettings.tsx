import { useStore } from "@/state/store";
import { t } from "@/lib/i18n";
import { SettingRow, SettingsRows } from "./SettingsPrimitives";
import { ComputerUsePolicyRow } from "./ComputerUsePolicyRow";

export function ProductPermissionsSettings() {
  const { state, dispatch } = useStore();
  return <div className="flex flex-col gap-4">
    <SettingsRows><ComputerUsePolicyRow /></SettingsRows>
    <p className="text-[13px] leading-5 text-ink-secondary">{t("settings.productPermissions.description")}</p>
    <SettingsRows>{state.bots.map(bot => <SettingRow key={bot.id} title={bot.name}>
      <button type="button" className="rounded-lg bg-control px-3 py-1.5 text-[13px] hover:bg-raised-hover"
        onClick={() => dispatch({ type: "toggleSettings", open: true, botId: bot.id, section: "permissions" })}>
        {t("settings.productPermissions.configure")}
      </button>
    </SettingRow>)}</SettingsRows>
  </div>;
}
