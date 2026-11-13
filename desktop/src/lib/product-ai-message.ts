export interface ProductAiMessageMetadata {
  aiModel?: string;
  aiUsage?: { input: number; output: number };
}

export function productAiMessageMetadata(value: object): ProductAiMessageMetadata {
  const metadata = value as ProductAiMessageMetadata;
  return {
    ...(typeof metadata.aiModel === "string" ? { aiModel: metadata.aiModel } : {}),
    ...(metadata.aiUsage && Number.isFinite(metadata.aiUsage.input) && Number.isFinite(metadata.aiUsage.output) ? { aiUsage: metadata.aiUsage } : {}),
  };
}
