import { useSyncExternalStore } from "react";

export const THREAD_ROW_DRAG_TYPE = "application/x-hezuo-thread";

let active: DraggedThread | null = null;
const listeners = new Set<() => void>();
const publish = (next: DraggedThread | null) => {
  if (active === next) return;
  active = next;
  for (const listener of listeners) listener();
};

let listening = false;
/** A row filed by the drop remounts in its folder, so the browser's dragend reaches a detached node and React never
 * sees it: the window ends the drag instead, after the drop target has read it. */
function listen() {
  if (listening || typeof window === "undefined") return;
  listening = true;
  window.addEventListener("dragend", () => publish(null), true);
  window.addEventListener("drop", () => setTimeout(() => publish(null), 0), true);
}

/** A drag's data can only be read on drop, so the conversation being dragged is kept here for drop targets to
 * preview against. Drags from another window are never shown as droppable. */
export const beginThreadDrag = (thread: DraggedThread) => { listen(); publish(thread); };
export const endThreadDrag = () => publish(null);
export const activeThreadDrag = () => active;

export function useThreadDrag(): DraggedThread | null {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    activeThreadDrag,
    () => null,
  );
}

/** How long a dragged conversation hovers over a closed folder before it opens. */
export const FOLDER_OPEN_DELAY_MS = 600;

export type DraggedThread = { botId: string; threadId: string };

export function threadDragData(thread: DraggedThread): string {
  return JSON.stringify(thread);
}

export function draggedThread(raw: string, botId: string): DraggedThread | null {
  try {
    const value = JSON.parse(raw);
    return value?.botId === botId && typeof value.threadId === "string" && value.threadId ? { botId, threadId: value.threadId } : null;
  } catch {
    return null;
  }
}

/** The folder a dropped conversation moves to, or `undefined` when the drop changes nothing. `null` takes it out of
 * every folder. */
export function threadFolderMove(
  current: string | null | undefined,
  target: string | null,
  folderIds: readonly string[],
): string | null | undefined {
  const from = current && folderIds.includes(current) ? current : null;
  if (target !== null && !folderIds.includes(target)) return undefined;
  return from === target ? undefined : target;
}
