import { useCallback, useEffect, useRef, useState } from "react";
import { X } from "lucide-react";

import { t } from "@/lib/i18n";
import { PRODUCT_WIDE_LAYOUT, useMediaQuery } from "@/lib/use-media-query";
import { useStore, type Bot } from "@/state/store";

import { ActivityPanel, ComputerPanel } from "./lazy-screens";
import { WorkspaceResizeEdge } from "./WorkspaceResizeEdge";
import { BotAvatar } from "./Avatar";
import { LibraryTab } from "./bot-panel/LibraryTab";
import { openBotSettings } from "./bot-panel/panel-link";
import { cn } from "@/lib/cn";

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function WorkPanel({ bot, onOpenVmWorkspace }: { bot: Bot; onOpenVmWorkspace?: (botId: string) => void }) {
  const { state, dispatch } = useStore();
  const tasks = state.activityOpen;
  const [detailsTab, setDetailsTab] = useState<"activity" | "library">("activity");
  const tab = tasks ? detailsTab : "computer";
  // Docked is the safe reading until the media query answers: a docked panel is part of the page, not a dialog.
  const docked = useMediaQuery(PRODUCT_WIDE_LAYOUT, true);
  const panelRef = useRef<HTMLElement>(null);
  const opener = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (docked) return;
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const root = panelRef.current;
    if (!root) return;
    // The hosted panels are lazy screens: focus the panel now, its first control when the chunk lands.
    root.focus({ preventScroll: true });
    const handOff = () => {
      if (!root.isConnected) return;
      const active = document.activeElement;
      if (active && active !== root && root.contains(active)) return;
      const first = root.querySelector<HTMLElement>(FOCUSABLE);
      (first ?? root).focus({ preventScroll: true });
      if (first) observer.disconnect();
    };
    const observer = new MutationObserver(handOff);
    observer.observe(root, { childList: true, subtree: true });
    handOff();
    return () => {
      observer.disconnect();
      const target = opener.current;
      if (target?.isConnected) target.focus({ preventScroll: true });
    };
  }, [docked]);

  const close = useCallback(() => {
    dispatch({ type: "toggleActivity", open: false });
    dispatch({ type: "toggleComputer", open: false });
  }, [dispatch]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Tab" && !docked) {
        const root = panelRef.current;
        if (!root) return;
        const items = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((item) => item.getClientRects().length > 0);
        if (items.length === 0) {
          event.preventDefault();
          root.focus({ preventScroll: true });
          return;
        }
        const first = items[0]!;
        const last = items.at(-1)!;
        const active = document.activeElement;
        if (!root.contains(active)) {
          event.preventDefault();
          first.focus({ preventScroll: true });
        } else if (event.shiftKey && (active === first || active === root)) {
          event.preventDefault();
          last.focus({ preventScroll: true });
        } else if (!event.shiftKey && active === last) {
          event.preventDefault();
          first.focus({ preventScroll: true });
        }
        return;
      }
      if (event.key !== "Escape" || event.defaultPrevented || docked) return;
      if ([...document.querySelectorAll<HTMLElement>('[role="menu"]')].some((menu) => menu.checkVisibility())) return;
      // A dialog opened from inside the panel owns Escape until it closes.
      const dialogs = [...document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]')];
      if (dialogs.some((dialog) => !dialog.hasAttribute("data-product-work-panel"))) return;
      event.preventDefault();
      close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [close, docked]);

  return (
    <>
      {!docked && (
        <div
          aria-hidden
          data-product-work-scrim
          onClick={close}
          className="animate-fade-in fixed inset-0 z-30 bg-black/40 motion-reduce:animate-none"
        />
      )}
      <section
        ref={panelRef}
        data-product-work-panel
        data-mode={tab}
        style={docked ? { width: "var(--workspace-width, 340px)", position: "relative", overflow: "visible" } : undefined}
        data-overlay={docked ? undefined : ""}
        role={docked ? "complementary" : "dialog"}
        aria-modal={docked ? undefined : true}
        aria-label={t("product.workPanel.aria", { name: bot.name })}
        tabIndex={docked ? undefined : -1}
        className="animate-panel-in fixed inset-y-0 right-0 z-40 flex min-h-0 w-[min(340px,calc(100vw-2rem))] shrink-0 flex-col overflow-hidden border-l border-hairline/40 bg-panel shadow-2xl outline-none motion-reduce:animate-none min-[1200px]:static min-[1200px]:z-auto min-[1200px]:h-full min-[1200px]:w-[340px] min-[1200px]:shadow-none"
      >
        {docked && <WorkspaceResizeEdge target={panelRef} side="left" label={t("computer.resizeAria")} storageKey="omb-product-work-width" minimum={280} maximum={600} />}
        <header data-product-details-header className="flex items-center gap-3 border-b border-hairline/40 px-4 py-4">
          <BotAvatar bot={bot} size={40} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[14px] font-semibold text-ink">{bot.name}</div>
            {bot.title && <div className="truncate text-[12px] text-ink-secondary">{bot.title}</div>}
          </div>
          <button type="button" onClick={close} aria-label={t("common.close")} className="flex size-8 shrink-0 items-center justify-center rounded-full text-ink-secondary hover:bg-control hover:text-ink"><X size={16} /></button>
        </header>
        <nav data-product-details-tabs aria-label={t("product.workPanel.aria", { name: bot.name })} className="flex shrink-0 gap-1 border-b border-hairline/40 px-3 pt-2">
          {(["activity", "library", "computer"] as const).map((item) => <button
            key={item} type="button" aria-current={tab === item ? "page" : undefined}
            onClick={() => {
              if (item !== "computer") setDetailsTab(item);
              dispatch({ type: "toggleComputer", open: item === "computer" });
              dispatch({ type: "toggleActivity", open: item !== "computer" });
            }}
            className={cn("flex-1 border-b-2 px-2 py-2 text-[13px] transition-colors", tab === item ? "border-ink font-medium text-ink" : "border-transparent text-ink-secondary hover:text-ink")}
          >{t(item === "activity" ? "activity.title" : item === "library" ? "botPanel.tab.library" : "botPanel.tab.computer")}</button>)}
        </nav>
        <div data-product-details-content className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {tab === "library" ? <div className="min-h-0 flex-1 overflow-y-auto p-3"><LibraryTab bot={bot} onOpen={(page) => {
            close();
            openBotSettings(dispatch, page === "memory" ? "memory" : page === "skills" ? "skills" : "access", { botId: bot.id, page });
          }} /></div> : tasks
            ? <ActivityPanel bot={bot} embedded />
            : <ComputerPanel bot={bot} onOpenVmWorkspace={onOpenVmWorkspace} />}
        </div>
      </section>
    </>
  );
}
