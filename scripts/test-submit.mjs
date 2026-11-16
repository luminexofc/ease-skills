// End-to-end test of the submit form against the running dev server.
import { chromium } from "playwright";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const C = join(homedir(), ".cache", "ms-playwright");
const exe = [
  join(C, "chromium-1254", "chrome-linux64", "chrome"),
  join(C, "chromium_headless_shell-1254", "chrome-headless-shell-linux64", "chrome-headless-shell"),
].find((p) => existsSync(p));

const b = await chromium.launch(exe ? { executablePath: exe } : {});
const p = await b.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
p.on("pageerror", (e) => errors.push(e.message));
p.on("console", (m) => m.type() === "error" && errors.push(m.text()));

await p.goto("http://127.0.0.1:8080/", { waitUntil: "networkidle" });
await p.waitForTimeout(2500);

// Open the form
const openBtn = p.getByRole("button", { name: /Add a skill or server/i });
const hasOpen = (await openBtn.count()) > 0;
if (hasOpen) await openBtn.click();
await p.waitForTimeout(400);

const formVisible = await p.getByRole("heading", { name: /Put yours in the index/i }).count();
const field = p.getByPlaceholder("https://github.com/owner/repo");
const hasField = (await field.count()) > 0;

const results = {};

async function trySubmit(value, label) {
  await field.fill(value);
  await p.getByRole("button", { name: /Check and add/i }).click();
  // Wait for the live region to settle
  const started = Date.now();
  let text = "";
  while (Date.now() - started < 25000) {
    await p.waitForTimeout(600);
    // The form owns the live region inside its own <section>; the page has
    // others (feed status), so scope to the submit panel.
    const panel = p.locator('section[aria-label="Submit a skill or server"]');
    const region = await panel.locator('[aria-live="polite"]').innerText().catch(() => "");
    if (region && region.trim().length > 5) {
      text = region.trim();
      break;
    }
  }
  results[label] = text.slice(0, 220);
  // clear for the next attempt
  await p.waitForTimeout(300);
}

// 1. a real, free, well-known skill repo
await trySubmit("https://github.com/anthropics/skills", "real-repo");
// 2. junk that is not a repo
await trySubmit("not a repository at all", "invalid");
// 3. a repo that does not exist
await trySubmit("https://github.com/this-owner-does-not-exist-xyz/nope", "missing-repo");
// 4. a free MCP server repo, verified through the no-API fallback
await trySubmit("https://github.com/modelcontextprotocol/servers", "mcp-repo");
// 5. a public link on another host, queued for review
await trySubmit("https://www.npmjs.com/package/@modelcontextprotocol/server-filesystem", "other-host");

console.log(JSON.stringify({ formVisible, hasField, hasOpen, results, errors }, null, 2));
await b.close();
