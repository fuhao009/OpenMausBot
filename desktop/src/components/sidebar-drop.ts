import { useRef, useState, type Dispatch, type DragEvent } from "react";
import { BOT_DRAG_TYPE, beginBotDrag, endBotDrag } from "@/lib/bot-chat-drop";
import { addFilesToDraft } from "@/lib/draft-files";
import { t } from "@/lib/i18n";
import { useShowThreads } from "@/lib/thread-preferences";
import { openBot, type Action, type Bot, type InstanceInfo } from "@/state/store";
import { pathForFile } from "./ComposerAttachments";

type DragHandler = (event: DragEvent<HTMLElement>) => void;
export type DropHandlers = { onDragEnter?: DragHandler; onDragOver?: DragHandler; onDragLeave?: DragHandler; onDrop?: DragHandler; onDragStart?: DragHandler; onDragEnd?: DragHandler };

const carriesFiles = (event: DragEvent<HTMLElement>) => Array.from(event.dataTransfer.types).includes("Files");

/** Runs each handler for the same event in turn, so several drag gestures can share one element. */
export function chainDragHandlers(...sets: (DropHandlers | undefined)[]): DropHandlers {
  const keys = ["onDragEnter", "onDragOver", "onDragLeave", "onDrop", "onDragStart", "onDragEnd"] as const;
  const chained: DropHandlers = {};
  for (const key of keys) {
    const handlers = sets.map((set) => set?.[key]).filter((handler): handler is DragHandler => Boolean(handler));
    if (handlers.length) chained[key] = (event) => { for (const handler of handlers) handler(event); };
  }
  return chained;
}

/** Every sidebar bot can be dragged into a chat or onto the calendar, whether or not its row can be reordered. */
export function botChatDragStart(botId: string): DragHandler {
  return (event) => {
    event.dataTransfer.effectAllowed = "copyMove";
    event.dataTransfer.setData(BOT_DRAG_TYPE, botId);
    beginBotDrag(botId);
    event.currentTarget.addEventListener("dragend", endBotDrag, { once: true });
  };
}

/** Files dropped on a bot open its current conversation with them attached. Takes the row's own props, not the
 * store, so a memoized row does not redraw for every store change. */
export function useBotFileDrop({ bot, dispatch, instances, enabled = true }: {
  bot: Pick<Bot, "id" | "threadId" | "mainThreadId" | "tasks" | "modelSelection" | "yourAccess">;
  dispatch: Dispatch<Action>;
  instances: readonly InstanceInfo[];
  enabled?: boolean;
}) {
  const showThreads = useShowThreads();
  const [over, setOver] = useState(false);
  const depth = useRef(0);
  const latest = useRef({ bot, dispatch, instances, showThreads });
  latest.current = { bot, dispatch, instances, showThreads };
  const reset = () => { depth.current = 0; setOver(false); };
  if (!enabled || bot.yourAccess === "view") return { over: false, handlers: {} as DropHandlers };
  const handlers: DropHandlers = {
    onDragEnter: (event) => {
      if (!carriesFiles(event)) return;
      depth.current += 1;
      setOver(true);
    },
    onDragOver: (event) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    },
    onDragLeave: (event) => {
      if (!carriesFiles(event)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setOver(false);
    },
    onDrop: (event) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      event.stopPropagation();
      reset();
      const files = Array.from(event.dataTransfer.files);
      const { bot: target, dispatch: send, instances: known, showThreads: threads } = latest.current;
      const allowImages = known.find((instance) => instance.instanceId === target.modelSelection.instanceId)?.capabilities?.images === true;
      openBot(send, target, threads);
      void addFilesToDraft(`bot:${target.id}:${target.threadId}`, files, { allowImages, getPath: pathForFile })
        .then((notice) => { if (notice) send({ type: "notice", notice: { kind: "note", botName: null, text: notice } }); })
        .catch((cause) => send({ type: "error", message: cause instanceof Error ? cause.message : String(cause) }));
    },
  };
  return { over, handlers };
}

export const FILE_DROP_RING = "rounded-xl bg-accent/10 outline outline-2 -outline-offset-2 outline-accent/70";

export function fileDropLabel(name: string): string {
  return t("sidebar.bot.dropFiles", { name });
}
