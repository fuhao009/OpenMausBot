import { Crown } from "lucide-react";
import { useLongPress } from "@/hooks/use-long-press";
import { t } from "@/lib/i18n";
import { stateForBot } from "@/lib/mascot";
import type { Bot } from "@/state/store";
import { BotAvatar } from "./Avatar";
import { openBotContextMenu, useVisibleMessages, type MenuState } from "./Sidebar";

/** The phone's home leads with the chief of staff, large and centred, instead of a row. */
export function PhoneHero({ bot, selected, onOpen, onMenu }: { bot: Bot; selected: boolean; onOpen: () => void; onMenu: (menu: MenuState) => void }) {
  const visible = useVisibleMessages(bot);
  const longPress = useLongPress((point) => onMenu({ botId: bot.id, ...point }));
  return (
    <div className="relative mb-2 flex flex-col items-center pb-2 pt-1">
      <button
        type="button"
        data-sidebar-hero={bot.id}
        data-sidebar-bot-row={bot.id}
        aria-current={selected ? "page" : undefined}
        onClick={onOpen}
        onContextMenu={(event) => openBotContextMenu(onMenu, bot.id, event)}
        aria-haspopup="menu"
        {...longPress}
        className="flex flex-col items-center gap-1.5 rounded-2xl px-6 py-1 outline-none focus-visible:ring-1 focus-visible:ring-accent/60"
      >
        <span className="relative flex">
          <BotAvatar bot={bot} state={stateForBot({ ...bot, messages: visible })} size={88} motion="none" motionKey={0} animated={Boolean(bot.busy)} />
          <span className="absolute -bottom-0.5 -right-0.5 flex rounded-full border-2 border-app bg-raised p-1">
            <Crown size={13} strokeWidth={2.25} className="text-accent" aria-hidden="true" />
          </span>
        </span>
        <span className="text-[17px] font-semibold leading-6 text-ink">{bot.name}</span>
        <span className="text-[13px] leading-4 text-ink-secondary">{t("sidebar.bot.chiefOfStaff")}</span>
      </button>
    </div>
  );
}
