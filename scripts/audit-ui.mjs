// Measure rendered UI: contrast, radii, shadows, motion, tap targets, structure.
import { chromium } from "playwright";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CACHE = join(homedir(), ".cache", "ms-playwright");
const exe = [
  join(CACHE, "chromium-1254", "chrome-linux64", "chrome"),
  join(CACHE, "chromium_headless_shell-1254", "chrome-headless-shell-linux64", "chrome-headless-shell"),
].find((p) => existsSync(p));

const browser = await chromium.launch(exe ? { executablePath: exe } : {});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(process.env.SMOKE_URL || "http://127.0.0.1:8080/", {
  waitUntil: "networkidle",
  timeout: 60000,
});
await page.waitForTimeout(1000);

const report = await page.evaluate(() => {
  const parse = (c) => {
    const m = c.match(/[\d.]+/g);
    return m ? m.slice(0, 3).map(Number) : null;
  };
  const lum = ([r, g, b]) => {
    const f = (v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const ratio = (a, b) => {
    const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (l1 + 0.05) / (l2 + 0.05);
  };
  const bgOf = (el) => {
    let n = el;
    while (n && n !== document.documentElement) {
      const c = getComputedStyle(n).backgroundColor;
      if (c && c !== "rgba(0, 0, 0, 0)" && !c.includes("rgba(0, 0, 0, 0)")) return parse(c);
      n = n.parentElement;
    }
    return parse(getComputedStyle(document.body).backgroundColor);
  };

  const lowContrast = [];
  const radii = {};
  const shadows = {};
  const tapTooSmall = [];
  const fontSizes = {};

  const els = [...document.querySelectorAll("body *")];
  for (const el of els) {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;

    radii[cs.borderRadius] = (radii[cs.borderRadius] || 0) + 1;
    if (cs.boxShadow !== "none") shadows[cs.boxShadow.slice(0, 40)] = (shadows[cs.boxShadow.slice(0, 40)] || 0) + 1;

    const hasText = [...el.childNodes].some(
      (n) => n.nodeType === 3 && n.textContent.trim().length > 0,
    );
    if (hasText) {
      const fg = parse(cs.color);
      const bg = bgOf(el);
      if (fg && bg) {
        const cr = ratio(fg, bg);
        const size = parseFloat(cs.fontSize);
        const large = size >= 18.66 || (size >= 14 && Number(cs.fontWeight) >= 700);
        const need = large ? 3 : 4.5;
        fontSizes[cs.fontSize] = (fontSizes[cs.fontSize] || 0) + 1;
        if (cr < need) {
          lowContrast.push({
            text: el.textContent.trim().slice(0, 50),
            tag: el.tagName,
            size: cs.fontSize,
            weight: cs.fontWeight,
            ratio: Math.round(cr * 100) / 100,
            need,
          });
        }
      }
    }

    const interactive = el.matches("button, a, select, input, [role='button'], [role='tab']");
    if (interactive && (r.height < 44 || r.width < 44)) {
      tapTooSmall.push({
        tag: el.tagName,
        label: (el.textContent || el.getAttribute("aria-label") || "").trim().slice(0, 30),
        w: Math.round(r.width),
        h: Math.round(r.height),
      });
    }
  }

  // animations running without user trigger
  const animated = [...document.querySelectorAll("body *")]
    .filter((el) => {
      const cs = getComputedStyle(el);
      return cs.animationName !== "none" && cs.animationIterationCount !== "1";
    })
    .map((el) => ({
      tag: el.tagName,
      cls: el.className?.toString().slice(0, 60),
      anim: getComputedStyle(el).animationName,
      iter: getComputedStyle(el).animationIterationCount,
    }));

  const fonts = [...new Set([...document.querySelectorAll("body *")].map((e) => getComputedStyle(e).fontFamily))];

  // structural outline
  const outline = [...document.querySelectorAll("header, main > section, main > ul, main > p, footer")]
    .slice(0, 14)
    .map((el) => ({
      tag: el.tagName,
      h: Math.round(el.getBoundingClientRect().height),
      sticky: getComputedStyle(el).position,
      text: el.textContent.trim().replace(/\s+/g, " ").slice(0, 60),
    }));

  return {
    counts: {
      elements: els.length,
      buttons: document.querySelectorAll("button").length,
      links: document.querySelectorAll("a").length,
      inputs: document.querySelectorAll("input").length,
      h1: document.querySelectorAll("h1").length,
      h2: document.querySelectorAll("h2").length,
      listItems: document.querySelectorAll("li").length,
    },
    lowContrast: lowContrast.slice(0, 25),
    lowContrastCount: lowContrast.length,
    radii,
    shadows,
    tapTooSmall: tapTooSmall.slice(0, 20),
    tapTooSmallCount: tapTooSmall.length,
    animated,
    fonts,
    fontSizes,
    outline,
    scrollHeight: document.documentElement.scrollHeight,
  };
});

console.log(JSON.stringify(report, null, 2));
await browser.close();
