type PromptText = { id: string; text: string };
type NamedTool = { name: string };

export function promptTokenBreakdown(sections: readonly PromptText[], tools: readonly NamedTool[] = []) {
  const measure = (text: string) => {
    const bytes = Buffer.byteLength(text, "utf8");
    return { bytes, approxTokens: Math.ceil(bytes / 4) };
  };
  return {
    sections: sections.map(section => ({ id: section.id, ...measure(section.text) })),
    tools: tools.map(tool => ({ name: tool.name, ...measure(JSON.stringify(tool)) })),
    estimate: "UTF-8 bytes / 4; excludes conversation history and provider framing. Gateway usage is authoritative.",
  };
}
