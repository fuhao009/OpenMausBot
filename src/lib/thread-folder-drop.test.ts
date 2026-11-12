import { describe, expect, it } from "vitest";
import { activeThreadDrag, beginThreadDrag, draggedThread, endThreadDrag, threadDragData, threadFolderMove } from "./thread-folder-drop";

describe("dragging a conversation between folders", () => {
  const folders = ["work", "home"];

  it("moves into another folder, out of one, or nowhere", () => {
    expect(threadFolderMove(null, "work", folders)).toBe("work");
    expect(threadFolderMove("work", "home", folders)).toBe("home");
    expect(threadFolderMove("work", null, folders)).toBeNull();
    expect(threadFolderMove("work", "work", folders)).toBeUndefined();
    expect(threadFolderMove(undefined, null, folders)).toBeUndefined();
  });

  it("treats a folder that no longer exists as no folder, and never targets one", () => {
    expect(threadFolderMove("gone", null, folders)).toBeUndefined();
    expect(threadFolderMove("gone", "work", folders)).toBe("work");
    expect(threadFolderMove(null, "gone", folders)).toBeUndefined();
  });

  it("reads back only a conversation of the same bot", () => {
    const raw = threadDragData({ botId: "atlas", threadId: "t1" });
    expect(draggedThread(raw, "atlas")).toEqual({ botId: "atlas", threadId: "t1" });
    expect(draggedThread(raw, "scout")).toBeNull();
    expect(draggedThread("not json", "atlas")).toBeNull();
    expect(draggedThread(JSON.stringify({ botId: "atlas", threadId: "" }), "atlas")).toBeNull();
  });

  it("remembers the dragged conversation until the drag ends", () => {
    beginThreadDrag({ botId: "atlas", threadId: "t1" });
    expect(activeThreadDrag()).toEqual({ botId: "atlas", threadId: "t1" });
    endThreadDrag();
    expect(activeThreadDrag()).toBeNull();
  });
});
