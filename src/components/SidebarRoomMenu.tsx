import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ClipboardCopy, FolderPlus, Pencil, TextQuote, Trash2, X } from "lucide-react";
import { useStore } from "@/state/store";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { copyText } from "@/lib/copy-text";
import { nextRename } from "@/lib/rename";
import { useHeldMenuMotion } from "./MenuMotion";
import { navigateThreadMenu } from "./BotProjects";
import { MENU_ITEM, MENU_SHEET } from "./menu-recipe";

export function RoomContextMenu({
  menu,
  onClose,
  onMoveToSection,
  onDelete,
}: {
  menu: { groupId: string; x: number; y: number } | null;
  onClose: () => void;
  onMoveToSection: (groupId: string) => void;
  onDelete: (groupId: string) => void;
}) {
  const motion = useHeldMenuMotion(menu);
  const shown = motion.value;
  const { state, dispatch } = useStore();
  const remoteClient = window.ogb?.remoteClient?.active === true;
  const group = shown ? state.groups.find((g) => g.id === shown.groupId) : undefined;
  const [renaming, setRenaming] = useState(false);
  const [describing, setDescribing] = useState(false);
  const [draft, setDraft] = useState(group?.name ?? "");
  const [descriptionDraft, setDescriptionDraft] = useState(group?.description ?? "");

  useEffect(() => {
    if (!menu) return;
    setDraft(state.groups.find((g) => g.id === menu.groupId)?.name ?? "");
    setDescriptionDraft(state.groups.find((g) => g.id === menu.groupId)?.description ?? "");
    setRenaming(false);
    setDescribing(false);
  }, [menu]);
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => {
      if (!(e.target instanceof Element) || !e.target.closest("[data-room-menu]")) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onClose);
    };
  }, [menu, onClose]);

  if (!motion.shown || !group || !shown) return null;
  const isBotChat = Boolean(group.dm);
  const saveRename = () => {
    const name = nextRename(group.name, draft);
    if (name) dispatch({ type: "patchGroup", groupId: group.id, patch: { name } });
    onClose();
  };
  const saveDescription = () => {
    const trimmed = descriptionDraft.trim();
    if (trimmed !== (group.description ?? "")) {
      dispatch({ type: "patchGroup", groupId: group.id, patch: { description: trimmed } });
    }
    onClose();
  };
  const top = Math.min(shown.y, window.innerHeight - 204);
  const left = Math.min(shown.x, window.innerWidth - 240);
  return createPortal(
    <div
      data-room-menu
      data-sidebar
      role="menu"
      aria-label={t("sidebar.bot.actions", { name: group.name })}
      onKeyDown={navigateThreadMenu}
      style={{ top, left }}
      className={cn("fixed z-40 w-[228px] overflow-hidden", MENU_SHEET, motion.className)} {...motion.exitProps}
    >
      {!remoteClient && describing ? (
        <div className="flex items-center gap-1 px-2 py-1">
          <input
            autoFocus
            value={descriptionDraft}
            maxLength={120}
            placeholder={t("sidebar.room.descriptionPlaceholder")}
            aria-label={t("sidebar.room.descriptionAria", { name: group.name })}
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => setDescriptionDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                event.preventDefault();
                saveDescription();
              }
              if (event.key === "Escape") {
                event.preventDefault();
                onClose();
              }
            }}
            className="min-w-0 flex-1 rounded-lg bg-raised px-2 py-1.5 text-[14px] text-ink focus:outline-none focus:ring-1 focus:ring-accent"
          />
          <button
            type="button"
            onClick={saveDescription}
            aria-label={t("sidebar.room.saveDescription")}
            title={t("common.save")}
            className="flex size-8 shrink-0 items-center justify-center rounded-lg text-ink-secondary hover:bg-raised hover:text-ink"
          >
            <Check size={15} />
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("common.cancel")}
            title={t("common.cancel")}
            className="flex size-8 shrink-0 items-center justify-center rounded-lg text-ink-secondary hover:bg-raised hover:text-ink"
          >
            <X size={15} />
          </button>
        </div>
      ) : !remoteClient && (renaming ? (
        <div className="flex items-center gap-1 px-2 py-1">
          <input
            autoFocus
            value={draft}
            maxLength={100}
            aria-label={t("sidebar.room.renameAria", { name: group.name })}
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                event.preventDefault();
                saveRename();
              }
              if (event.key === "Escape") {
                event.preventDefault();
                onClose();
              }
            }}
            className="min-w-0 flex-1 rounded-lg bg-raised px-2 py-1.5 text-[14px] text-ink focus:outline-none focus:ring-1 focus:ring-accent"
          />
          <button
            type="button"
            onClick={saveRename}
            aria-label={isBotChat ? t("sidebar.room.saveChatName") : t("sidebar.room.saveChannelName")}
            title={t("common.save")}
            className="flex size-8 shrink-0 items-center justify-center rounded-lg text-ink-secondary hover:bg-raised hover:text-ink"
          >
            <Check size={15} />
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label={isBotChat ? t("sidebar.room.cancelChatRename") : t("sidebar.room.cancelChannelRename")}
            title={t("common.cancel")}
            className="flex size-8 shrink-0 items-center justify-center rounded-lg text-ink-secondary hover:bg-raised hover:text-ink"
          >
            <X size={15} />
          </button>
        </div>
      ) : (
        <button
          role="menuitem"
          onClick={() => {
            setDraft(group.name);
            setRenaming(true);
          }}
          className={cn(MENU_ITEM, "text-ink hover:bg-menu-hover")}
        >
          <Pencil size={16} className="text-ink-secondary" />
          {isBotChat ? t("sidebar.room.renameChat") : t("sidebar.room.renameChannel")}
        </button>
      ))}
      {!remoteClient && !renaming && !isBotChat && (
        <button
          role="menuitem"
          onClick={() => {
            setDescriptionDraft(group.description ?? "");
            setDescribing(true);
          }}
          className={cn(MENU_ITEM, "text-ink hover:bg-menu-hover")}
        >
          <TextQuote size={16} className="text-ink-secondary" />
          {t("sidebar.room.setDescription")}
        </button>
      )}
      {!remoteClient && !isBotChat && (
        <button
          role="menuitem"
          onClick={() => {
            onClose();
            onMoveToSection(group.id);
          }}
          className={cn(MENU_ITEM, "text-ink hover:bg-menu-hover")}
        >
          <FolderPlus size={16} className="text-ink-secondary" />
          {t("sidebar.section.moveToContext")}
        </button>
      )}
      <button
        role="menuitem"
        onClick={() => {
          void copyText(group.threadId);
          onClose();
        }}
        className={cn(MENU_ITEM, "text-ink hover:bg-menu-hover")}
      >
        <ClipboardCopy size={16} className="text-ink-secondary" />
        {t("sidebar.copyConversationId")}
      </button>
      {!remoteClient && <button
        role="menuitem"
        onClick={() => {
          onClose();
          onDelete(group.id);
        }}
        className={cn(MENU_ITEM, "text-danger hover:bg-menu-hover")}
      >
        <Trash2 size={16} />
        {isBotChat ? t("sidebar.room.deleteChat") : t("sidebar.room.deleteChannel")}
      </button>}
    </div>,
    document.body,
  );
}
