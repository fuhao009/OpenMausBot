/** A bot dragged from the sidebar. The routine calendar reads the same type to schedule it. */
export const BOT_DRAG_TYPE = "application/x-hezuo-bot";

let dragging: string | null = null;

/** A drag's data can only be read on drop, so the bot being dragged is kept here for a chat to preview against. */
export const beginBotDrag = (botId: string) => { dragging = botId; };
export const endBotDrag = () => { dragging = null; };
export const activeBotDrag = () => dragging;

/** A member's face dragged out of its channel's header. */
export const ROOM_MEMBER_DRAG_TYPE = "application/x-hezuo-room-member";

export type MemberDrag = { groupId: string; botId: string };

let draggingMember: MemberDrag | null = null;

export const beginMemberDrag = (drag: MemberDrag) => { draggingMember = drag; };
export const endMemberDrag = () => { draggingMember = null; };
export const activeMemberDrag = () => draggingMember;

export function roomMemberRemoval(memberIds: readonly string[], botId: string): string[] | null {
  if (!memberIds.includes(botId)) return null;
  const rest = memberIds.filter((id) => id !== botId);
  return rest.length > 0 ? rest : null;
}

export type BotChatTarget =
  | { kind: "bot"; botId: string }
  | { kind: "group"; groupId: string; memberIds: readonly string[]; dm: boolean };

export type BotChatDrop =
  /** Already in the conversation: the composer names it. */
  | { kind: "mention" }
  /** The channel takes it in, then the composer names it. */
  | { kind: "add"; groupId: string; memberIds: string[] }
  /** A one-to-one chat becomes a new channel with both bots. */
  | { kind: "create"; memberIds: string[] };

export function botChatDrop(target: BotChatTarget, botId: string): BotChatDrop | null {
  if (!botId) return null;
  if (target.kind === "bot") return target.botId === botId ? null : { kind: "create", memberIds: [target.botId, botId] };
  if (target.memberIds.includes(botId)) return target.dm ? null : { kind: "mention" };
  if (target.dm) return { kind: "create", memberIds: [...target.memberIds, botId] };
  return { kind: "add", groupId: target.groupId, memberIds: [...target.memberIds, botId] };
}
