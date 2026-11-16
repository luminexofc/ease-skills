// Interactive click-through: proves every control does something, checks the
// dialog, filters, keyboard path, empty states, and mobile layout.
import { chromium } from "playwright";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "screenshots");
mkdirSync(OUT, { recursive: true });

const C = join(homedir(), ".cache", "ms-playwright");
const exe = [
  join(C, "chromium-1254", "chrome-linux64", "chrome"),
  join(C, "chromium_headless_shell-1254", "chrome-headless-shell-linux64", "chrome-headless-shell"),
].find((p) => existsSync(p));

const URL_ = process.env.SMOKE_URL || "http://127.0.0.1:8080/";
const log = [];
const errors = [];
const ok = (name, detail) => log.push({ ok: true, name, detail });
const bad = (name, detail) => log.push({ ok: false, name, detail });

const b = await chromium.launch(exe ? { executablePath: exe } : {});

// ---------- desktop ----------
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
const p = await ctx.newPage();
p.on("console", (m) => m.type() === "error" && errors.push(`console: ${m.text()}`));
p.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
await p.goto(URL_, { waitUntil: "networkidle" });
await p.waitForTimeout(1500);

const rows = () => p.locator("main ul > li").count();
const firstCount = await rows();
firstCount > 0 ? ok("index renders", `${firstCount} rows`) : bad("index renders", "no rows");

// kind tabs
for (const [label, attr] of [["Skills", "skill"], ["MCP", "mcp"]]) {
  await p.getByRole("tab", { name: label }).click();
  await p.waitForTimeout(400);
  const n = await rows();
  const allMatch = await p.evaluate((kind) => {
    return [...document.querySelectorAll("main ul > li")].every((li) =>
      li.textContent.match(kind === "skill" ? /^Skill/ : /^MCP server/),
    );
  }, attr);
  allMatch && n !== undefined ? ok(`tab ${label}`, `${n} rows, all match`) : bad(`tab ${label}`, "mismatch");
}
await p.getByRole("tab", { name: "All" }).click();
await p.waitForTimeout(300);

// categories
await p.getByRole("button", { name: "Design", exact: true }).click();
await p.waitForTimeout(500);
const designRows = await rows();
(await p.getByRole("button", { name: /Clear all filters/ }).count()) > 0
  ? ok("category filter", `${designRows} design rows, clear link shown`)
  : bad("category filter", "no clear link");
await p.getByRole("button", { name: /Clear all filters/ }).click();
await p.waitForTimeout(400);

// filters disclosure
await p.getByRole("button", { name: /^Filters/ }).click();
await p.waitForTimeout(300);
(await p.locator("#fathom-filters").isVisible()) ? ok("filters open", "panel visible") : bad("filters open", "hidden");

// host toggle
const ghBtn = p.getByRole("button", { name: "GitHub", exact: true });
await ghBtn.click();
await p.waitForTimeout(400);
(await ghBtn.getAttribute("aria-pressed")) === "false"
  ? ok("host toggle", "GitHub unpressed")
  : bad("host toggle", "state did not change");
await ghBtn.click();
await p.waitForTimeout(300);

// save to shelf
const saveBtn = p.locator('button[aria-label^="Save "]').first();
const saveLabel = await saveBtn.getAttribute("aria-label");
await saveBtn.click();
await p.waitForTimeout(400);
(await p.locator('button[aria-label^="Remove "]').count()) > 0
  ? ok("save to shelf", saveLabel)
  : bad("save to shelf", "no remove state");
const savedCount = await p.getByRole("button", { name: /^Saved/ }).innerText();
savedCount.includes("(1)") ? ok("saved counter", savedCount) : bad("saved counter", savedCount);

// saved-only view
await p.getByRole("button", { name: /^Saved/ }).click();
await p.waitForTimeout(500);
(await rows()) === 1 ? ok("saved filter", "1 row") : bad("saved filter", `${await rows()} rows`);
await p.getByRole("button", { name: /^Saved/ }).click();
await p.waitForTimeout(300);

// search
await p.locator("#fathom-search").fill("video");
await p.waitForTimeout(600);
const pgRows = await rows();
pgRows > 0 ? ok("search", `${pgRows} rows for video`) : bad("search", "no results");
await p.locator("#fathom-search").fill("zzzznomatchzzzz");
await p.waitForTimeout(600);
(await p.getByText(/Nothing matches/).count()) > 0
  ? ok("empty search state", "honest empty state")
  : bad("empty search state", "missing");
await p.getByRole("button", { name: /Clear the search/ }).click();
await p.waitForTimeout(500);

// dialog
await p.locator("main ul > li button").first().click();
await p.waitForTimeout(500);
const dlg = p.locator('[role="dialog"]');
(await dlg.isVisible()) ? ok("dialog opens", "visible") : bad("dialog opens", "not visible");
const title = await p.locator("#listing-title").innerText();
const focusInDialog = await p.evaluate(() => {
  const d = document.querySelector('[role="dialog"]');
  return d ? d.contains(document.activeElement) : false;
});
focusInDialog ? ok("dialog focus", "focus moved inside") : bad("dialog focus", "focus outside");

// copy
await p.getByRole("button", { name: /^Copy$/ }).click();
await p.waitForTimeout(500);
(await p.getByRole("button", { name: /^Copied$/ }).count()) > 0
  ? ok("copy install", "shows Copied")
  : bad("copy install", "no feedback");

// repo link is a real link
const href = await dlg.locator('a:has-text("Open the repository")').getAttribute("href");
href?.startsWith("http") ? ok("repo link", href) : bad("repo link", String(href));

// escape closes + focus returns
await p.keyboard.press("Escape");
await p.waitForTimeout(400);
(await dlg.count()) === 0 ? ok("escape closes", "dialog gone") : bad("escape closes", "still open");
const focusReturned = await p.evaluate(() =>
  document.activeElement?.tagName !== "BODY" ? document.activeElement?.tagName : "BODY",
);
focusReturned !== "BODY" ? ok("focus returns", focusReturned) : bad("focus returns", "lost to body");

// keyboard "/" shortcut
await p.keyboard.press("/");
await p.waitForTimeout(200);
const searchFocused = await p.evaluate(() => document.activeElement?.id === "fathom-search");
searchFocused ? ok("slash shortcut", "search focused") : bad("slash shortcut", "not focused");

// keyboard tab reaches controls
await p.keyboard.press("Tab");
const tabbed = await p.evaluate(() => document.activeElement?.tagName);
tabbed ? ok("keyboard nav", `focus on ${tabbed}`) : bad("keyboard nav", "no focus");

// numbered page strip
await p.keyboard.press("Escape");
await p.locator("#index").scrollIntoViewIfNeeded();
const pager = p.getByRole("navigation", { name: "Index pages" });
if ((await pager.count()) > 0) {
  const firstPageCurrent = await pager.locator('[aria-current="page"]').innerText();
  firstPageCurrent.trim() === "1" ? ok("page strip starts on 1", firstPageCurrent) : bad("page strip start", firstPageCurrent);
  const before = await p.locator("main ul > li").first().innerText();
  await pager.getByRole("button", { name: "Page 3" }).click();
  await p.waitForTimeout(900);
  const after = await p.locator("main ul > li").first().innerText();
  const nowCurrent = await pager.locator('[aria-current="page"]').innerText();
  after !== before && nowCurrent.trim() === "3"
    ? ok("page strip jumps", `now page ${nowCurrent}`)
    : bad("page strip jumps", `${nowCurrent} / same rows: ${after === before}`);
  await pager.getByRole("button", { name: "Previous page" }).click();
  await p.waitForTimeout(700);
  (await pager.locator('[aria-current="page"]').innerText()).trim() === "2"
    ? ok("page strip back", "page 2")
    : bad("page strip back", "wrong page");
  await pager.getByRole("button", { name: "Page 1" }).click();
  await p.waitForTimeout(600);
} else bad("page strip", "navigation absent");

// focus visibility: must be measured through real keyboard traversal, because
// programmatic .focus() does not trigger :focus-visible. Reload so traversal
// starts at the top of the document rather than wherever focus was left.
await p.reload({ waitUntil: "networkidle" });
await p.waitForTimeout(900);
await p.keyboard.press("Tab");
await p.waitForTimeout(200);
const focusRing = await p.evaluate(() => {
  const cs = getComputedStyle(document.activeElement);
  return {
    on: document.activeElement.tagName,
    label: (document.activeElement.textContent || "").trim().slice(0, 24),
    outlineStyle: cs.outlineStyle,
    outlineWidth: cs.outlineWidth,
    outlineColor: cs.outlineColor,
  };
});
focusRing.outlineStyle !== "none" && parseFloat(focusRing.outlineWidth) >= 2
  ? ok("focus ring", JSON.stringify(focusRing))
  : bad("focus ring", JSON.stringify(focusRing));

// overflow desktop
const ovD = await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
!ovD ? ok("desktop no overflow", "clean") : bad("desktop no overflow", "overflows");

await p.screenshot({ path: join(OUT, "after-desktop.png") });
await p.screenshot({ path: join(OUT, "after-desktop-full.png"), fullPage: true });
await ctx.close();

// ---------- mobile ----------
const mctx = await b.newContext({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 2,
});
const mp = await mctx.newPage();
mp.on("console", (m) => m.type() === "error" && errors.push(`mobile console: ${m.text()}`));
mp.on("pageerror", (e) => errors.push(`mobile pageerror: ${e.message}`));
await mp.goto(URL_, { waitUntil: "networkidle" });
await mp.waitForTimeout(1500);

const ovM = await mp.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
!ovM ? ok("mobile no overflow", "clean") : bad("mobile no overflow", "overflows");

const smallTargets = await mp.evaluate(() =>
  [...document.querySelectorAll("button, a, select, input")]
    .filter((e) => {
      const r = e.getBoundingClientRect();
      // The skip link is visually hidden until focused (sr-only), so it is not a
      // target the user can miss; measure it only when it is actually shown.
      const hidden = r.width <= 2 && r.height <= 2;
      return !hidden && r.width > 0 && r.height > 0 && (r.height < 44 || r.width < 36);
    })
    .map((e) => ({
      tag: e.tagName,
      label: (e.textContent || e.getAttribute("aria-label") || "").trim().slice(0, 24),
      w: Math.round(e.getBoundingClientRect().width),
      h: Math.round(e.getBoundingClientRect().height),
    })),
);
smallTargets.length === 0
  ? ok("mobile tap targets", "all >= 44px tall")
  : bad("mobile tap targets", JSON.stringify(smallTargets));

// mobile dialog
await mp.locator("main ul > li button").first().tap();
await mp.waitForTimeout(600);
(await mp.locator('[role="dialog"]').isVisible())
  ? ok("mobile dialog", "opens")
  : bad("mobile dialog", "did not open");
await mp.locator('[role="dialog"] button[aria-label="Close this listing"]').tap();
await mp.waitForTimeout(400);

await mp.screenshot({ path: join(OUT, "after-mobile.png"), fullPage: true });
await mctx.close();

await b.close();

const failed = log.filter((l) => !l.ok);
console.log(
  JSON.stringify({ passed: log.length - failed.length, failed: failed.length, errors, log }, null, 2),
);
if (failed.length || errors.length) process.exitCode = 1;
