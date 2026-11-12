import { useEffect, useRef, useState, type DragEvent, type ReactNode } from "react";
import { UserMinus, UserPlus } from "lucide-react";
import { track } from "@/lib/analytics";
import { activeBotDrag, activeMemberDrag, BOT_DRAG_TYPE, botChatDrop, endBotDrag, endMemberDrag, ROOM_MEMBER_DRAG_TYPE, roomMemberRemoval, type BotChatDrop, type BotChatTarget } from "@/lib/bot-chat-drop";
import { leadComposerDraft } from "@/lib/drafts";
import { t } from "@/lib/i18n";
import { useStore, type Bot } from "@/state/store";

const carriesBot = (event: DragEvent<HTMLElement>) => event.dataTransfer.types.includes(BOT_DRAG_TYPE);
const carriesMember = (event: DragEvent<HTMLElement>) => event.dataTransfer.types.includes(ROOM_MEMBER_DRAG_TYPE);

function dropLabel({ drop, remove }: { drop: BotChatDrop | null; remove: boolean }, name: string): string {
  if (remove) return t("chat.dropBot.remove", { name });
  if (!drop) return t("chat.dropBot.unavailable");
  if (drop.kind === "mention") return t("chat.dropBot.mention", { name });
  if (drop.kind === "add") return t("chat.dropBot.add", { name });
  return t("chat.dropBot.create", { name });
}

/** A bot dragged in from the sidebar joins this conversation: a channel takes it in, a one-to-one chat becomes a
 * channel with both, and a bot already here is named in the composer. A member's face dragged from this channel's
 * header out onto the chat leaves it. */
export function BotChatDropZone({ target, draftId, children }: { target: BotChatTarget | null; draftId: string; children: ReactNode }) {
  const { state, dispatch } = useStore();
  const [hover, setHover] = useState<{ bot: Bot | null; drop: BotChatDrop | null; remove: boolean } | null>(null);
  const depth = useRef(0);
  useEffect(() => {
    const end = () => { depth.current = 0; setHover(null); endBotDrag(); endMemberDrag(); };
    window.addEventListener("dragend", end, true);
    window.addEventListener("drop", end);
    return () => {
      window.removeEventListener("dragend", end, true);
      window.removeEventListener("drop", end);
    };
  }, []);
  if (!target) return <>{children}</>;
  const preview = () => {
    const botId = activeBotDrag() ?? "";
    return { bot: state.bots.find((bot) => bot.id === botId) ?? null, drop: botChatDrop(target, botId), remove: false };
  };
  const removal = (): { botId: string; groupId: string; memberIds: string[] } | null => {
    const member = activeMemberDrag();
    if (target.kind !== "group" || target.dm || !member || member.groupId !== target.groupId) return null;
    const memberIds = roomMemberRemoval(target.memberIds, member.botId);
    return memberIds ? { botId: member.botId, groupId: target.groupId, memberIds } : null;
  };
  const previewRemoval = () => {
    const leaving = removal();
    return leaving ? { bot: state.bots.find((bot) => bot.id === leaving.botId) ?? null, drop: null, remove: true } : null;
  };
  const apply = (botId: string) => {
    const drop = botChatDrop(target, botId);
    const bot = state.bots.find((candidate) => candidate.id === botId);
    if (!drop || !bot) return;
    if (drop.kind === "create") {
      dispatch({ type: "createGroup", memberIds: drop.memberIds });
      track("room_created", { members: drop.memberIds.length, context: false });
      return;
    }
    if (drop.kind === "add") dispatch({ type: "patchGroup", groupId: drop.groupId, patch: { memberIds: drop.memberIds } });
    leadComposerDraft(draftId, `@${bot.name} `);
    requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('[data-tour="composer"] textarea')?.focus());
  };
  return (
    <div
      className="relative flex min-h-0 min-w-0 flex-1 flex-col"
      data-bot-chat-zone=""
      data-bot-chat-drop={hover ? "" : undefined}
      onDragEnter={(event) => {
        if (carriesMember(event)) {
          depth.current += 1;
          setHover(previewRemoval());
          return;
        }
        if (!carriesBot(event)) return;
        depth.current += 1;
        setHover(preview());
      }}
      onDragOver={(event) => {
        if (carriesMember(event)) {
          const allowed = removal() !== null;
          event.dataTransfer.dropEffect = allowed ? "move" : "none";
          if (allowed) event.preventDefault();
          return;
        }
        if (!carriesBot(event)) return;
        const allowed = botChatDrop(target, activeBotDrag() ?? "") !== null;
        event.dataTransfer.dropEffect = allowed ? "copy" : "none";
        if (allowed) event.preventDefault();
      }}
      onDragLeave={(event) => {
        if (!carriesBot(event) && !carriesMember(event)) return;
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) setHover(null);
      }}
      onDrop={(event) => {
        if (carriesMember(event)) {
          const leaving = removal();
          event.preventDefault();
          depth.current = 0;
          setHover(null);
          if (leaving) dispatch({ type: "patchGroup", groupId: leaving.groupId, patch: { memberIds: leaving.memberIds } });
          return;
        }
        if (!carriesBot(event)) return;
        event.preventDefault();
        depth.current = 0;
        setHover(null);
        apply(event.dataTransfer.getData(BOT_DRAG_TYPE));
      }}
    >
      {children}
      {hover && hover.bot && (
        <div aria-hidden="true" className="pointer-events-none absolute inset-3 z-40 flex animate-fade-in items-center justify-center rounded-2xl border-2 border-dashed border-accent/70 bg-app/70 backdrop-blur-[2px]">
          <div className="flex items-center gap-2 rounded-2xl bg-panel/95 px-5 py-3 text-[14px] font-medium text-ink shadow-2xl">
            {hover.remove ? <UserMinus size={16} className="text-accent" /> : <UserPlus size={16} className="text-accent" />}
            {dropLabel(hover, hover.bot.name)}
          </div>
        </div>
      )}
      <span role="status" className="sr-only">{hover?.bot ? dropLabel(hover, hover.bot.name) : ""}</span>
    </div>
  );
}
