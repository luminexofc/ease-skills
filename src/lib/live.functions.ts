import { createServerFn } from "@tanstack/react-start";
import { mergeVia } from "@/lib/classify";
import {
  fetchText,
  githubRepoToListing,
  githubReposFromText,
  isoDaysAgo,
  type GithubRepo,
} from "@/lib/hosts";
import type { DiscoveredVia, Listing, LiveSnapshot, ScanNote } from "@/lib/types";

const REFRESH_MS = 8 * 60 * 1000;
const REPO_CACHE_MS = 6 * 60 * 60 * 1000;
const FRESH_DAYS = 30;
const MAX_COMMUNITY_REPOS = 16;

const SUBREDDITS = ["mcp", "ClaudeAI", "ClaudeCode", "AI_Agents", "agentic", "LocalLLaMA"];

const X_INSTANCES = ["https://nitter.kareem.one", "https://nitter.tiekoetter.com"];

type RepoLookup = { at: number; listing: Listing | null };

const repoCache = new Map<string, RepoLookup>();
let snapshot: { at: number; items: Listing[]; notes: ScanNote[] } | null = null;
let inflight: Promise<{ at: number; items: Listing[]; notes: ScanNote[] }> | null = null;

async function lookupRepo(full: string): Promise<{ listing: Listing | null; limited: boolean }> {
  const key = full.toLowerCase();
  const cached = repoCache.get(key);
  if (cached && Date.now() - cached.at < REPO_CACHE_MS) {
    return { listing: cached.listing, limited: false };
  }
  const res = await fetchText(
    `https://api.github.com/repos/${full}`,
    9000,
    "application/vnd.github+json",
  );
  if (!res.ok) {
    return { listing: null, limited: res.status === 403 || res.status === 429 };
  }
  let listing: Listing | null = null;
  try {
    listing = githubRepoToListing(JSON.parse(res.text) as GithubRepo);
  } catch {
    listing = null;
  }
  repoCache.set(key, { at: Date.now(), listing });
  return { listing, limited: false };
}

async function scanGithubRecent(): Promise<{ items: Listing[]; note: ScanNote }> {
  const since = isoDaysAgo(FRESH_DAYS);
  const queries = [
    `"SKILL.md" in:readme pushed:>${since} fork:false archived:false`,
    `mcp-server in:name pushed:>${since} fork:false archived:false`,
  ];
  const items: Listing[] = [];
  const seen = new Set<string>();
  let limited = false;
  let failed = false;
  for (const query of queries) {
    const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=updated&order=desc&per_page=15`;
    const res = await fetchText(url, 10000, "application/vnd.github+json");
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
      if (!item || seen.has(item.id)) continue;
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
        ? `${items.length} free repositories pushed in the last ${FRESH_DAYS} days.`
        : "No fresh free GitHub repositories in this pass.",
    },
  };
}

type RedditPost = {
  title?: string;
  selftext?: string;
  url?: string;
  created_utc?: number;
  subreddit?: string;
};

const RELEVANT_REDDIT = /mcp|skill|agent|claude|codex|cursor/i;

async function redditPosts(): Promise<{ posts: RedditPost[]; ok: boolean }> {
  const posts: RedditPost[] = [];
  let anyOk = false;
  const settled = await Promise.all(
    SUBREDDITS.map(async (sub) => {
      const res = await fetchText(
        `https://arctic-shift.photon-reddit.com/api/posts/search?subreddit=${encodeURIComponent(sub)}&limit=40&sort=desc`,
        9000,
        "application/json",
      );
      if (!res.ok) return null;
      try {
        return (JSON.parse(res.text) as { data?: RedditPost[] }).data ?? [];
      } catch {
        return null;
      }
    }),
  );
  for (const part of settled) {
    if (!part) continue;
    anyOk = true;
    posts.push(...part);
  }
  if (!posts.length) {
    const fallback = await redditRss();
    if (fallback.length) return { posts: fallback, ok: true };
  }
  return { posts, ok: anyOk };
}

function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

async function redditRss(): Promise<RedditPost[]> {
  const posts: RedditPost[] = [];
  for (const sub of SUBREDDITS.slice(0, 3)) {
    const res = await fetchText(
      `https://www.reddit.com/r/${encodeURIComponent(sub)}/new/.rss`,
      9000,
      "application/rss+xml",
    );
    if (!res.ok) continue;
    for (const match of res.text.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
      const entry = match[1];
      const title = entry.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? "";
      const content = entry.match(/<content[^>]*>([\s\S]*?)<\/content>/)?.[1] ?? "";
      const updated = entry.match(/<updated>([\s\S]*?)<\/updated>/)?.[1] ?? "";
      posts.push({
        title: decodeEntities(title.replace(/<[^>]+>/g, " ")),
        selftext: decodeEntities(content.replace(/<[^>]+>/g, " ")),
        created_utc: Math.floor(Date.parse(updated) / 1000) || undefined,
        subreddit: sub,
      });
    }
  }
  return posts;
}

async function redditCandidates(): Promise<{
  candidates: string[];
  note: ScanNote;
}> {
  const { posts, ok } = await redditPosts();
  if (!ok && !posts.length) {
    return {
      candidates: [],
      note: { source: "reddit", status: "limited", detail: "Reddit is rate-limiting right now." },
    };
  }
  const cutoff = Date.now() - FRESH_DAYS * 86_400_000;
  const sorted = posts
    .filter((p) => (p.created_utc ?? 0) * 1000 >= cutoff)
    .sort((a, b) => (b.created_utc ?? 0) - (a.created_utc ?? 0));
  const candidates = new Set<string>();
  for (const post of sorted) {
    const text = `${post.title ?? ""}\n${post.selftext ?? ""}\n${post.url ?? ""}`;
    if (!RELEVANT_REDDIT.test(text)) continue;
    for (const full of githubReposFromText(text, 4)) candidates.add(full);
  }
  return {
    candidates: [...candidates],
    note: {
      source: "reddit",
      status: "ok",
      detail: `${sorted.length} recent posts across ${SUBREDDITS.length} subreddits · ${candidates.size} repo links.`,
    },
  };
}

type XPost = { text: string; at: number };

function parseNitterRss(xml: string): XPost[] {
  const posts: XPost[] = [];
  for (const match of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const entry = match[1];
    const title = entry.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? "";
    const description =
      entry.match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/)?.[1] ?? "";
    const pubDate = entry.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1] ?? "";
    const text = decodeEntities(`${title}\n${description.replace(/<[^>]+>/g, " ")}`);
    posts.push({ text, at: Date.parse(pubDate) || 0 });
  }
  return posts;
}

async function xCandidates(): Promise<{ candidates: string[]; note: ScanNote }> {
  const queries = ["mcp server github", "agent skill github", "claude skill github"];
  const posts: XPost[] = [];
  let reachable = false;
  for (const instance of X_INSTANCES) {
    for (const query of queries) {
      const res = await fetchText(
        `${instance}/search/rss?f=tweets&q=${encodeURIComponent(query)}`,
        9000,
        "application/rss+xml, application/xml;q=0.9, text/xml;q=0.8",
      );
      if (!res.ok || !res.text.includes("<item>")) continue;
      reachable = true;
      posts.push(...parseNitterRss(res.text));
    }
    if (reachable) break;
  }
  if (!reachable) {
    return {
      candidates: [],
      note: {
        source: "x",
        status: "limited",
        detail: "X search did not answer this pass. It will retry on the next refresh.",
      },
    };
  }
  const cutoff = Date.now() - FRESH_DAYS * 86_400_000;
  const recent = posts.filter((p) => !p.at || p.at >= cutoff);
  const candidates = new Set<string>();
  for (const post of recent) {
    for (const full of githubReposFromText(post.text, 3)) candidates.add(full);
  }
  return {
    candidates: [...candidates],
    note: {
      source: "x",
      status: "ok",
      detail: `${recent.length} recent posts on X · ${candidates.size} repo links.`,
    },
  };
}

async function resolveCommunity(
  reddit: string[],
  x: string[],
): Promise<{ items: Listing[]; limited: boolean }> {
  const merged = new Map<string, { full: string; via: Set<DiscoveredVia> }>();
  const add = (full: string, via: DiscoveredVia) => {
    const key = full.toLowerCase();
    const current = merged.get(key);
    if (current) current.via.add(via);
    else merged.set(key, { full, via: new Set([via]) });
  };
  for (const full of reddit) add(full, "reddit");
  for (const full of x) add(full, "x");

  const picks = [...merged.values()].slice(0, MAX_COMMUNITY_REPOS);
  const items: Listing[] = [];
  let limited = false;
  for (let i = 0; i < picks.length; i += 4) {
    const chunk = picks.slice(i, i + 4);
    const settled = await Promise.all(
      chunk.map(async (pick) => ({ pick, result: await lookupRepo(pick.full) })),
    );
    for (const { pick, result } of settled) {
      if (result.limited) limited = true;
      if (!result.listing) continue;
      items.push({ ...result.listing, via: [...pick.via] });
    }
  }
  return { items, limited };
}

async function build(): Promise<{ at: number; items: Listing[]; notes: ScanNote[] }> {
  const [github, reddit, x] = await Promise.all([scanGithubRecent(), redditCandidates(), xCandidates()]);
  const community = await resolveCommunity(reddit.candidates, x.candidates);
  const notes: ScanNote[] = [github.note, reddit.note, x.note];
  if (community.limited) {
    notes.push({
      source: "github",
      status: "limited",
      detail: "GitHub rate-limited a few community repo checks; they will retry next pass.",
    });
  }
  const map = new Map<string, Listing>();
  for (const item of [...github.items, ...community.items]) {
    const prev = map.get(item.id);
    if (!prev) {
      map.set(item.id, item);
      continue;
    }
    const via = mergeVia(prev.via, item.via);
    map.set(item.id, { ...prev, ...item, ...(via ? { via } : {}) });
  }
  const items = [...map.values()].sort(
    (a, b) => (b.updated ?? "").localeCompare(a.updated ?? "") || a.name.localeCompare(b.name),
  );
  return { at: Date.now(), items, notes };
}

export const liveCatalog = createServerFn({ method: "GET" }).handler(
  async (): Promise<LiveSnapshot> => {
    const now = Date.now();
    if (snapshot && now - snapshot.at < REFRESH_MS) {
      return {
        items: snapshot.items,
        notes: snapshot.notes,
        at: new Date(snapshot.at).toISOString(),
      };
    }
    if (!inflight) {
      inflight = build()
        .then((next) => {
          snapshot = next;
          return next;
        })
        .finally(() => {
          inflight = null;
        });
    }
    try {
      const next = await inflight;
      return {
        items: next.items,
        notes: next.notes,
        at: new Date(next.at).toISOString(),
      };
    } catch {
      if (snapshot) {
        return {
          items: snapshot.items,
          notes: [
            ...snapshot.notes,
            {
              source: "github",
              status: "error",
              detail: "The live refresh failed; showing the last good snapshot.",
            },
          ],
          at: new Date(snapshot.at).toISOString(),
        };
      }
      return {
        items: [],
        notes: [
          {
            source: "github",
            status: "error",
            detail: "The live sources did not respond. The saved index is still here.",
          },
        ],
        at: new Date().toISOString(),
      };
    }
  },
);
