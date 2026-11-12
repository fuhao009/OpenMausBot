// Every source file over 1,000 lines is listed here with its line count, and
// a count may only go down: a PR that grows one of these files, or adds a new
// file over 1,000 lines, fails here. A PR that shrinks a file leaves its number
// alone: scripts/tighten-ratchets.mjs lowers the numbers (and drops files under
// 1,000 lines) at each release, so two such PRs never conflict here. The split program
// (desktop/server/host/README.md) moves desktop/server/index.ts into modules of under 1,500
// lines; nothing new may exceed HARD_CAP, and the files listed above the cap
// are the ones that program takes apart. Tests, fixtures, goldens and
// vendored code are not counted.
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const ROOT = new URL("../../", import.meta.url);
const HARD_CAP = 2000;
const LISTED_FROM = 1000;

const LINES: Record<string, number> = {
  "desktop/server/index.ts": 15778,
  "desktop/src/state/store.tsx": 3360,
  "desktop/electron/main.mjs": 3246,
  "desktop/server/store.ts": 2323,
  "desktop/src/components/Sidebar.tsx": 1744,
  "desktop/server/drivers/claude.ts": 2119,
  "desktop/server/drivers/acp/core.ts": 1744,
  "desktop/server/drivers/codex.ts": 1813,
  "desktop/server/routines.ts": 1570,
  "desktop/src/components/ComputerPanel.tsx": 1821,
  "desktop/src/components/RoutineCalendarPage.tsx": 1623,
  "desktop/server/config.ts": 1281,
  "desktop/src/components/ChatView.tsx": 1308,
  "desktop/server/routine-requests.ts": 1484,
  "desktop/src/components/GroupView.tsx": 1225,
  "desktop/src/components/LocalComputerSection.tsx": 1475,
  "desktop/src/components/CursorAvatar.tsx": 1324,
  "desktop/server/skills.ts": 1390,
  "desktop/server/composio.ts": 1091,
  "desktop/server/vps-computer.ts": 1369,
  "scripts/mcp-server.ts": 1414,
  "desktop/server/boat.ts": 1258,
  "desktop/server/drivers/pi.ts": 1036,
  "desktop/server/container-computer.ts": 1225,
  "desktop/src/components/ModelPicker.tsx": 1050,
  "desktop/src/components/PhoneSetupFlow.tsx": 1146,
  "desktop/server/cli.ts": 1080,
  "desktop/server/org-library.ts": 1003,
  "desktop/src/components/AttachmentPreview.tsx": 1037,
};

function sourceFiles(): string[] {
  const out = execFileSync("git", ["ls-files", "desktop", "packages/shared", "scripts", "evals", "gateway"], { cwd: ROOT, encoding: "utf8" });
  return out.split("\n").filter((file) => /\.(ts|tsx|mjs|cjs)$/.test(file))
    .filter((file) => !file.includes(".test.") && !file.includes("/testing/") && !file.includes("goldens") && !file.startsWith("desktop/electron/vendor/"));
}

const count = (file: string) => readFileSync(new URL(file, ROOT), "utf8").split("\n").length - 1;

describe("source files stay a readable size", () => {
  it("no listed file grows, and no new file over 1,000 lines goes unlisted", () => {
    const problems: string[] = [];
    const seen = new Set<string>();
    for (const file of sourceFiles()) {
      const lines = count(file);
      const pinned = LINES[file];
      if (pinned !== undefined) {
        seen.add(file);
        if (lines > pinned) problems.push(`${file} grew to ${lines} lines (listed at ${pinned}): move code out, do not add here`);
      } else if (lines > LISTED_FROM) {
        problems.push(lines > HARD_CAP
          ? `${file} is ${lines} lines, over the ${HARD_CAP}-line cap: split it`
          : `${file} is ${lines} lines: a new file over ${LISTED_FROM} lines needs a line here and a reason in the PR`);
      }
    }
    expect(problems, "See desktop/server/host/README.md").toEqual([]);
  });
});
