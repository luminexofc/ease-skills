import { createServerFn } from "@tanstack/react-start";
import { catalog } from "@/data/catalog";
import type { Listing } from "@/lib/types";

/**
 * The checked-in crawler output (`scripts/crawl-index.mjs`).
 *
 * Kept out of the client bundle deliberately: it holds thousands of listings,
 * and the client only ever needs the page it is showing. Vite treeshakes on the
 * server build and the module is only imported from `createServerFn` handlers,
 * so the browser never receives this file.
 */
type IndexFile = {
  generatedAt: string;
  count: number;
  items: Listing[];
};

let cached: IndexFile | null = null;

/**
 * Whole-collection totals, not the page of results. The hero stat block shows
 * "In the index" with a Skills / MCP split, so all three numbers have to come
 * from the same set — otherwise the split looks arbitrary next to the total.
 * The curated catalog is unioned in by id, since the crawler usually includes
 * those repositories too.
 */
type Totals = { all: number; skill: number; mcp: number };
let cachedTotals: Totals | null = null;

function totalsFor(index: IndexFile): Totals {
  if (cachedTotals) return cachedTotals;
  const ids = new Set(index.items.map((i) => i.id));
  const rows = [...index.items, ...catalog.filter((c) => !ids.has(c.id))];
  cachedTotals = {
    all: rows.length,
    skill: rows.filter((r) => r.kind === "skill").length,
    mcp: rows.filter((r) => r.kind === "mcp").length,
  };
  return cachedTotals;
}

async function loadIndex(): Promise<IndexFile> {
  if (cached) return cached;
  try {
    // Read as raw text rather than a JSON module: tsconfig has no
    // `resolveJsonModule`, and this mirrors how db.ts inlines migrations. The
    // glob is resolved at build time, so the file never reaches the browser.
    const files = import.meta.glob("/src/data/index.json", {
      query: "?raw",
      import: "default",
      eager: true,
    }) as Record<string, string>;
    const raw = Object.values(files)[0];
    if (raw) {
      cached = JSON.parse(raw) as IndexFile;
      return cached;
    }
  } catch {
    /* fall through to the empty index */
  }
  // No crawl has run yet; an empty index is not an error.
  cached = { generatedAt: new Date().toISOString(), count: 0, items: [] };
  return cached;
}

export type IndexSnapshot = {
  generatedAt: string;
  count: number;
  totals: Totals;
  items: Listing[];
};

/**
 * Serve the crawled index, filtered server-side so the payload stays small.
 * Mirrors the client's filter set (query, kind, category, source) so the UI can
 * page through far more than a browser bundle could hold.
 */
export const crawledIndex = createServerFn({ method: "GET" })
  .validator((input: unknown) => {
    const raw = (input ?? {}) as {
      query?: unknown;
      kind?: unknown;
      category?: unknown;
      sources?: unknown;
      offset?: unknown;
      limit?: unknown;
    };
    const kind = raw.kind === "skill" || raw.kind === "mcp" ? raw.kind : "all";
    const category = typeof raw.category === "string" ? raw.category.slice(0, 40) : "all";
    const sources = Array.isArray(raw.sources)
      ? raw.sources.filter((s): s is string => typeof s === "string").slice(0, 5)
      : ["github", "gitlab", "bitbucket"];
    const query = typeof raw.query === "string" ? raw.query.slice(0, 80).toLowerCase().trim() : "";
    const offset = Number.isFinite(Number(raw.offset)) ? Math.max(0, Math.min(Number(raw.offset), 20000)) : 0;
    const limit = Number.isFinite(Number(raw.limit)) ? Math.max(1, Math.min(Number(raw.limit), 120)) : 40;
    return { query, kind, category, sources, offset, limit };
  })
  .handler(async ({ data }): Promise<IndexSnapshot & { matched: number; offset: number }> => {
    const index = await loadIndex();
    const rows = index.items.filter((item) => {
      if (data.kind !== "all" && item.kind !== data.kind) return false;
      if (data.category !== "all" && item.category !== data.category) return false;
      if (data.sources.length > 0 && !data.sources.includes(item.source)) return false;
      if (!data.query) return true;
      const hay = `${item.name} ${item.description} ${item.license} ${item.topics.join(" ")} ${item.category}`.toLowerCase();
      return hay.includes(data.query);
    });
    return {
      generatedAt: index.generatedAt,
      count: index.count,
      totals: totalsFor(index),
      matched: rows.length,
      offset: data.offset,
      items: rows.slice(data.offset, data.offset + data.limit),
    };
  });
