import { useEffect, useState } from "react";
import { KeyRound, Monitor } from "lucide-react";

import { writeComputerPanelView, type ComputerPanelView } from "@/lib/computer-panel-view";
import { t } from "@/lib/i18n";
import type { Place } from "@/lib/place";
import { placeHasIssue, worksOnSimpleLabel } from "@/lib/place-view";
import { useOwnerOrAdmin } from "@/lib/use-owner-or-admin";
import { api, useStore, type Bot } from "@/state/store";
import { useDesktopCapabilities } from "../DesktopCapabilities";
import { LocalComputerAutoWarning } from "../LocalComputerAutoWarning";
import { usePlaceViews } from "../PlaceChip";
import { ComputerPanel } from "../lazy-screens";
import type { BotPatch, useBotSettingsDerived } from "../bot-settings/useBotSettingsDerived";
import type { SimplePageId } from "./page-registry";
import { Card, NavRow, RadioRow } from "./rows";

type Derived = ReturnType<typeof useBotSettingsDerived>;
type PlaceChoice = "auto" | Place | "off";

interface PlaceOption {
  value: PlaceChoice;
  label: string;
  hint?: string;
  disabled?: boolean;
}

const EXTRA_PLACE_LABEL: Record<Exclude<PlaceChoice, "auto" | "local" | "cloud" | "browser">, () => string> = {
  vm: () => t("place.vm"),
  off: () => t("place.off"),
};

export function useOpenComputer(bot: Pick<Bot, "id">) {
  const { dispatch } = useStore();
  return (view: ComputerPanelView = "computer") => {
    writeComputerPanelView(bot.id, view);
    dispatch({ type: "toggleComputer", open: true });
  };
}

/** How many sites the bot's own browser is signed in to; null until read, and never asked for by a non-owner. */
function useSignedInCount(bot: Pick<Bot, "id">, enabled: boolean): number | null {
  const [count, setCount] = useState<{ botId: string; count: number } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void api(`/api/browser-sites?bot=${encodeURIComponent(bot.id)}`)
      .then((answer: { sites?: unknown[] }) => { if (!cancelled) setCount({ botId: bot.id, count: answer.sites?.length ?? 0 }); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [bot.id, enabled]);
  return count?.botId === bot.id ? count.count : null;
}

function usePlaceChoices(bot: Bot) {
  const { state } = useStore();
  const { capabilities } = useDesktopCapabilities();
  const platform = capabilities.host?.platform ?? "other";
  const placeViews = usePlaceViews(bot);
  const current: PlaceChoice = bot.computer ?? "auto";
  const myChrome = state.config?.browserEngine?.myChrome === true
    && (state.config?.browserProfiles ?? []).some((profile) => profile.id === bot.browserProfile && profile.browser === "chrome");
  const placeLabel = (place: Place) => (place === "browser" && myChrome ? t("settings.profiles.myChrome") : worksOnSimpleLabel(place, platform));
  const choice = (place: Place): PlaceOption => {
    const { view, reachable } = placeViews[place];
    return { value: place, label: placeLabel(place), disabled: !reachable, hint: !reachable || placeHasIssue(view) ? view.line : undefined };
  };
  const options: PlaceOption[] = [
    { value: "auto", label: t("computer.simple.dest.letItChoose") },
    ...(placeViews.local.policy ? [choice("local")] : []),
    ...(placeViews.browser.policy || current === "browser" ? [choice("browser")] : []),
    ...(placeViews.cloud.policy ? [choice("cloud")] : []),
    ...(current === "vm" || current === "off" ? [{ value: current, label: EXTRA_PLACE_LABEL[current](), disabled: true }] : []),
  ];
  const liveSurface = bot.tasks?.find((task) => task.threadId === bot.threadId)?.surface;
  const usingNow = liveSurface && liveSurface !== current ? placeLabel(liveSurface) : null;
  const currentLabel = options.find((option) => option.value === current)?.label
    ?? (current === "auto" || current === "vm" || current === "off" ? undefined : placeLabel(current));
  return { options, current, currentLabel, usingNow };
}

export function WherePage({ bot, derived }: { bot: Bot; derived: Derived }) {
  const { dispatch } = useStore();
  const { options, current, usingNow } = usePlaceChoices(bot);
  const [localAutoWarning, setLocalAutoWarning] = useState<{ botId: string; patch: BotPatch } | null>(null);
  const { patch, approvalMode } = derived;
  const choosePlace = (value: PlaceChoice) => {
    if (value === current || value === "vm" || value === "off") return;
    if (value === "local" && approvalMode === "auto") {
      setLocalAutoWarning({ botId: bot.id, patch: { computer: "local", acknowledgeLocalAuto: true } });
      return;
    }
    patch(value === "browser" ? { computer: "browser", browser: true } : { computer: value === "auto" ? null : value });
  };

  return (
    <>
      <Card>
        <div role="radiogroup" aria-label={t("computer.simple.whereWorks", { name: bot.name })} className="flex flex-col divide-y divide-ink/[0.05]">
          {options.map((option) => (
            <RadioRow
              key={option.value}
              data-panel-choice={option.value}
              title={option.label}
              hint={option.hint}
              checked={current === option.value}
              disabled={option.disabled}
              onClick={() => choosePlace(option.value)}
            />
          ))}
        </div>
      </Card>
      {usingNow && <p data-panel-using-now className="mx-1 text-[13px] text-ink-secondary">{t("computer.simple.usingNow", { place: usingNow })}</p>}
      <LocalComputerAutoWarning
        open={localAutoWarning !== null}
        onCancel={() => setLocalAutoWarning(null)}
        onConfirm={() => {
          const target = localAutoWarning;
          setLocalAutoWarning(null);
          if (!target) return;
          dispatch({ type: "updateBot", botId: target.botId, patch: target.patch });
        }}
      />
    </>
  );
}

export function ComputerTab({ bot, derived, onOpen, onOpenVmWorkspace }: {
  bot: Bot;
  derived: Derived;
  onOpen: (page: SimplePageId) => void;
  onOpenVmWorkspace?: (botId: string) => void;
}) {
  const ownerOrAdmin = useOwnerOrAdmin();
  const { browserEnabled } = derived;
  const signedIn = useSignedInCount(bot, browserEnabled && bot.computer !== "off" && ownerOrAdmin !== false);
  const { currentLabel, usingNow } = usePlaceChoices(bot);

  return (
    <div data-panel-tabpanel="computer" className="flex min-h-0 flex-1 flex-col">
      <ComputerPanel bot={bot} onOpenVmWorkspace={onOpenVmWorkspace} embedded />
      <div className="shrink-0 px-4 pb-4">
        <Card anchor="where">
          <NavRow
            data-panel-page="where"
            icon={Monitor}
            title={t("computer.simple.whereWorks", { name: bot.name })}
            hint={usingNow ? t("computer.simple.usingNow", { place: usingNow }) : undefined}
            value={currentLabel}
            onClick={() => onOpen("where")}
          />
          <NavRow
            data-panel-page="browser"
            icon={KeyRound}
            title={t("settings.sites.title")}
            value={signedIn ?? undefined}
            onClick={() => onOpen("browser")}
          />
        </Card>
      </div>
    </div>
  );
}
