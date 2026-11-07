// The one stdio MCP server this fixture adds: it exposes exactly one tool that
// writes exactly one file, named by the fixture's own environment. No path
// comes from the model, so a tool call cannot touch anything else.
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const artifact = process.env.FIXTURE_MCP_ARTIFACT;
if (!artifact) process.exit(2);
const started = process.env.FIXTURE_MCP_STARTED;
if (started) writeFileSync(started, "started");

const lines = createInterface({ input: process.stdin });
lines.on("line", line => {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  if (request.id === undefined || request.id === null) return;
  const reply = result => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
  if (request.method === "initialize") {
    reply({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fixture-writer", version: "1" } });
    return;
  }
  if (request.method === "tools/list") {
    reply({ tools: [{
      name: "write_file",
      description: "Write the disposable verification artifact",
      inputSchema: { type: "object", properties: { content: { type: "string" } }, required: ["content"], additionalProperties: false },
    }] });
    return;
  }
  if (request.method === "tools/call" && request.params?.name === "write_file") {
    const content = request.params.arguments?.content;
    if (typeof content !== "string") {
      reply({ content: [{ type: "text", text: "content is required" }], isError: true });
      return;
    }
    writeFileSync(artifact, content);
    reply({ content: [{ type: "text", text: "created verification artifact" }] });
    return;
  }
  reply({ content: [{ type: "text", text: "unknown fixture operation" }], isError: true });
});
