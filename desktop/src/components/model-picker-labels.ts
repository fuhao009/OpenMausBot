import type { InstanceInfo } from "@/state/store";
import type { ModelVariantOption } from "../../../packages/shared/runtime-events";
import { t } from "@/lib/i18n";

export function modelLabel(instance: InstanceInfo | undefined, model: string): string {
  return instance?.models.options.find((option) => option.id === model)?.label ?? model;
}

export function modelProvider(instance: InstanceInfo | undefined, model: string): string | undefined {
  return instance?.models.options.find((option) => option.id === model)?.provider;
}

export const variantLabel = (option: ModelVariantOption, driverKind?: string): string =>
  option.id === "default" && driverKind === "opencodeGo" ? t("model.variant.openCodeDefault") : option.label;
