import { createServerFn } from "@tanstack/react-start";
import {
  classifyCategory,
  detectKind,
  installLines,
  licenseFromText,
  listingId,
} from "@/lib/classify";
import { clip, fetchText, githubRepoToListing, type GithubRepo } from "@/lib/hosts";
import type { CategoryId, Kind, Listing, ScanNote, ScanResult, SourceId } from "@/lib/types";

const BITBUCKET_WORKSPACES = ["atlassian", "unctad", "_nkhalasi", "toryt", "daam4110"];

type ScanInput = {
  query?: string;
  kind: Kind | "all";
  sources: SourceId[];
  category?: CategoryId | "all";
};

function githubQueries(input: ScanInput): string[] {
  const cat =
    input.category && input.category !== "all"
      ? {
          design: "design",
          video: "video",
          writing: "writing",
          research: "research",
          data: "database",
          automation: "browser",
          productivity: "notes",
          development: "git",
        }[input.category]
      : "";
  const user = (input.query ?? "").replace(/\b(or|and|not)\b/gi, " ").replace(/[^\w\s.+#_-]/g, " ").trim();
  const tail = [cat, user, "fork:false", "archived:false"].filter(Boolean).join(" ");
  const queries: string[] = [];
  if (input.kind !== "skill") queries.push(`mcp-server in:name ${tail}`.replace(/\s+/g, " ").trim());
  if (input.kind !== "mcp") queries.push(`"SKILL.md" in:readme ${tail}`.replace(/\s+/g, " ").trim());
  return queries;
}

async function scanGithub(input: ScanInput): Promise<{ items: Listing[]; note: ScanNote }> {
  const items: Listing[] = [];
  const seen = new Set<string>();
  let limited = false;
  let failed = false;
  for (const q of githubQueries(input)) {
    const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=15`;
    const res = await fetchText(url, 10000);
    if (!res.ok) {
      if (res.status === 403 || res.status === 429) limited = true;
      else failed = true;
      continue;
    }
    let payload: { items?: GithubRepo[] } = {};
    try {
      payload = JSON.parse(res.text) as { items?: GithubRepo[] };
    } catch {
      failed = true;
      continue;
    }
    for (const repo of payload.items ?? []) {
      const item = githubRepoToListing(repo);
      if (!item) continue;
      if (input.kind !== "all" && item.kind !== input.kind) continue;
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      items.push(item);
    }
  }
  if (!items.length && limited) {
    return {
      items: [],
      note: {
        source: "github",
        status: "limited",
        detail: "GitHub is rate-limiting anonymous search. The saved index is still here.",
      },
    };
  }
  if (!items.length && failed) {
    return {
      items: [],
      note: { source: "github", status: "error", detail: "GitHub search did not respond." },
    };
  }
  return {
    items,
    note: {
      source: "github",
      status: "ok",
      detail: items.length
        ? `${items.length} free ${items.length === 1 ? "repository" : "repositories"} on GitHub.`
        : "No new free GitHub matches for that search.",
    },
  };
}

async function gitlabLicense(projectId: number, branch: string): Promise<string | null> {
  const names = ["LICENSE", "LICENSE.md", "LICENSE.txt", "LICENCE", "COPYING", "COPYING.md"];
  for (const name of names) {
    const url = `https://gitlab.com/api/v4/projects/${projectId}/repository/files/${encodeURIComponent(name)}/raw?ref=${encodeURIComponent(branch || "main")}`;
    const res = await fetchText(url, 6000);
    if (!res.ok) continue;
    const spdx = licenseFromText(res.text);
    if (spdx) return spdx;
  }
  return null;
}

async function scanGitlab(input: ScanInput): Promise<{ items: Listing[]; note: ScanNote }> {
  const catWord =
    input.category && input.category !== "all"
      ? {
          design: "design",
          video: "video",
          writing: "writing",
          research: "research",
          data: "database",
          automation: "browser",
          productivity: "notes",
          development: "code",
        }[input.category]
      : "";
  const words = [
    input.query?.trim(),
    input.kind === "skill" ? "agent skills" : input.kind === "mcp" ? "mcp server" : "mcp",
    catWord,
  ]
    .filter(Boolean)
    .join(" ");
  const url = `https://gitlab.com/api/v4/projects?search=${encodeURIComponent(words)}&visibility=public&order_by=star_count&sort=desc&per_page=12`;
  const res = await fetchText(url, 10000);
  if (!res.ok) {
    return {
      items: [],
      note: { source: "gitlab", status: "error", detail: "GitLab search did not respond." },
    };
  }
  let projects: GitlabProject[] = [];
  try {
    const parsed = JSON.parse(res.text) as GitlabProject[] | { message?: string };
    if (!Array.isArray(parsed)) {
      return {
        items: [],
        note: { source: "gitlab", status: "error", detail: "GitLab search was refused." },
      };
    }
    projects = parsed;
  } catch {
    return {
      items: [],
      note: { source: "gitlab", status: "error", detail: "GitLab returned an unreadable response." },
    };
  }
  const candidates = projects.filter((p) => {
    const kind = detectKind(p.path_with_namespace || p.name || "", p.description || "", p.topics || []);
    return kind && (input.kind === "all" || kind === input.kind);
  }).slice(0, 6);

  const settled = await Promise.all(
    candidates.map(async (p) => {
      const license = await gitlabLicense(p.id, p.default_branch || "main");
      if (!license) return null;
      const kind = detectKind(p.path_with_namespace || "", p.description || "", p.topics || []);
      if (!kind) return null;
      const web = p.web_url;
      const topics = p.topics ?? [];
      const description = p.description?.trim() || "";
      const item: Listing = {
        id: listingId(web),
        kind,
        name: p.path_with_namespace,
        description: clip(description || `Public ${kind} on GitLab.`),
        category: classifyCategory(`${p.name} ${description} ${topics.join(" ")}`),
        source: "gitlab",
        url: web,
        owner: (p.path_with_namespace || "").split("/")[0] || "",
        license,
        stars: p.star_count ?? null,
        updated: p.last_activity_at ?? null,
        install: installLines({ kind, url: web, license, source: "gitlab" }),
        access: "Public GitLab project. License file checked. Free to clone.",
        topics: topics.slice(0, 6),
      };
      return item;
    }),
  );

  const items = settled.filter((x): x is Listing => x !== null);
  return {
    items,
    note: {
      source: "gitlab",
      status: "ok",
      detail: items.length
        ? `${items.length} free GitLab ${items.length === 1 ? "project" : "projects"} with a verified license.`
        : "No GitLab project in this pass had both a match and a free license file.",
    },
  };
}

type GitlabProject = {
  id: number;
  name: string;
  path_with_namespace: string;
  description: string | null;
  web_url: string;
  star_count?: number;
  last_activity_at?: string;
  default_branch?: string;
  topics?: string[];
};

async function bitbucketLicense(fullName: string, branch: string): Promise<string | null> {
  const names = ["LICENSE", "LICENSE.md", "LICENSE.txt", "LICENCE", "COPYING"];
  for (const name of names) {
    const url = `https://api.bitbucket.org/2.0/repositories/${fullName}/src/${encodeURIComponent(branch)}/${name}`;
    const res = await fetchText(url, 6000);
    if (!res.ok) continue;
    const spdx = licenseFromText(res.text);
    if (spdx) return spdx;
  }
  return null;
}

async function scanBitbucket(input: ScanInput): Promise<{ items: Listing[]; note: ScanNote }> {
  const term = (input.query?.trim() || (input.kind === "skill" ? "skill" : "mcp"))
    .replace(/[^a-zA-Z0-9 ._-]/g, " ")
    .trim()
    .slice(0, 40) || "mcp";
  const q = `name ~ "${term.replace(/"/g, "")}" OR description ~ "${term.replace(/"/g, "")}"`;
  const pages = await Promise.all(
    BITBUCKET_WORKSPACES.map(async (ws) => {
      const url = `https://api.bitbucket.org/2.0/repositories/${encodeURIComponent(ws)}?${new URLSearchParams({
        q,
        pagelen: "8",
      })}`;
      const res = await fetchText(url, 8000);
      if (!res.ok) return [] as BitbucketRepo[];
      try {
        const parsed = JSON.parse(res.text) as { values?: BitbucketRepo[] };
        return parsed.values ?? [];
      } catch {
        return [];
      }
    }),
  );
  const repos = pages.flat().filter((r) => r && r.is_private !== true && r.full_name && r.links?.html?.href);
  const unique = new Map<string, BitbucketRepo>();
  for (const repo of repos) unique.set(repo.full_name, repo);
  const shortlist = [...unique.values()]
    .filter((r) => detectKind(r.full_name, r.description || "", []))
    .slice(0, 6);
  const settled = await Promise.all(
    shortlist.map(async (r) => {
      const branch = r.mainbranch?.name || "main";
      const license = await bitbucketLicense(r.full_name, branch);
      if (!license) return null;
      const kind = detectKind(r.full_name, r.description || "", []);
      if (!kind || (input.kind !== "all" && kind !== input.kind)) return null;
      const web = r.links.html.href;
      const description = r.description?.trim() || "";
      const item: Listing = {
        id: listingId(web),
        kind,
        name: r.full_name,
        description: clip(description || `Public ${kind} on Bitbucket.`),
        category: classifyCategory(`${r.name} ${description}`),
        source: "bitbucket",
        url: web,
        owner: r.full_name.split("/")[0] || "",
        license,
        stars: null,
        updated: r.updated_on ?? null,
        install: installLines({ kind, url: web, license, source: "bitbucket" }),
        access: "Public Bitbucket repository. License file checked. Free to clone.",
        topics: [],
      };
      return item;
    }),
  );
  const items = settled.filter((x): x is Listing => x !== null);
  return {
    items,
    note: {
      source: "bitbucket",
      status: items.length ? "ok" : "limited",
      detail: items.length
        ? `${items.length} free Bitbucket ${items.length === 1 ? "repository" : "repositories"}.`
        : "Bitbucket has no anonymous global search. Checked public workspaces; nothing new had a free license.",
    },
  };
}

type BitbucketRepo = {
  full_name: string;
  name?: string;
  description?: string | null;
  is_private?: boolean;
  updated_on?: string;
  mainbranch?: { name?: string };
  links: { html: { href: string } };
};

export const scanHosts = createServerFn({ method: "POST" })
  .validator((input: unknown): ScanInput => {
    const raw = (input ?? {}) as Partial<ScanInput>;
    const kind = raw.kind === "skill" || raw.kind === "mcp" ? raw.kind : "all";
    const allowed = new Set<SourceId>(["github", "gitlab", "bitbucket"]);
    const sources = Array.isArray(raw.sources)
      ? raw.sources.filter((s): s is SourceId => allowed.has(s as SourceId))
      : (["github", "gitlab", "bitbucket"] as SourceId[]);
    const categories = new Set([
      "all",
      "design",
      "development",
      "video",
      "writing",
      "research",
      "data",
      "automation",
      "productivity",
    ]);
    const category = categories.has(String(raw.category))
      ? (raw.category as ScanInput["category"])
      : "all";
    const query = typeof raw.query === "string" ? raw.query.slice(0, 80) : "";
    return { query, kind, sources: sources.length ? sources : ["github"], category };
  })
  .handler(async ({ data }): Promise<ScanResult> => {
    const jobs: Promise<{ items: Listing[]; note: ScanNote }>[] = [];
    if (data.sources.includes("github")) jobs.push(scanGithub(data));
    if (data.sources.includes("gitlab")) jobs.push(scanGitlab(data));
    if (data.sources.includes("bitbucket")) jobs.push(scanBitbucket(data));
    const parts = await Promise.all(jobs);
    const seen = new Set<string>();
    const items: Listing[] = [];
    for (const part of parts) {
      for (const item of part.items) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        items.push(item);
      }
    }
    return { items, notes: parts.map((p) => p.note) };
  });
