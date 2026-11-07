import type { CategoryId, DiscoveredVia, Kind, Listing, SourceId } from "@/lib/types";

export const CATEGORIES: { id: CategoryId | "all"; label: string }[] = [
  { id: "all", label: "All" },
  { id: "design", label: "Design" },
  { id: "development", label: "Development" },
  { id: "video", label: "Video" },
  { id: "writing", label: "Writing" },
  { id: "research", label: "Research" },
  { id: "data", label: "Data" },
  { id: "automation", label: "Automation" },
  { id: "productivity", label: "Productivity" },
];

export const SOURCES: { id: SourceId; label: string }[] = [
  { id: "github", label: "GitHub" },
  { id: "gitlab", label: "GitLab" },
  { id: "bitbucket", label: "Bitbucket" },
];

const FREE = new Set([
  "MIT",
  "MIT-0",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "BSD-3-Clause-Clear",
  "ISC",
  "MPL-2.0",
  "Unlicense",
  "0BSD",
  "Zlib",
  "BSL-1.0",
  "CC0-1.0",
  "Artistic-2.0",
  "PostgreSQL",
  "WTFPL",
  "EUPL-1.2",
  "GPL-2.0",
  "GPL-3.0",
  "AGPL-3.0",
  "LGPL-2.0",
  "LGPL-2.1",
  "LGPL-3.0",
]);

const CATEGORY_RULES: { id: CategoryId; words: string[] }[] = [
  {
    id: "video",
    words: [
      "video",
      "ffmpeg",
      "subtitle",
      "storyboard",
      "animation",
      "remotion",
      "youtube",
      "gif",
      "caption",
      "shot",
    ],
  },
  {
    id: "design",
    words: [
      "design",
      "figma",
      "canvas",
      "brand",
      "poster",
      "frontend",
      "drawio",
      "diagram",
      "typography",
      "css",
      "ui ",
      "blender",
    ],
  },
  {
    id: "writing",
    words: [
      "writing",
      "docx",
      "pdf",
      "pptx",
      "slides",
      "markdown",
      "copywriting",
      "comms",
      "documentation",
      "notion",
    ],
  },
  {
    id: "data",
    words: [
      "database",
      "sql",
      "postgres",
      "sqlite",
      "redis",
      "spreadsheet",
      "xlsx",
      "csv",
      "analytics",
      "warehouse",
    ],
  },
  {
    id: "research",
    words: ["research", "arxiv", "paper", "search", "docs", "knowledge", "fetch", "wikipedia"],
  },
  {
    id: "automation",
    words: [
      "automation",
      "browser",
      "playwright",
      "puppeteer",
      "workflow",
      "scrape",
      "selenium",
      "chrome",
    ],
  },
  {
    id: "productivity",
    words: ["memory", "calendar", "slack", "email", "task", "notes", "todo", "obsidian"],
  },
  {
    id: "development",
    words: [
      "code",
      "git",
      "github",
      "gitlab",
      "sdk",
      "debug",
      "test",
      "api",
      "server",
      "developer",
    ],
  },
];

export function normalizeLicense(spdx: string | null | undefined): string | null {
  if (!spdx) return null;
  const clean = spdx.trim();
  if (!clean || clean === "NOASSERTION" || clean === "OTHER" || clean === "NONE") return null;
  const base = clean.replace(/-only$/, "").replace(/-or-later$/, "");
  if (FREE.has(clean) || FREE.has(base)) return clean;
  return null;
}

export function licenseFromText(text: string): string | null {
  const t = text.slice(0, 6000).toLowerCase();
  if (!t.trim()) return null;
  if (t.includes("apache license") && t.includes("version 2.0")) return "Apache-2.0";
  if (t.includes("gnu affero general public license")) return "AGPL-3.0";
  if (t.includes("gnu lesser general public license") || t.includes("gnu library general public license"))
    return "LGPL-3.0";
  if (t.includes("gnu general public license")) return "GPL-3.0";
  if (t.includes("mozilla public license")) return "MPL-2.0";
  if (t.includes("permission is hereby granted, free of charge")) return "MIT";
  if (t.includes("this is free and unencumbered software")) return "Unlicense";
  if (t.includes("bsd zero clause") || t.includes("zero-clause bsd")) return "0BSD";
  if (t.includes("creative commons") && t.includes("cc0")) return "CC0-1.0";
  if (t.includes("isc license") || t.includes("permission to use, copy, modify, and/or distribute"))
    return "ISC";
  if (t.includes("redistribution and use in source and binary forms")) {
    if (t.includes("neither the name")) return "BSD-3-Clause";
    return "BSD-2-Clause";
  }
  if (t.includes("all rights reserved") && !t.includes("permission")) return null;
  return null;
}

export function classifyCategory(text: string): CategoryId {
  const hay = ` ${text.toLowerCase()} `;
  let best: CategoryId = "development";
  let score = 0;
  for (const rule of CATEGORY_RULES) {
    let n = 0;
    for (const word of rule.words) {
      if (hay.includes(word)) n += 1;
    }
    if (n > score) {
      score = n;
      best = rule.id;
    }
  }
  return best;
}

export function detectKind(name: string, description: string, topics: string[]): Kind | null {
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
  if (skill && mcp) {
    if (name.toLowerCase().includes("skill")) return "skill";
    return "mcp";
  }
  if (skill) return "skill";
  if (mcp) return "mcp";
  return null;
}

export function categoryQuery(category: CategoryId | "all" | undefined): string {
  switch (category) {
    case "design":
      return "(design OR figma OR canvas OR brand OR frontend)";
    case "video":
      return "(video OR ffmpeg OR animation OR subtitle OR storyboard)";
    case "writing":
      return "(writing OR pdf OR docx OR slides OR markdown)";
    case "research":
      return "(research OR search OR docs OR papers)";
    case "data":
      return "(database OR sql OR postgres OR spreadsheet OR redis)";
    case "automation":
      return "(browser OR playwright OR automation OR workflow)";
    case "productivity":
      return "(memory OR notes OR slack OR calendar OR tasks)";
    case "development":
      return "(git OR code OR sdk OR testing OR api)";
    default:
      return "";
  }
}

export function installLines(listing: {
  kind: Kind;
  url: string;
  license: string;
  source: SourceId;
}): string {
  const clone = listing.url.replace(/\/$/, "");
  if (listing.kind === "skill") {
    return [
      `# ${listing.license} · public ${listing.source} repo · no account`,
      `git clone --depth 1 ${clone}.git`,
      `# Copy the skill folder (the one with SKILL.md) into your agent:`,
      `# Claude Code  ~/.claude/skills/`,
      `# Cursor       .cursor/skills/`,
      `# Codex        .agents/skills/`,
    ].join("\n");
  }
  return [
    `# ${listing.license} · public source · free to read, clone, and run`,
    `git clone --depth 1 ${clone}.git`,
    `# Follow the README to register it with any MCP client.`,
    `# No paid plan is required to get the code.`,
  ].join("\n");
}

export function listingId(url: string): string {
  return url.replace(/\/+$/, "").toLowerCase();
}

export function mergeVia(
  a?: DiscoveredVia[],
  b?: DiscoveredVia[],
): DiscoveredVia[] | undefined {
  const set = new Set<DiscoveredVia>([...(a ?? []), ...(b ?? [])]);
  if (!set.size) return undefined;
  return (["reddit", "x"] as DiscoveredVia[]).filter((v) => set.has(v));
}

export function asListing(partial: Omit<Listing, "id"> & { id?: string }): Listing {
  return { ...partial, id: partial.id ?? listingId(partial.url) };
}
