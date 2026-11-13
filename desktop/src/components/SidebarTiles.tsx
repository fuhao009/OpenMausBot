import { Crown, Loader2, Phone } from "lucide-react";
import { memo, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { useLiveMedia } from "@/lib/live-call-media";
import { stateForBot } from "@/lib/mascot";
import { useShowThreads } from "@/lib/thread-preferences";
import { api, openBot, useStore, type Bot } from "@/state/store";
import { useChiefStepOpen } from "@/lib/default-bot";

import { BotAvatar } from "./Avatar";
import { botTooltip } from "./BotModelBadge";
import { liveBadgeFor } from "./LiveCallPill";
import { stepKey, type BotDropPlace } from "@/lib/sidebar-bot-drop";
import { useLongPress } from "@/hooks/use-long-press";
import { FILE_DROP_RING, botChatDragStart, chainDragHandlers, useBotFileDrop } from "./sidebar-drop";
import { RenameTitle } from "./RenameTitle";
import { openBotContextMenu, useVisibleMessages, type BotRowProps } from "./Sidebar";
import { sidebarBotStatus } from "./SidebarBotActivity";
import type { SidebarBotDragApi } from "./SidebarBotDrag";
import { SIMPLE_ROW_FOCUS } from "./SidebarSimpleTop";
import { useBotUnread } from "./unread-notice";

const RING = "ring-2 ring-[var(--tile)]";

/** A tile takes a dragged bot before it or after it, by the pointer's side of the middle. */
function tileDropClass(place: BotDropPlace | null | undefined, dragging: boolean | undefined): string {
  return cn(dragging && "opacity-40", place === "before" && "shadow-[-2px_0_var(--color-accent)]", place === "after" && "shadow-[2px_0_var(--color-accent)]");
}

export const SidebarBotTile = memo(function SidebarBotTile(row: BotRowProps) {
  const { bot, selected, deleting, mascotMotion, pendingQueued, instances, liveCall, dispatch, onMenu, renameRequest, botDrag: drag, botDrop: drop, botDragging: dragging } = row;
  const showThreads = useShowThreads();
  const liveMedia = useLiveMedia();
  const remoteClient = typeof window !== "undefined" && window.ogb?.remoteClient?.active === true;
  const [renaming, setRenaming] = useState(false);
  const visible = useVisibleMessages(bot);
  const { waiting, working, teammateWait, queued } = sidebarBotStatus(bot, pendingQueued);
  const { unread, noticing } = useBotUnread(bot);
  const onLiveCall = liveBadgeFor(bot.id, liveMedia, liveCall);
  const tooltip = botTooltip(bot, instances);
  const status = waiting ? t("sidebar.preview.waiting") : working ? t("chat.activity.working") : teammateWait ? t("sidebar.preview.waitingOnTeammate") : queued ? t("task.queued") : "";
  const label = [bot.name, bot.chiefOfStaff ? t("sidebar.bot.chiefOfStaff") : "", onLiveCall ? t("call.live.badge") : "", status, unread ? t("task.unread") : ""].filter(Boolean).join(" · ");
  const fileDrop = useBotFileDrop({ bot, dispatch, instances: row.allInstances ?? instances, enabled: !deleting });
  const longPress = useLongPress((point) => onMenu({ botId: bot.id, ...point }));
  const handlers = chainDragHandlers(drag && !renaming ? drag.row(bot.id) : undefined, renaming ? undefined : { onDragStart: botChatDragStart(bot.id) }, fileDrop.handlers);
  const open = () => openBot(dispatch, bot, showThreads);
  const rename = (name: string) => {
    if (!remoteClient) return dispatch({ type: "updateBot", botId: bot.id, patch: { name } });
    void api(`/api/bots/${bot.id}/profile`, { method: "PATCH", body: JSON.stringify({ name }) })
      .then(({ bot: updated }) => dispatch({ type: "botPatched", bot: updated }))
      .catch((cause) => dispatch({ type: "error", message: cause instanceof Error ? cause.message : String(cause) }));
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (renaming) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      open();
    } else if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
      event.preventDefault();
      const rect = event.currentTarget.getBoundingClientRect();
      onMenu({ botId: bot.id, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
    } else if (drag && stepKey(event)) {
      event.preventDefault();
      drag.step(bot.id, stepKey(event)!);
    }
  };
  const dot = (testId: string, tone: string) => <span data-testid={testId} aria-hidden="true" className={cn("absolute -right-0.5 -top-0.5 size-3 rounded-full", tone, RING)} />;
  return (
    <div
      role={renaming ? undefined : "button"}
      tabIndex={renaming ? undefined : 0}
      data-sidebar-bot-row={bot.id}
      data-sidebar-tile=""
      draggable={!renaming}
      data-file-drop={fileDrop.over ? "" : undefined}
      aria-label={renaming ? undefined : label}
      aria-current={selected && !renaming ? "page" : undefined}
      aria-busy={deleting || undefined}
      aria-keyshortcuts={drag ? "Alt+ArrowUp Alt+ArrowDown" : undefined}
      title={tooltip}
      {...handlers}
      {...(renaming ? {} : longPress)}
      onClick={(event: MouseEvent) => { if (!renaming && !(event.target instanceof HTMLInputElement)) open(); }}
      onKeyDown={onKeyDown}
      onContextMenu={(event) => openBotContextMenu(onMenu, bot.id, event)}
      className={cn(
        "flex h-[92px] w-[78px] shrink-0 cursor-default flex-col items-center rounded-[10px] bg-[var(--tile)] px-1 pt-2 transition-colors duration-150", SIMPLE_ROW_FOCUS,
        selected ? "[--tile:var(--color-raised)]" : "[--tile:var(--color-panel)] hover:[--tile:color-mix(in_srgb,var(--color-raised)_50%,var(--color-panel))]",
        drag && "cursor-grab select-none active:cursor-grabbing",
        tileDropClass(drop, dragging),
        fileDrop.over && FILE_DROP_RING,
      )}
    >
      <span className="relative flex">
        <BotAvatar
          bot={bot}
          state={stateForBot({ ...bot, messages: visible })}
          size={56}
          motion={mascotMotion?.kind ?? "none"}
          motionKey={mascotMotion?.nonce ?? 0}
          animated={working || noticing || (mascotMotion?.kind ?? "none") !== "none"}
        />
        {bot.chiefOfStaff && (
          <span data-testid="chief-badge" className={cn("absolute -bottom-px -right-px flex size-4 items-center justify-center rounded-full bg-[#E8993A] text-white", RING)}>
            <Crown size={10} strokeWidth={1.5} fill="currentColor" aria-hidden="true" />
          </span>
        )}
        {onLiveCall ? (
          <span data-testid="live-call-badge" className={cn("absolute -right-1 -top-1 flex size-4 items-center justify-center rounded-full bg-success", RING)}>
            <Phone size={9} strokeWidth={2.5} aria-hidden="true" />
          </span>
        ) : waiting ? (
          <span data-testid="waiting-dot" aria-hidden="true" className={cn("absolute -right-1 -top-1 flex size-4 items-center justify-center rounded-full bg-warning text-[11px] font-black leading-none text-panel", RING)}>!</span>
        ) : working ? dot("working-dot", "bg-success")
          : teammateWait ? dot("teammate-wait-dot", "bg-accent")
          : queued ? dot("queued-dot", "bg-ink-tertiary")
          : unread ? dot("unread-dot", "bg-accent")
          : null}
        {deleting && (
          <span className="absolute inset-0 flex items-center justify-center rounded-full bg-panel/60 text-ink-secondary">
            <Loader2 size={16} className="animate-spin" aria-hidden="true" />
          </span>
        )}
      </span>
      <span className="mt-1.5 flex w-full min-w-0 justify-center">
        <RenameTitle
          value={bot.name}
          editRequest={renameRequest}
          title={tooltip}
          onCommit={rename}
          onEditingChange={setRenaming}
          className="min-w-0 truncate text-center text-[13px] font-medium leading-4 text-ink"
          inputClassName="w-full rounded bg-inset px-1 text-center text-[13px] font-medium leading-4"
        />
      </span>
    </div>
  );
});

/** The sidebar while the first run's Chief step is open over an app with no bots of the person's own yet. */
export function SidebarNoBots() {
  const { state } = useStore();
  const chiefStep = useChiefStepOpen();
  if (!chiefStep || state.bots.some((bot) => !bot.hidden && !bot.defaultBot)) return null;
  return <p data-sidebar-empty="" className="px-5 pt-4 text-[13px] leading-[18px] text-ink-tertiary">{t("onboarding.shell.noBots")}</p>;
}

/** How much of the grid's right end Search and New take in a framed window's corner (Sidebar's corner row). */
const CORNER_CLEAR = 60;

/** Whether the tiles' first row, as laid out, ends before the corner's buttons: the sidebar's width and the number of
 * tiles decide it. */
export function tilesClearCorner(tiles: { top: number; right: number }[], gridRight: number): boolean {
  if (!tiles.length) return false;
  const top = tiles[0]!.top;
  return Math.max(...tiles.filter((tile) => Math.abs(tile.top - top) < 1).map((tile) => tile.right)) <= gridRight - CORNER_CLEAR;
}

/** While the tiles clear the corner they rise beside its buttons (styles.css); else they start under them. */
function useBesideCorner(corner: boolean, count: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [beside, setBeside] = useState(false);
  useLayoutEffect(() => {
    const grid = ref.current;
    if (!corner || !grid) { setBeside(false); return; }
    const measure = () => {
      const tiles = [...grid.querySelectorAll<HTMLElement>("[data-sidebar-tile]")].map((tile) => tile.getBoundingClientRect());
      setBeside(tilesClearCorner(tiles, grid.getBoundingClientRect().right));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(grid);
    return () => observer.disconnect();
  }, [corner, count]);
  return { ref, beside };
}

/** The pinned bots in the order shown. The grid takes a bot dragged onto it, at its end; with none pinned it is only a
 * slim place to drop one, shown while a bot is being dragged. */
export function SidebarTileGrid({ pinned, row, corner = false, drop }: {
  pinned: Bot[]; row: (bot: Bot) => BotRowProps; corner?: boolean; drop?: SidebarBotDragApi["tiles"];
}) {
  const besideCorner = useBesideCorner(corner, pinned.length);
  const empty = pinned.length === 0;
  return (
    <div ref={besideCorner.ref} data-sidebar-tiles="" data-beside-corner={besideCorner.beside ? "" : undefined} data-bot-drop={drop?.over ? "end" : undefined}
      className={cn(empty ? "mx-3 mb-2 mt-2.5 flex h-10 items-center justify-center rounded-[10px] border border-dashed text-[13px] leading-[18px]" : "flex max-h-[40vh] flex-wrap justify-center gap-1 overflow-y-auto px-3 pb-4 pt-2.5",
        empty && (drop?.over ? "border-accent text-ink" : "border-ink/20 text-ink-secondary"),
        drop?.over && "rounded-[10px] bg-accent/10 outline outline-2 -outline-offset-2 outline-accent/70")} {...drop?.handlers}>
      {empty ? t("sidebar.tiles.dropToPin") : pinned.map((bot) => <SidebarBotTile key={bot.id} {...row(bot)} />)}
    </div>
  );
}
