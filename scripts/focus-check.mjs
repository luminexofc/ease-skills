// Focus-ring verification via real keyboard traversal, and skip-link behaviour.
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
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
await p.goto("http://127.0.0.1:8080/", { waitUntil: "networkidle" });
await p.waitForTimeout(1200);

// Tab from the top: the first focusable should be the skip link, and it must grow
await p.keyboard.press("Tab");
await p.waitForTimeout(250);
const first = await p.evaluate(() => {
  const el = document.activeElement;
  const cs = getComputedStyle(el);
  const r = el.getBoundingClientRect();
  return {
    text: el.textContent.trim(),
    tag: el.tagName,
    w: Math.round(r.width),
    h: Math.round(r.height),
    outline: `${cs.outlineStyle} ${cs.outlineWidth} ${cs.outlineColor}`,
  };
});

// Continue tabbing and record the outline on each stop
const stops = [];
for (let i = 0; i < 8; i++) {
  await p.keyboard.press("Tab");
  await p.waitForTimeout(120);
  stops.push(
    await p.evaluate(() => {
      const el = document.activeElement;
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return {
        tag: el.tagName,
        label: (el.textContent || el.getAttribute("aria-label") || "").trim().slice(0, 28),
        outline: `${cs.outlineStyle} ${cs.outlineWidth}`,
        color: cs.outlineColor,
        offset: cs.outlineOffset,
        w: Math.round(r.width),
        h: Math.round(r.height),
      };
    }),
  );
}

console.log(JSON.stringify({ skipLink: first, stops }, null, 2));
await b.close();
