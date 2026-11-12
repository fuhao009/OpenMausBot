import { describe, expect, it } from "vitest";
import { activeBotDrag, activeMemberDrag, beginBotDrag, beginMemberDrag, botChatDrop, endBotDrag, endMemberDrag, roomMemberRemoval } from "./bot-chat-drop";

describe("dropping a bot into a chat", () => {
  it("starts a channel from a one-to-one chat with another bot", () => {
    expect(botChatDrop({ kind: "bot", botId: "atlas" }, "scout")).toEqual({ kind: "create", memberIds: ["atlas", "scout"] });
    expect(botChatDrop({ kind: "bot", botId: "atlas" }, "atlas")).toBeNull();
  });

  it("adds a newcomer to a channel and names a member already in it", () => {
    const room = { kind: "group" as const, groupId: "desk", memberIds: ["atlas", "scout"], dm: false };
    expect(botChatDrop(room, "rex")).toEqual({ kind: "add", groupId: "desk", memberIds: ["atlas", "scout", "rex"] });
    expect(botChatDrop(room, "scout")).toEqual({ kind: "mention" });
  });

  it("turns a direct group chat into a new channel rather than changing it", () => {
    const dm = { kind: "group" as const, groupId: "dm", memberIds: ["atlas"], dm: true };
    expect(botChatDrop(dm, "scout")).toEqual({ kind: "create", memberIds: ["atlas", "scout"] });
    expect(botChatDrop(dm, "atlas")).toBeNull();
  });

  it("ignores a drag with no bot", () => {
    expect(botChatDrop({ kind: "bot", botId: "atlas" }, "")).toBeNull();
  });

  it("remembers the dragged bot until the drag ends", () => {
    beginBotDrag("scout");
    expect(activeBotDrag()).toBe("scout");
    endBotDrag();
    expect(activeBotDrag()).toBeNull();
  });
});

describe("dragging a member out of a channel", () => {
  it("leaves the other members in order", () => {
    expect(roomMemberRemoval(["atlas", "scout", "rex"], "scout")).toEqual(["atlas", "rex"]);
  });

  it("refuses a stranger and the last member", () => {
    expect(roomMemberRemoval(["atlas", "scout"], "rex")).toBeNull();
    expect(roomMemberRemoval(["atlas"], "atlas")).toBeNull();
  });

  it("remembers the dragged member until the drag ends", () => {
    beginMemberDrag({ groupId: "desk", botId: "scout" });
    expect(activeMemberDrag()).toEqual({ groupId: "desk", botId: "scout" });
    endMemberDrag();
    expect(activeMemberDrag()).toBeNull();
  });
});
