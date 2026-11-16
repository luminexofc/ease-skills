#!/usr/bin/env node
/**
 * Build a large local index of free, public agent skills and MCP servers.
 *
 * Why this exists: the app's runtime scan issues one search per kind with
 * `per_page=15` and no pagination, so it can only ever surface a few dozen
 * repositories. GitHub search returns the license, topics, stars and push date
 * in the *same* payload, so a paginated search is a far cheaper way to build
 * breadth than enumerating repos through the core API (which allows 60/hour
 * anonymously, versus 10 search requests/minute).
 *
 * Output: src/data/index.json (server-only; never bundled into the client).
 *
 *   node scripts/crawl-index.mjs [--pages 5] [--out src/data/index.json]
 */
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const UA = "EaseSkillsIndex/1.0 (+https://github.com)";

const args = process.argv.slice(2);
const argOf = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i === -1 ? fallback : args[i + 1] ?? fallback;
};
const PAGES = Number(argOf("--pages", "8"));
// Resume a long crawl at a given query: `--skip 23` starts at query 24.
const SKIP = Math.max(0, Number(argOf("--skip", "0")) || 0);
const OUT = join(ROOT, argOf("--out", "src/data/index.json"));

// Same free-license allowlist the app uses, duplicated here because this is a
// plain Node script with no bundler aliases.
const FREE = new Set([
  "MIT", "MIT-0", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "BSD-3-Clause-Clear",
  "ISC", "MPL-2.0", "Unlicense", "0BSD", "Zlib", "BSL-1.0", "CC0-1.0", "Artistic-2.0",
  "PostgreSQL", "WTFPL", "EUPL-1.2", "GPL-2.0", "GPL-3.0", "AGPL-3.0",
  "LGPL-2.0", "LGPL-2.1", "LGPL-3.0", "CC-BY-4.0", "CC-BY-SA-4.0", "OFL-1.1",
]);

// Queries chosen to cover the naming and topic conventions these projects
// actually use. Each returns up to 100 repos per page with license included.
const QUERIES = [
  "topic:agent-skills",
  "topic:agent-skill",
  "topic:claude-skills",
  "topic:claude-skill",
  "topic:claude-code",
  "topic:ai-agents topic:skills",
  "topic:skills topic:agents",
  "topic:skill",
  "topic:skills",
  "topic:mcp-server",
  "topic:mcp-servers",
  "topic:model-context-protocol",
  "topic:mcp",
  "topic:mcp-client",
  "mcp-server in:name",
  "mcp server in:name",
  "\"SKILL.md\" in:readme",
  "SKILL.md in:path",
  "claude-skills in:readme",
  "agent-skills in:readme",
  "agent skill in:description",
  "skills in:name agent",
  "skill in:name claude",
  "awesome-mcp in:name",
  "awesome-skills in:name",
  "mcp in:name server",
  "cursor mcp in:description",
  // Threads, Google rankings / SEO, and social publishing skills + servers.
  "topic:seo",
  "topic:seo-tools",
  "topic:google-search",
  "google ranking in:readme",
  "keyword research in:readme",
  "topic:threads-api",
  "threads api in:readme",
  "topic:social-media topic:skills",
  "topic:social-media topic:mcp",
  "google-analytics in:readme",
  "mcp server free in:description",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freeLicense(spdx) {
  if (!spdx) return null;
  const clean = String(spdx).trim();
  if (!clean || ["NOASSERTION", "OTHER", "NONE"].includes(clean)) return null;
  const base = clean.replace(/-only$/, "").replace(/-or-later$/, "");
  return FREE.has(clean) || FREE.has(base) ? clean : null;
}

function detectKind(name, description, topics) {
  const topicSet = new Set(topics.map((t) => t.toLowerCase()));
  const blob = `${name} ${description}`.toLowerCase();
  const skill =
    blob.includes("skill.md") ||
    blob.includes("agent skill") ||
    blob.includes("agent skills") ||
    blob.includes("claude skill") ||
    topicSet.has("agent-skills") ||
    topicSet.has("claude-skills") ||
    topicSet.has("agentskills") ||
    topicSet.has("skills") ||
    /(^|[-_/])skills?$/.test(name.toLowerCase());
  const mcp =
    /(^|[-_/])mcp([-_/]|$)/.test(name.toLowerCase()) ||
    name.toLowerCase().includes("mcp-server") ||
    name.toLowerCase().endsWith("-mcp") ||
    blob.includes("mcp server") ||
    blob.includes("mcp-server") ||
    blob.includes("model context protocol") ||
    topicSet.has("mcp") ||
    topicSet.has("mcp-server") ||
    topicSet.has("model-context-protocol");
  if (skill && mcp) return name.toLowerCase().includes("skill") ? "skill" : "mcp";
  if (skill) return "skill";
  if (mcp) return "mcp";
  return null;
}

const RULES = [
  ["video", ["video", "ffmpeg", "subtitle", "storyboard", "animation", "remotion", "youtube", "gif", "caption", "shot"]],
  ["design", ["design", "figma", "canvas", "brand", "poster", "frontend", "drawio", "diagram", "typography", "css", "ui ", "blender"]],
  ["writing", ["writing", "docx", "pdf", "pptx", "slides", "markdown", "copywriting", "comms", "documentation", "notion"]],
  ["data", ["database", "sql", "postgres", "sqlite", "redis", "spreadsheet", "xlsx", "csv", "analytics", "warehouse"]],
  ["research", ["research", "arxiv", "paper", "search", "docs", "knowledge", "fetch", "wikipedia"]],
  ["automation", ["automation", "browser", "playwright", "puppeteer", "workflow", "scrape", "selenium", "chrome"]],
  ["productivity", ["memory", "calendar", "slack", "email", "task", "notes", "todo", "obsidian"]],
  ["development", ["code", "git", "github", "gitlab", "sdk", "debug", "test", "api", "server", "developer"]],
];

function classify(text) {
  const hay = ` ${text.toLowerCase()} `;
  let best = "development";
  let score = 0;
  for (const [id, words] of RULES) {
    let n = 0;
    for (const w of words) if (hay.includes(w)) n += 1;
    if (n > score) {
      score = n;
      best = id;
    }
  }
  return best;
}

const clip = (text, n = 220) => {
  const clean = String(text ?? "").replace(/\s+/g, " ").trim();
  if (clean.length <= n) return clean;
  return `${clean.slice(0, n - 1).trim()}…`;
};

function installLines(kind, url, license) {
  const clone = url.replace(/\/$/, "");
  if (kind === "skill") {
    return [
      `# ${license} · public repo · no account`,
      `git clone --depth 1 ${clone}.git`,
      "# Copy the folder that holds SKILL.md into your agent:",
      "# Claude Code  ~/.claude/skills/",
      "# Cursor       .cursor/skills/",
      "# Codex        .agents/skills/",
    ].join("\n");
  }
  return [
    `# ${license} · public source · free to read, clone, and run`,
    `git clone --depth 1 ${clone}.git`,
    "# Follow the README to register it with any MCP client.",
    "# No paid plan is required to get the code.",
  ].join("\n");
}

async function searchPage(query, page) {
  const url =
    "https://api.github.com/search/repositories?q=" +
    encodeURIComponent(`${query} fork:false archived:false`) +
    `&sort=stars&order=desc&per_page=100&page=${page}`;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/vnd.github+json" },
    });
    if (res.status === 403 || res.status === 429) {
      const reset = Number(res.headers.get("x-ratelimit-reset") ?? 0) * 1000;
      const wait = Math.min(Math.max(reset - Date.now(), 5000), 65000);
      console.error(`  rate limited, waiting ${Math.round(wait / 1000)}s`);
      await sleep(wait);
      continue;
    }
    if (!res.ok) {
      console.error(`  ${res.status} for ${query} page ${page}`);
      return { items: [], ok: false };
    }
    const json = await res.json();
    return { items: json.items ?? [], ok: true, total: json.total_count ?? 0 };
  }
  return { items: [], ok: false };
}

const byId = new Map();
let requests = 0;

// Resume: a crawl can be interrupted (or re-run with more queries), so start
// from whatever is already on disk and union into it instead of replacing it.
if (existsSync(OUT)) {
  try {
    const prior = JSON.parse(readFileSync(OUT, "utf8"));
    for (const item of prior.items ?? []) if (item?.id) byId.set(item.id, item);
    console.error(`resuming from ${byId.size} existing listings`);
  } catch {
    console.error("existing index unreadable, starting fresh");
  }
}

function writeSnapshot() {
  const items = [...byId.values()].sort(
    (a, b) => (b.stars ?? -1) - (a.stars ?? -1) || a.name.localeCompare(b.name),
  );
  const payload = {
    generatedAt: new Date().toISOString(),
    requests,
    count: items.length,
    items,
  };
  writeFileSync(OUT, JSON.stringify(payload, null, 0) + "\n");
  return items.length;
}

for (const query of QUERIES.slice(SKIP)) {
  for (let page = 1; page <= PAGES; page += 1) {
    const { items, ok, total } = await searchPage(query, page);
    requests += 1;
    if (!ok || items.length === 0) break;
    let added = 0;
    for (const repo of items) {
      const license = freeLicense(repo.license?.spdx_id);
      if (!license) continue;
      const topics = repo.topics ?? [];
      const description = repo.description ?? "";
      const kind = detectKind(repo.name || repo.full_name, description, topics);
      if (!kind) continue;
      const url = repo.html_url;
      const id = url.replace(/\/+$/, "").toLowerCase();
      if (byId.has(id)) continue;
      byId.set(id, {
        id,
        kind,
        name: repo.full_name,
        description: clip(description || `${kind === "skill" ? "Agent skill" : "MCP server"} on GitHub.`),
        category: classify(`${repo.name} ${description} ${topics.join(" ")}`),
        source: "github",
        url,
        owner: repo.owner?.login ?? repo.full_name.split("/")[0],
        license,
        stars: repo.stargazers_count ?? null,
        updated: repo.pushed_at ?? repo.updated_at ?? null,
        install: installLines(kind, url, license),
        access: "Public GitHub repository. Free license. Clone it with no account.",
        topics: topics.slice(0, 6),
      });
      added += 1;
    }
    console.error(
      `page ${page}/${PAGES} ${query.slice(0, 30).padEnd(30)} +${String(added).padStart(3)}  total ${byId.size}/${total ?? "?"}`,
    );
    // Anonymous search allows 10 requests per minute; stay under it.
    await sleep(6500);
  }
  // Persist after every query so an interrupted crawl still leaves a usable
  // index, and a later run picks up from here.
  writeSnapshot();
}

// Guarantee the curated seed entries stay present even if a search pass misses
// them (star counts change, topics get edited). Read the existing catalog ids.
const catalogPath = join(ROOT, "src/data/catalog.ts");
if (existsSync(catalogPath)) {
  const src = readFileSync(catalogPath, "utf8");
  const ids = [...src.matchAll(/"id":\s*"([^"]+)"/g)].map((m) => m[1]);
  console.error(`catalog seed ids: ${ids.length} (kept separate, merged at read time)`);
}

const finalCount = writeSnapshot();
console.error(`\nwrote ${finalCount} listings to ${OUT} after ${requests} search requests`);
