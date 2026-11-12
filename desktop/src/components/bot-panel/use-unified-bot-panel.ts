import { isProductWorkspace } from "@/lib/product-workspace";
import { useAdvancedMode } from "@/lib/interface-mode";
import { useStore } from "@/state/store";

/** Simple and managed workspaces show tasks, library and computer inside the bot panel; advanced mode and a paired
 * desktop keep their own side panels. */
export function useUnifiedBotPanel(): boolean {
  const { state } = useStore();
  const advanced = useAdvancedMode();
  const remoteClient = window.ogb?.remoteClient?.active === true;
  return !remoteClient && (isProductWorkspace(state.config?.productManaged) || !advanced);
}
