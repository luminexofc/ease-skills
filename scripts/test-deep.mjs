import { chromium } from "playwright";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
const C = join(homedir(), ".cache", "ms-playwright");
const exe = [join(C,"chromium-1254","chrome-linux64","chrome"), join(C,"chromium_headless_shell-1254","chrome-headless-shell-linux64","chrome-headless-shell")].find(p=>existsSync(p));
const b = await chromium.launch(exe?{executablePath:exe}:{});
const p = await b.newPage({viewport:{width:1440,height:900}});
const errs=[]; p.on("pageerror",e=>errs.push(e.message)); p.on("console",m=>m.type()==="error"&&errs.push(m.text()));
await p.goto("http://127.0.0.1:8080/",{waitUntil:"networkidle"});
await p.waitForTimeout(3000);
const before = await p.locator("main ul > li").count();
const total = await p.evaluate(()=>document.body.innerText.match(/([\d,]+)\s*free listing/)?.[1] ?? "?");
// click load more repeatedly
for (let i=0;i<3;i++){
  const btn = p.getByRole("button",{name:/^(Show \d+ more|Load more from the index)$/});
  if (await btn.count()===0) break;
  await btn.click(); await p.waitForTimeout(1200);
}
const after = await p.locator("main ul > li").count();
console.log(JSON.stringify({before, after, headerCount: total, errors: errs}, null, 2));
await b.close();
