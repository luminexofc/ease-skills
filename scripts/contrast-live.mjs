// Sample actual painted pixels to settle contrast questions the DOM gets wrong
// (alpha backgrounds over a parent) and to catch overlap.
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
await p.goto(process.env.SMOKE_URL || "http://127.0.0.1:8080/", { waitUntil: "networkidle" });
await p.waitForTimeout(1000);

const res = await p.evaluate(() => {
  const parse = (c) => {
    const m = c.match(/[\d.]+/g);
    if (!m) return null;
    return m.slice(0, 3).map(Number);
  };
  const lum = ([r, g, bl]) => {
    const f = (v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(bl);
  };
  const ratio = (a, bb) => {
    const [l1, l2] = [lum(a), lum(bb)].sort((x, y) => y - x);
    return (l1 + 0.05) / (l2 + 0.05);
  };

  // Resolve effective background by compositing alpha layers down to body.
  const effectiveBg = (el) => {
    const layers = [];
    let n = el;
    while (n) {
      const cs = getComputedStyle(n);
      const c = cs.backgroundColor;
      const m = c.match(/[\d.]+/g);
      if (m) {
        const [r, g, bl, a = 1] = m.map(Number);
        if (Number(a) > 0) layers.push([r, g, bl, Number(a)]);
      }
      n = n.parentElement;
    }
    let out = [255, 255, 255];
    for (let i = layers.length - 1; i >= 0; i--) {
      const [r, g, bl, a] = layers[i];
      out = [r * a + out[0] * (1 - a), g * a + out[1] * (1 - a), bl * a + out[2] * (1 - a)];
    }
    return out;
  };

  const check = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return { sel, missing: true };
    const cs = getComputedStyle(el);
    const fg = parse(cs.color);
    const bg = effectiveBg(el);
    const size = parseFloat(cs.fontSize);
    const large = size >= 18.66 || (size >= 14 && Number(cs.fontWeight) >= 700);
    const need = large ? 3 : 4.5;
    return {
      sel,
      text: el.textContent.trim().slice(0, 40),
      size: cs.fontSize,
      fg: fg && fg.map(Math.round).join(","),
      bg: bg.map(Math.round).join(","),
      ratio: Math.round(ratio(fg, bg) * 100) / 100,
      need,
      pass: ratio(fg, bg) >= need,
    };
  };

  const header = document.querySelector("header");
  const filters = document.querySelector('section[aria-label="Filters"]');
  const hr = header.getBoundingClientRect();
  const fr = filters.getBoundingClientRect();

  return {
    checks: [
      check("header a span"),
      check("header a span:nth-child(2)"),
      check("main section p"),
      check("h1"),
      check("h1 + p"),
      check("main > div p"),
      check("li h2"),
      check("span.text-clay-ink"),
    ],
    headerH: Math.round(hr.height),
    filterTopStyle: getComputedStyle(filters).top,
    overlap: fr.top < hr.bottom - 0.5,
    navTabMinW: Math.min(
      ...[...document.querySelectorAll('[role="tab"]')].map((e) => e.getBoundingClientRect().width),
    ),
  };
});

console.log(JSON.stringify(res, null, 2));
await b.close();
