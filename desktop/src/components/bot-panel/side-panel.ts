import { cn } from "@/lib/cn";

export const BOT_PANEL_ID = "bot-panel";

const WIDE_WIDTH = "md:w-[var(--workspace-width,460px)] md:transition-[width] md:duration-200 motion-reduce:transition-none has-[[data-workspace-resize]:active]:transition-none";

export const sidePanelCls = (overlay: boolean, simple = false, wide = false) => cn(
  "animate-sheet-in md:animate-panel-in absolute inset-0 z-40 flex h-full min-w-0 flex-col outline-none focus-visible:outline-none",
  simple && !overlay ? "border-l-[0.5px] border-ink/[0.06] bg-app" : "border-l border-hairline/40 bg-panel",
  overlay
    ? cn("md:inset-auto md:right-0 md:top-0 md:bottom-0 md:shadow-2xl", wide ? cn(WIDE_WIDTH, "md:max-w-[calc(100vw-2rem)]") : simple ? "md:w-[320px]" : "md:w-[min(420px,42vw)]")
    : cn("md:z-auto md:shrink-0", wide ? cn(WIDE_WIDTH, "md:relative") : cn("md:static", simple ? "md:w-[320px]" : "md:w-[min(420px,42vw)]")),
);
