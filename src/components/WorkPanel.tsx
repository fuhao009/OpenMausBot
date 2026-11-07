import { useCallback, useEffect, useRef } from "react";

import { t } from "@/lib/i18n";
import { PRODUCT_WIDE_LAYOUT, useMediaQuery } from "@/lib/use-media-query";
import { useStore, type Bot } from "@/state/store";

import { ActivityPanel, ComputerPanel } from "./lazy-screens";

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Product work panel: real activity or the computer, docked at 340px from 1200px, an overlay dialog below that. */
export function WorkPanel({ bot, onOpenVmWorkspace }: { bot: Bot; onOpenVmWorkspace?: (botId: string) => void }) {
  const { state, dispatch } = useStore();
  const tasks = state.activityOpen;
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
    dispatch(tasks ? { type: "toggleActivity", open: false } : { type: "toggleComputer", open: false });
  }, [dispatch, tasks]);

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
        data-mode={tasks ? "tasks" : "computer"}
        data-overlay={docked ? undefined : ""}
        role={docked ? "complementary" : "dialog"}
        aria-modal={docked ? undefined : true}
        aria-label={t("product.workPanel.aria", { name: bot.name })}
        tabIndex={docked ? undefined : -1}
        className="animate-panel-in fixed inset-y-0 right-0 z-40 flex min-h-0 w-[min(340px,calc(100vw-2rem))] shrink-0 flex-col overflow-hidden border-l border-hairline/40 bg-panel shadow-2xl outline-none motion-reduce:animate-none min-[1200px]:static min-[1200px]:z-auto min-[1200px]:h-full min-[1200px]:w-[340px] min-[1200px]:shadow-none"
      >
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {tasks
            ? <ActivityPanel bot={bot} />
            : <ComputerPanel bot={bot} onOpenVmWorkspace={onOpenVmWorkspace} />}
        </div>
      </section>
    </>
  );
}
