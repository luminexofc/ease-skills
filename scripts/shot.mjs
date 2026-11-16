// Local screenshot + console capture. Portable replacement for browser-smoke.mjs,
// which hardcodes /workspace/screenshots.
import { chromium } from "playwright";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "screenshots");
const URL_ = process.env.SMOKE_URL || "http://127.0.0.1:8080/";
const TAG = process.argv[2] || "run";

mkdirSync(OUT, { recursive: true });

// The cached browser build (1254) does not match this playwright package (wants
// 1248), so point at the binary that actually exists instead of downloading.
const CACHE = join(homedir(), ".cache", "ms-playwright");
const CANDIDATES = [
  join(CACHE, "chromium-1254", "chrome-linux64", "chrome"),
  join(CACHE, "chromium_headless_shell-1254", "chrome-headless-shell-linux64", "chrome-headless-shell"),
];
const exe = CANDIDATES.find((p) => existsSync(p));

const errors = [];
const browser = await chromium.launch(exe ? { executablePath: exe } : {});

async function shot(name, viewport, fullPage) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`[${name}] console: ${m.text()}`);
  });
  page.on("pageerror", (e) => errors.push(`[${name}] pageerror: ${e.message}`));
  await page.goto(URL_, { waitUntil: "networkidle", timeout: 60000 });
  await page.waitForTimeout(1200);

  const text = (await page.locator("body").innerText()).trim();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth + 1,
  );
  const path = join(OUT, `${TAG}-${name}.png`);
  await page.screenshot({ path, fullPage });
  await ctx.close();
  return { name, chars: text.length, overflow, path, sample: text.slice(0, 160) };
}

const results = [];
results.push(await shot("desktop", { width: 1440, height: 900 }, false));
results.push(await shot("desktop-full", { width: 1440, height: 900 }, true));
results.push(await shot("mobile", { width: 390, height: 844 }, true));

await browser.close();
console.log(JSON.stringify({ url: URL_, errors, results }, null, 2));
