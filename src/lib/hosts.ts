import { classifyCategory, detectKind, installLines, listingId, normalizeLicense } from "@/lib/classify";
import type { DiscoveredVia, Listing } from "@/lib/types";

export const FETCH_UA = "EaseSkills/1.0 (public free-skill index)";

const DEFAULT_ACCEPT =
  "application/vnd.github+json, application/json;q=0.9, text/plain;q=0.8";

export type FetchTextResult = { ok: boolean; status: number; text: string };

export async function fetchText(
  url: string,
  ms = 8000,
  accept = DEFAULT_ACCEPT,
): Promise<FetchTextResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { "User-Agent": FETCH_UA, Accept: accept },
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text };
  } catch {
    return { ok: false, status: 0, text: "" };
  } finally {
    clearTimeout(timer);
  }
}

export function clip(text: string, n = 220): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= n) return clean;
  return `${clean.slice(0, n - 1).trim()}…`;
}

export type GithubRepo = {
  full_name: string;
  name: string;
  html_url: string;
  description: string | null;
  stargazers_count?: number;
  updated_at?: string;
  topics?: string[];
  license?: { spdx_id?: string | null } | null;
  owner?: { login?: string };
};

export function githubRepoToListing(repo: GithubRepo, via?: DiscoveredVia[]): Listing | null {
  const license = normalizeLicense(repo.license?.spdx_id);
  if (!license) return null;
  const topics = repo.topics ?? [];
  const description = repo.description?.trim() || "";
  const kind = detectKind(repo.name || repo.full_name, description, topics);
  if (!kind) return null;
  const html = repo.html_url;
  const item: Listing = {
    id: listingId(html),
    kind,
    name: repo.full_name,
    description: clip(description || `${kind === "skill" ? "Agent skill" : "MCP server"} on GitHub.`),
    category: classifyCategory(`${repo.name} ${description} ${topics.join(" ")}`),
    source: "github",
    url: html,
    owner: repo.owner?.login || repo.full_name.split("/")[0] || "",
    license,
    stars: repo.stargazers_count ?? null,
    updated: repo.updated_at ?? null,
    install: installLines({ kind, url: html, license, source: "github" }),
    access: "Public GitHub repository. Free license. Clone it with no account.",
    topics: topics.slice(0, 6),
  };
  if (via?.length) item.via = via;
  return item;
}

const RESERVED_OWNERS = new Set([
  "about",
  "apps",
  "collections",
  "customer-stories",
  "enterprise",
  "events",
  "explore",
  "features",
  "issues",
  "login",
  "marketplace",
  "new",
  "notifications",
  "orgs",
  "organizations",
  "pricing",
  "readme",
  "search",
  "security",
  "settings",
  "site",
  "sponsors",
  "topics",
  "trending",
]);

const RESERVED_REPOS = new Set([
  "actions",
  "blob",
  "discussions",
  "issues",
  "pulls",
  "releases",
  "tree",
  "wiki",
]);

/** Turn any blob of text into unique `owner/repo` pairs, ignoring non-repo GitHub URLs. */
export function githubReposFromText(text: string, max = 12): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const pattern = /https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:[/?#][^\s"'<>)]*)?/g;
  for (const match of text.matchAll(pattern)) {
    const owner = match[1];
    const repo = match[2].replace(/\.git$/i, "").replace(/[.,;:]+$/, "");
    if (!owner || !repo) continue;
    if (RESERVED_OWNERS.has(owner.toLowerCase())) continue;
    if (RESERVED_REPOS.has(repo.toLowerCase())) continue;
    const full = `${owner}/${repo}`;
    const key = full.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    found.push(full);
    if (found.length >= max) break;
  }
  return found;
}

export function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}
