import assert from "node:assert/strict";
import test from "node:test";

import { externalWebUrl } from "./app-permissions.mjs";
import { chatLinkFrom, chatLinkFromCommandLine } from "./chat-link.mjs";

const THREAD_LINK = "hezuo://thread/2633ea27-cc9d-4690-97bf-aca853eca4c6?bot=1f72ec75-821b-44a5-a7a3-93ff64276c7d";
const BOT_LINK = "hezuo://bot/1f72ec75-821b-44a5-a7a3-93ff64276c7d";

test("recognizes the links Copy link and a dashboard make", () => {
  assert.equal(chatLinkFrom(THREAD_LINK), THREAD_LINK);
  assert.equal(chatLinkFrom(BOT_LINK), BOT_LINK);
  assert.equal(chatLinkFrom(` ${BOT_LINK}\n`), BOT_LINK);
  assert.equal(chatLinkFrom("Hezuo://Bot/abc"), "Hezuo://Bot/abc");
});

test("leaves every other link to its own handler", () => {
  for (const other of [
    "hezuo://cloud",
    "hezuo://organization",
    "hezuo://install?url=https://github.com/a/b/team.md",
    "hezuo://threads/abc",
    "hezuo://bots/abc",
    "https://example.com/hezuo://bot/abc",
    `hezuo://bot/${"x".repeat(1024)}`,
    undefined,
    42,
  ]) assert.equal(chatLinkFrom(other), null);
});

// A published page's Open in the desktop app reaches main as desktop:open-external or window.open: both go to the
// system browser through externalWebUrl, and no page link is ever taken for a chat link, so it never opens a chat.
test("a published page's link opens in the browser, never as a chat", () => {
  for (const page of ["https://abcdefghijklmnopqrstuvwxyz.mausbot.page/", "https://abcdefghijklmnopqrstuvwxyz.mausbot.page/thread/abc?bot=pepper"]) {
    assert.equal(chatLinkFrom(page), null);
    assert.equal(chatLinkFromCommandLine(["/usr/bin/hezuo", page]), null);
    assert.equal(externalWebUrl(page), page);
  }
});

test("finds the link among a second launch's arguments", () => {
  assert.equal(chatLinkFromCommandLine(["/usr/bin/hezuo", "--no-sandbox", THREAD_LINK]), THREAD_LINK);
  assert.equal(chatLinkFromCommandLine(["/usr/bin/hezuo", "--no-sandbox", BOT_LINK]), BOT_LINK);
  assert.equal(chatLinkFromCommandLine(["/usr/bin/hezuo", "hezuo://cloud"]), null);
});
