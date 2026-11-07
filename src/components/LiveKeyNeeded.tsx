import { useId } from "react";
import { KeyRound } from "lucide-react";

import { liveDisclosure } from "@/lib/call-mode";
import { dismissLiveNotice } from "@/lib/live-call-media";
import { t } from "@/lib/i18n";
import { useStore } from "@/state/store";
import { openKeySettings } from "./keys/key-focus";
import { isProductWorkspace } from "@/lib/product-workspace";

export function LiveKeyNeeded() {
  const { state, dispatch } = useStore();
  // A managed account has no shared model key for live calls; its own live-call key is the one that exists here.
  const productManaged = isProductWorkspace(state.config?.productManaged);
  const titleId = useId();
  return <section aria-labelledby={titleId} className="flex flex-col gap-2.5 rounded-xl border border-hairline bg-panel p-4 text-left">
    <div className="flex items-start gap-2.5">
      <KeyRound size={16} className="mt-0.5 shrink-0 text-ink-secondary" aria-hidden="true" />
      <h2 id={titleId} className="text-[14px] font-medium leading-[1.4] text-ink">{t("call.live.needsKey")}</h2>
    </div>
    <button type="button" className="ui-button ui-button-primary self-start" onClick={() => { dismissLiveNotice(); dispatch(productManaged ? openKeySettings("liveKey") : openKeySettings("openai", "liveCalls")); }}>{t("call.live.openApiKeys")}</button>
    <p className="text-[12px] leading-[1.45] text-ink-tertiary">{liveDisclosure({ cloudHome: state.config?.cloudHome === true })} {t("call.live.cost")}</p>
  </section>;
}
