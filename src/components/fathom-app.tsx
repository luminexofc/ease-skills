import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useServerFn } from "@tanstack/react-start";
import {
  Bookmark,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  ExternalLink,
  Loader2,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import { catalog } from "@/data/catalog";
import { SubmitForm } from "@/components/submit-form";
import { CATEGORIES, SOURCES, mergeVia } from "@/lib/classify";
import { crawledIndex } from "@/lib/index.functions";
import { liveCatalog } from "@/lib/live.functions";
import { scanHosts } from "@/lib/scan.functions";
import { approvedSubmissions } from "@/lib/submissions.functions";
import type { CategoryId, DiscoveredVia, Kind, Listing, ScanNote, SourceId } from "@/lib/types";

type Row = Listing & { indexed: boolean };
type SortKey = "stars" | "updated" | "name";

const SHELF_KEY = "fathom.shelf";
const LIVE_KEY = "fathom.live.v1";
const LIVE_REFRESH_MS = 8 * 60 * 1000;
const PAGE = 24;
const DEEP_CHUNK = 120;

/**
 * Page numbers to show around the current one, with "gap" standing in for the
 * skipped run, so a 241-page index still fits on a phone.
 */
function pageWindow(current: number, total: number): (number | "gap")[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i);
  const pages = new Set<number>([0, total - 1, current - 1, current, current + 1]);
  if (current <= 3) [0, 1, 2, 3, 4].forEach((p) => pages.add(p));
  if (current >= total - 4) {
    [total - 5, total - 4, total - 3, total - 2, total - 1].forEach((p) => pages.add(p));
  }
  const sorted = [...pages].filter((p) => p >= 0 && p < total).sort((a, b) => a - b);
  const out: (number | "gap")[] = [];
  sorted.forEach((p, i) => {
    if (i > 0 && p - sorted[i - 1] > 1) out.push("gap");
    out.push(p);
  });
  return out;
}

function formatStars(n: number | null): string | null {
  if (n == null) return null;
  if (n >= 10000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function formatUpdated(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en", { month: "short", year: "numeric" });
}

export function FathomApp() {
  const scan = useServerFn(scanHosts);
  const liveScan = useServerFn(liveCatalog);
  const fetchIndex = useServerFn(crawledIndex);
  const fetchApproved = useServerFn(approvedSubmissions);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<Kind | "all">("all");
  const [category, setCategory] = useState<CategoryId | "all">("all");
  const [sources, setSources] = useState<SourceId[]>(["github", "gitlab", "bitbucket"]);
  const [savedOnly, setSavedOnly] = useState(false);
  const [sort, setSort] = useState<SortKey>("stars");
  const [shelf, setShelf] = useState<string[]>([]);
  const [live, setLive] = useState<Listing[]>([]);
  const [notes, setNotes] = useState<ScanNote[]>([]);
  const [scanning, setScanning] = useState(false);
  const [feed, setFeed] = useState<Listing[]>([]);
  const [feedAt, setFeedAt] = useState<string | null>(null);
  const [feedNotes, setFeedNotes] = useState<ScanNote[]>([]);
  const [feedError, setFeedError] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [communityOnly, setCommunityOnly] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);

  // The crawled index and community submissions live server-side; the checked-in
  // catalog stays in the bundle so the first paint never waits on a request.
  const [deep, setDeep] = useState<Listing[]>([]);
  const [deepMatched, setDeepMatched] = useState(0);
  const [deepTotal, setDeepTotal] = useState(0);
  // Collection-wide totals from the index, so the hero's split adds up to the
  // headline instead of describing only the first loaded page.
  const [totals, setTotals] = useState<{ all: number; skill: number; mcp: number } | null>(null);
  const [deepLoading, setDeepLoading] = useState(false);
  const [deepAt, setDeepAt] = useState<string | null>(null);
  const [community, setCommunity] = useState<Listing[]>([]);
  const [pageIndex, setPageIndex] = useState(0);
  const [pendingPage, setPendingPage] = useState<number | null>(null);
  // "Jump to the end" stays on the end while more rows stream in, because the
  // true total is only known once the last chunk has loaded.
  const [pinLast, setPinLast] = useState(false);
  const loadingRef = useRef(false);
  const [searchInput, setSearchInput] = useState("");
  const [clock, setClock] = useState(0);
  const [active, setActive] = useState<Row | null>(null);
  const [copied, setCopied] = useState(false);
  const refreshRef = useRef(false);
  const lastCallRef = useRef(0);
  const panelRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const returnFocusRef = useRef<Element | null>(null);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(SHELF_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as unknown;
        if (Array.isArray(parsed)) setShelf(parsed.filter((x) => typeof x === "string"));
      }
    } catch {
      /* a broken shelf is not worth blocking the page for */
    }
  }, []);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(LIVE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as { at?: unknown; items?: unknown };
      if (typeof parsed.at === "string" && Array.isArray(parsed.items)) {
        setFeed(parsed.items as Listing[]);
        setFeedAt(parsed.at);
      }
    } catch {
      /* ignore a truncated snapshot */
    }
  }, []);

  const refreshFeed = useCallback(
    async (force = false) => {
      if (refreshRef.current) return;
      if (!force && Date.now() - lastCallRef.current < 2 * 60 * 1000) return;
      lastCallRef.current = Date.now();
      refreshRef.current = true;
      setRefreshing(true);
      try {
        const snapshot = await liveScan();
        setFeed(snapshot.items);
        setFeedNotes(snapshot.notes);
        setFeedAt(snapshot.at);
        setFeedError(false);
        try {
          localStorage.setItem(LIVE_KEY, JSON.stringify({ at: snapshot.at, items: snapshot.items }));
        } catch {
          /* quota is not fatal, the index still renders from memory */
        }
      } catch {
        // A failed check keeps the last good index, and says so, instead of
        // silently showing a stale timestamp as if it were fresh.
        setFeedError(true);
      } finally {
        refreshRef.current = false;
        setRefreshing(false);
      }
    },
    [liveScan],
  );

  useEffect(() => {
    void refreshFeed(true);
    const timer = window.setInterval(() => void refreshFeed(), LIVE_REFRESH_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void refreshFeed();
    };
    const tick = window.setInterval(() => setClock(Date.now()), 60_000);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      window.clearInterval(tick);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refreshFeed]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "/" && document.activeElement?.tagName !== "INPUT") {
        e.preventDefault();
        document.getElementById("fathom-search")?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Dialog behaviour: lock the page, move focus in, keep Tab inside, and hand
  // focus back to the row that opened it.
  useEffect(() => {
    if (!active) return;
    returnFocusRef.current = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setActive(null);
        return;
      }
      if (e.key !== "Tab") return;
      const focusables = panelRef.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (!focusables?.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
      const back = returnFocusRef.current;
      if (back instanceof HTMLElement) back.focus();
    };
  }, [active]);

  // Pull the crawled index for the active filters. Debounced on the query so
  // typing does not fire a request per keystroke, and cancelled on change so a
  // slow response cannot overwrite a newer one.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      let cancelled = false;
      setDeepLoading(true);
      fetchIndex({
        data: {
          query,
          kind,
          category,
          sources,
          offset: 0,
          limit: DEEP_CHUNK,
        },
      })
        .then((snapshot) => {
          if (cancelled) return;
          setDeep(snapshot.items);
          setDeepMatched(snapshot.matched);
          setDeepTotal(snapshot.count);
          setTotals(snapshot.totals);
          setDeepAt(snapshot.generatedAt);
        })
        .catch(() => {
          if (!cancelled) setDeep([]);
        })
        .finally(() => {
          if (!cancelled) setDeepLoading(false);
        });
      return () => {
        cancelled = true;
      };
    }, 220);
    return () => window.clearTimeout(timer);
  }, [fetchIndex, query, kind, category, sources]);

  /**
   * Pull one chunk of the server-side index from `offset` and append it, so a
   * page far down the strip can be fetched on demand instead of all at once.
   * Returns how many rows arrived and what the server says matches in total.
   */
  const loadDeepChunk = useCallback(
    async (offset: number) => {
      const snapshot = await fetchIndex({
        data: { query, kind, category, sources, offset, limit: DEEP_CHUNK },
      });
      setDeep((prev) => {
        const seen = new Set(prev.map((i) => i.id));
        return [...prev, ...snapshot.items.filter((i) => !seen.has(i.id))];
      });
      setDeepMatched(snapshot.matched);
      setDeepTotal(snapshot.count);
      setTotals(snapshot.totals);
      return { added: snapshot.items.length, matched: snapshot.matched };
    },
    [fetchIndex, query, kind, category, sources],
  );

  /** Fetch enough rows that page `n` can be sliced out of `visible`. */
  const ensureRows = useCallback(
    async (need: number) => {
      if (loadingRef.current) return;
      let loaded = deep.length;
      let matched = deepMatched;
      if (loaded >= need || loaded >= matched) return;
      loadingRef.current = true;
      setDeepLoading(true);
      try {
        while (loaded < need && loaded < matched) {
          const { added, matched: fresh } = await loadDeepChunk(loaded);
          matched = fresh;
          if (added <= 0) break;
          loaded += added;
        }
      } catch {
        /* keep the rows already loaded */
      } finally {
        loadingRef.current = false;
        setDeepLoading(false);
      }
    },
    [loadDeepChunk, deep.length, deepMatched],
  );

  // Community submissions are few and change slowly, so load them once.
  useEffect(() => {
    let cancelled = false;
    fetchApproved()
      .then((rows) => {
        if (!cancelled) setCommunity(rows);
      })
      .catch(() => {
        /* an empty community list is fine */
      });
    return () => {
      cancelled = true;
    };
  }, [fetchApproved]);

  const merged = useMemo(() => {
    const map = new Map<string, Row>();
    for (const item of catalog) map.set(item.id, { ...item, indexed: true });
    for (const item of feed) {
      const prev = map.get(item.id);
      const via = mergeVia(prev?.via, item.via);
      if (prev) {
        map.set(item.id, { ...prev, ...item, indexed: prev.indexed, ...(via ? { via } : {}) });
      } else {
        map.set(item.id, { ...item, indexed: false });
      }
    }
    for (const item of live) {
      if (!map.has(item.id)) map.set(item.id, { ...item, indexed: false });
    }
    // Community submissions are verified, so they count as indexed.
    for (const item of community) {
      if (!map.has(item.id)) map.set(item.id, { ...item, indexed: true });
    }
    // The crawled index is the bulk of the collection and is already filtered
    // server-side, so it only fills gaps rather than being re-filtered here.
    for (const item of deep) {
      if (!map.has(item.id)) map.set(item.id, { ...item, indexed: true });
    }
    return [...map.values()];
  }, [feed, live, community, deep]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const shelfSet = new Set(shelf);
    const rows = merged.filter((item) => {
      if (kind !== "all" && item.kind !== kind) return false;
      if (category !== "all" && item.category !== category) return false;
      if (!sources.includes(item.source)) return false;
      if (savedOnly && !shelfSet.has(item.id)) return false;
      if (communityOnly && !item.via?.length) return false;
      if (!q) return true;
      const hay =
        `${item.name} ${item.description} ${item.license} ${item.topics.join(" ")} ${item.category}`.toLowerCase();
      return hay.includes(q);
    });
    rows.sort((a, b) => {
      if (sort === "name") return a.name.localeCompare(b.name);
      if (sort === "updated") return (b.updated ?? "").localeCompare(a.updated ?? "");
      return (b.stars ?? -1) - (a.stars ?? -1) || a.name.localeCompare(b.name);
    });
    return rows;
  }, [merged, query, kind, category, sources, savedOnly, communityOnly, shelf, sort]);

  // A new filter is a new result set, so paging starts over.
  const filterKey = `${query}|${kind}|${category}|${sources.join(",")}|${savedOnly}|${communityOnly}|${sort}`;
  useEffect(() => {
    setPageIndex(0);
    setPendingPage(null);
    setPinLast(false);
  }, [filterKey]);

  const counts = useMemo(() => {
    const fresh = merged.filter((i) => !i.indexed);
    const skills = totals?.skill ?? merged.filter((i) => i.kind === "skill").length;
    const mcps = totals?.mcp ?? merged.filter((i) => i.kind === "mcp").length;
    return {
      skills,
      mcps,
      // One source for all three numbers, so Skills + MCP servers = In the index.
      total: totals?.all ?? Math.max(merged.length, deepTotal),
      fresh: fresh.length,
      community: fresh.filter((i) => i.via?.length).length,
      submitted: community.length,
    };
  }, [merged, deepTotal, community, totals]);

  const resultCount = Math.max(visible.length, deepMatched);
  const totalPages = Math.max(1, Math.ceil(resultCount / PAGE));
  const currentPage = pinLast ? totalPages - 1 : Math.min(pageIndex, totalPages - 1);
  const pageStart = currentPage * PAGE;
  const shown = visible.slice(pageStart, pageStart + PAGE);

  const goToPage = (target: number) => {
    const next = Math.max(0, Math.min(target, totalPages - 1));
    if (next === currentPage && pendingPage === null) return;
    setPinLast(next >= totalPages - 1);
    setPageIndex(next);
    setPendingPage(next);
    void ensureRows((next + 1) * PAGE).finally(() => {
      setPendingPage(null);
      document.getElementById("index")?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  };

  // Pinned to the end: if loading revealed extra rows past our chunk, fetch them
  // too so the last page is really the last page.
  useEffect(() => {
    if (!pinLast) return;
    void ensureRows(totalPages * PAGE);
  }, [pinLast, totalPages, ensureRows]);
  const activeFilters =
    (kind !== "all" ? 1 : 0) +
    (category !== "all" ? 1 : 0) +
    (savedOnly ? 1 : 0) +
    (communityOnly ? 1 : 0) +
    (sources.length < SOURCES.length ? 1 : 0);

  function toggleSource(id: SourceId) {
    setSources((prev) => {
      if (prev.includes(id)) {
        const next = prev.filter((s) => s !== id);
        return next.length ? next : prev;
      }
      return [...prev, id];
    });
  }

  function toggleShelf(id: string) {
    setShelf((prev) => {
      const next = prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id];
      localStorage.setItem(SHELF_KEY, JSON.stringify(next));
      return next;
    });
  }

  async function onScan(e?: FormEvent) {
    e?.preventDefault();
    setScanning(true);
    setNotes([]);
    try {
      const result = await scan({ data: { query, kind, sources, category } });
      setLive(result.items);
      setNotes(result.notes);
    } catch {
      setNotes([
        {
          source: "github",
          status: "error",
          detail: "The scan did not finish. The saved index below is still complete.",
        },
      ]);
    } finally {
      setScanning(false);
    }
  }

  async function copyInstall(text: string) {
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.left = "-9999px";
      document.body.appendChild(area);
      area.select();
      ok = document.execCommand("copy");
      area.remove();
    }
    setCopied(ok);
    if (ok) window.setTimeout(() => setCopied(false), 1600);
  }

  return (
    <div className="min-h-screen overflow-x-clip">
      <a
        href="#index"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded-sm focus:bg-ink focus:px-3 focus:py-2 focus:text-sm focus:text-card"
      >
        Skip to the index
      </a>

      <header className="rule border-line sticky top-0 z-20 border-b bg-paper">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-2.5 sm:px-6">
          <a href="/" className="flex min-h-11 items-baseline gap-3">
            <span className="font-display text-2xl tracking-tight text-ink">Ease Skills</span>
            <span className="hidden text-sm text-muted sm:inline">Free skills and MCP servers</span>
          </a>
          <div
            className="flex shrink-0 rounded-sm border border-line bg-card p-0.5"
            role="tablist"
            aria-label="Listing kind"
          >
            {(
              [
                ["all", "All"],
                ["skill", "Skills"],
                ["mcp", "MCP"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={kind === id}
                onClick={() => setKind(id)}
                className={`min-h-11 min-w-11 rounded-[3px] px-3 text-sm font-medium transition-colors ${
                  kind === id ? "bg-ink text-card" : "text-muted hover:bg-paper hover:text-ink"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 sm:px-6">
        <section className="rule grid gap-8 border-line py-10 md:grid-cols-[minmax(0,1.5fr)_minmax(15rem,0.85fr)] md:items-end md:gap-12 md:py-14">
          <div>
            <p className="label-caps text-teal">
              GitHub, GitLab, Bitbucket, Reddit, X, Threads
            </p>
            <h1 className="font-display mt-3 text-[2.6rem] leading-[1.02] tracking-[-0.015em] text-balance text-ink sm:text-[3.4rem]">
              Only the free ones.
            </h1>
            <p className="mt-4 max-w-xl text-lg leading-relaxed text-pretty text-muted">
              Agent skills and MCP servers anyone can open, clone, and run. A checked index, three
              public hosts, and fresh finds from the feeds every few minutes.
            </p>

            <form onSubmit={onScan} className="mt-7 flex flex-col gap-2 sm:flex-row">
              <label className="relative min-w-0 flex-1">
                <span className="sr-only">Search the index</span>
                <Search
                  className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted"
                  aria-hidden="true"
                />
                <input
                  id="fathom-search"
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search design, video, postgres, playwright"
                  className="h-12 w-full rounded-sm border border-line-strong bg-card pr-3 pl-10 text-base text-ink transition-colors placeholder:text-muted hover:border-ink/40 focus-visible:border-teal focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal"
                />
              </label>
              <button
                type="submit"
                disabled={scanning}
                className="inline-flex h-12 shrink-0 items-center justify-center gap-2 rounded-sm bg-teal px-5 text-sm font-semibold text-card transition-colors hover:bg-[#0b5c54] disabled:opacity-70"
              >
                {scanning ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                ) : (
                  <Search className="size-4" aria-hidden="true" />
                )}
                {scanning ? "Scanning" : "Scan the hosts"}
              </button>
            </form>

            <p className="mt-3 max-w-xl text-sm leading-relaxed text-muted">
              Press <kbd className="rounded-[3px] border border-line-strong bg-card px-1.5 py-0.5 text-xs">/</kbd>{" "}
              to search. Bitbucket has no anonymous global search, so a scan reads public
              workspaces there and still drops anything without a free licence.
            </p>

            <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
              <span className="inline-flex items-center gap-2 text-muted">
                <span
                  aria-hidden="true"
                  className={`size-2 rounded-full ${feedError ? "bg-clay-ink" : "bg-teal"}`}
                />
                <span aria-live="polite">
                  {feedError
                    ? "Live check failed, showing the last good index"
                    : feedAt
                      ? `Live index, updated ${timeAgo(feedAt, clock)}`
                      : "Checking Reddit, X, and GitHub"}
                </span>
              </span>
              {counts.community > 0 && (
                <span className="label-caps text-teal">
                  {counts.community} from Reddit, X, Threads
                </span>
              )}
              <button
                type="button"
                onClick={() => void refreshFeed(true)}
                disabled={refreshing}
                className="inline-flex min-h-11 items-center gap-1.5 rounded-sm border border-line-strong px-3 text-xs font-semibold text-ink transition-colors hover:bg-card disabled:opacity-60"
              >
                <RefreshCw
                  className={`size-3.5 ${refreshing ? "animate-spin" : ""}`}
                  aria-hidden="true"
                />
                {refreshing ? "Checking" : "Check the feeds"}
              </button>
            </div>

            {feedNotes.some((n) => n.status !== "ok") && (
              <p className="mt-3 max-w-xl text-sm text-muted">
                {feedNotes
                  .filter((n) => n.status !== "ok")
                  .map((n) => n.detail)
                  .join(" ")}
              </p>
            )}
          </div>

          {/* One focal number, the rest defer: the index size is the headline fact,
              the split under it is reference detail. */}
          <dl className="self-end border-t border-line-strong pt-4">
            <div>
              <dt className="label-caps text-muted">In the index</dt>
              <dd className="font-display mt-1 text-6xl leading-none text-ink tabular-nums">
                {counts.total}
              </dd>
            </div>
            <div className="mt-4 grid grid-cols-3 gap-3 border-t border-line pt-3">
              <div>
                <dt className="text-xs text-muted">Skills</dt>
                <dd className="mt-0.5 text-xl text-ink tabular-nums">{counts.skills}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted">MCP servers</dt>
                <dd className="mt-0.5 text-xl text-ink tabular-nums">{counts.mcps}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted">Submitted</dt>
                <dd className="mt-0.5 text-xl text-ink tabular-nums">{counts.submitted}</dd>
              </div>
            </div>
          </dl>

          {/* Outside the <dl>: only dt/dd are valid children there. */}
          <div className="mt-5 md:self-end">
            <SubmitForm
              onAdded={() => {
                fetchApproved()
                  .then(setCommunity)
                  .catch(() => undefined);
              }}
            />
          </div>
        </section>

        <section
          aria-label="Filters"
          className="rule border-line bg-paper/95 py-2.5 md:sticky md:top-[4.5rem] md:z-10 md:backdrop-blur-sm"
        >
          <div className="flex items-center gap-2">
            <div className="flex min-w-0 flex-1 gap-1.5 overflow-x-auto pb-1 [scrollbar-width:thin]">
              {CATEGORIES.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  aria-pressed={category === c.id}
                  onClick={() => setCategory(c.id)}
                  className={`min-h-11 min-w-11 shrink-0 rounded-sm border px-3 text-sm transition-colors ${
                    category === c.id
                      ? "border-teal bg-teal-soft font-semibold text-teal"
                      : "border-line-strong bg-card text-ink hover:border-ink/40"
                  }`}
                >
                  {c.label}
                </button>
              ))}
            </div>
            <button
              type="button"
              aria-expanded={filtersOpen}
              aria-controls="fathom-filters"
              onClick={() => setFiltersOpen((v) => !v)}
              className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-sm border border-line-strong bg-card px-3 text-sm font-medium text-ink transition-colors hover:border-ink/40"
            >
              Filters
              {activeFilters > 0 && (
                <span className="rounded-[3px] bg-teal px-1.5 py-0.5 text-xs font-semibold text-card tabular-nums">
                  {activeFilters}
                </span>
              )}
              <ChevronDown
                className={`size-4 transition-transform ${filtersOpen ? "rotate-180" : ""}`}
                aria-hidden="true"
              />
            </button>
          </div>

          <div
            id="fathom-filters"
            hidden={!filtersOpen}
            className="flex flex-wrap items-center gap-2 border-t border-line pt-2.5 md:border-0 md:pt-0"
          >
            <span className="label-caps mr-1 text-muted">Hosts</span>
            {SOURCES.map((s) => {
              const on = sources.includes(s.id);
              return (
                <button
                  key={s.id}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggleSource(s.id)}
                  className={`min-h-11 rounded-sm border px-3 text-sm transition-colors ${
                    on
                      ? "border-ink bg-ink text-card"
                      : "border-line-strong bg-card text-muted hover:border-ink/40"
                  }`}
                >
                  {s.label}
                </button>
              );
            })}
            <span className="mx-1 hidden h-6 w-px bg-line sm:block" aria-hidden="true" />
            <button
              type="button"
              aria-pressed={savedOnly}
              onClick={() => setSavedOnly((v) => !v)}
              className={`inline-flex min-h-11 items-center gap-2 rounded-sm border px-3 text-sm transition-colors ${
                savedOnly
                  ? "border-clay-ink bg-clay-soft font-semibold text-clay-ink"
                  : "border-line-strong bg-card text-ink hover:border-ink/40"
              }`}
            >
              <Bookmark
                className={`size-4 ${savedOnly ? "fill-clay-ink" : ""}`}
                aria-hidden="true"
              />
              Saved{shelf.length > 0 ? ` (${shelf.length})` : ""}
            </button>
            <button
              type="button"
              aria-pressed={communityOnly}
              onClick={() => setCommunityOnly((v) => !v)}
              className={`inline-flex min-h-11 items-center gap-2 rounded-sm border px-3 text-sm transition-colors ${
                communityOnly
                  ? "border-teal bg-teal-soft font-semibold text-teal"
                  : "border-line-strong bg-card text-ink hover:border-ink/40"
              }`}
            >
              Reddit, X, Threads
            </button>
            <label className="ml-auto flex min-h-11 items-center gap-2 text-sm text-muted">
              Sort
              <select
                value={sort}
                onChange={(e) => setSort(e.target.value as SortKey)}
                className="h-11 rounded-sm border border-line-strong bg-card px-2 text-ink"
              >
                <option value="stars">Most stars</option>
                <option value="updated">Recently updated</option>
                <option value="name">Name</option>
              </select>
            </label>
          </div>
        </section>

        {notes.length > 0 && (
          <ul className="mt-4 space-y-1 border-l-2 border-clay-ink pl-3 text-sm text-muted">
            {notes.map((n) => (
              <li key={n.source}>
                <span className="font-semibold text-ink capitalize">{n.source}:</span> {n.detail}
              </li>
            ))}
          </ul>
        )}

        <div
          id="index"
          className="mt-5 flex flex-wrap items-baseline justify-between gap-2 border-b border-line-strong pb-2"
        >
          <p className="text-sm text-muted tabular-nums" aria-live="polite">
            <span className="font-semibold text-ink">
              {Math.max(visible.length, deepMatched).toLocaleString()}
            </span>{" "}
            free {visible.length === 1 && deepMatched <= 1 ? "listing" : "listings"}
            {live.length > 0 ? `, ${live.length} from your last scan` : ""}
          </p>
          {activeFilters > 0 && (
            <button
              type="button"
              onClick={() => {
                setCategory("all");
                setKind("all");
                setSavedOnly(false);
                setCommunityOnly(false);
                setSources(["github", "gitlab", "bitbucket"]);
                setQuery("");
              }}
              className="text-sm font-medium text-teal underline decoration-teal/40 underline-offset-2 hover:decoration-teal"
            >
              Clear all filters
            </button>
          )}
        </div>

        {visible.length === 0 ? (
          <div className="mt-6 rounded-sm border border-dashed border-line-strong bg-card px-5 py-10 text-center">
            <p className="font-display text-2xl text-ink">
              {query ? (
                <>Nothing matches “{query}”.</>
              ) : savedOnly ? (
                <>Your shelf is empty.</>
              ) : (
                <>No free listings match these filters.</>
              )}
            </p>
            <p className="mx-auto mt-2 max-w-md text-pretty text-muted">
              {query
                ? "Try a broader word, or scan the hosts to look past the saved index."
                : savedOnly
                  ? "Save a listing with the bookmark on any row, and it stays in this browser."
                  : "Widen a host or category, or scan the hosts. Anything without a free, public licence is left out on purpose."}
            </p>
            <button
              type="button"
              onClick={() =>
                query ? setQuery("") : (setCategory("all"), setSavedOnly(false), setCommunityOnly(false))
              }
              className="mt-5 inline-flex min-h-11 items-center rounded-sm bg-ink px-4 text-sm font-semibold text-card"
            >
              {query ? "Clear the search" : "Reset the filters"}
            </button>
          </div>
        ) : (
          <>
            <ul className="border-b border-line">
              {shown.length === 0 && deepLoading && (
                <li className="flex items-center gap-2 border-t border-line py-6 text-sm text-muted">
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                  Loading page {(pendingPage ?? currentPage) + 1}…
                </li>
              )}
              {shown.map((item) => {
                const stars = formatStars(item.stars);
                const updated = formatUpdated(item.updated);
                const saved = shelf.includes(item.id);
                return (
                  <li key={item.id} className="border-t border-line">
                    <article className="group grid gap-3 py-5 transition-colors md:grid-cols-[minmax(0,1fr)_auto] md:items-start md:gap-6">
                      <button
                        type="button"
                        onClick={() => setActive(item)}
                        className="min-w-0 rounded-sm text-left"
                      >
                        <p className="label-caps flex flex-wrap items-center gap-x-2 gap-y-1 text-muted">
                          <span className="text-teal">
                            {item.kind === "skill" ? "Skill" : "MCP server"}
                          </span>
                          <span aria-hidden="true">/</span>
                          <span>{labelFor(item.category)}</span>
                          <span aria-hidden="true">/</span>
                          <span>{sourceLabel(item.source)}</span>
                          {item.via?.length ? (
                            <>
                              <span aria-hidden="true">/</span>
                              <span className="text-teal">via {viaLabel(item.via)}</span>
                            </>
                          ) : null}
                        </p>
                        <h2 className="font-display mt-1.5 max-w-full text-2xl leading-snug break-words text-balance text-ink decoration-teal/50 underline-offset-4 group-hover:underline">
                          {item.name}
                        </h2>
                        <p className="mt-1.5 max-w-3xl text-sm leading-relaxed text-pretty text-muted">
                          {item.description}
                        </p>
                      </button>

                      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 md:max-w-52 md:flex-col md:items-end md:gap-1.5">
                        <span className="label-caps rounded-[3px] bg-clay-soft px-1.5 py-1 text-clay-ink">
                          {item.license}
                        </span>
                        <span className="text-xs text-muted tabular-nums">
                          {stars ? `${stars} stars` : "No star count"}
                          {updated ? ` · updated ${updated}` : ""}
                        </span>
                        <span className="text-xs text-muted">
                          {item.indexed ? "In the saved index" : "Found live"}
                        </span>
                        <button
                          type="button"
                          aria-label={saved ? `Remove ${item.name} from your shelf` : `Save ${item.name}`}
                          aria-pressed={saved}
                          onClick={() => toggleShelf(item.id)}
                          className={`inline-flex size-11 items-center justify-center rounded-sm border transition-colors ${
                            saved
                              ? "border-clay-ink bg-clay-soft text-clay-ink"
                              : "border-line-strong bg-card text-ink hover:border-ink/40"
                          }`}
                        >
                          <Bookmark
                            className={`size-4 ${saved ? "fill-clay-ink" : ""}`}
                            aria-hidden="true"
                          />
                        </button>
                      </div>
                    </article>
                  </li>
                );
              })}
            </ul>

            <nav
              aria-label="Index pages"
              className="mt-6 flex flex-col items-center gap-3"
            >
              <div className="flex flex-wrap items-center justify-center gap-1.5">
                <button
                  type="button"
                  aria-label="Previous page"
                  onClick={() => goToPage(currentPage - 1)}
                  disabled={currentPage === 0 || pendingPage !== null}
                  className="inline-flex size-11 items-center justify-center rounded-sm border border-line-strong bg-card text-ink transition-colors hover:border-ink/40 disabled:opacity-40"
                >
                  <ChevronLeft className="size-4" aria-hidden="true" />
                </button>
                {pageWindow(currentPage, totalPages).map((p, i) =>
                  p === "gap" ? (
                    <span key={`gap-${i}`} className="px-1 text-sm text-muted" aria-hidden="true">
                      …
                    </span>
                  ) : (
                    <button
                      key={p}
                      type="button"
                      aria-label={`Page ${p + 1}`}
                      aria-current={p === currentPage ? "page" : undefined}
                      onClick={() => goToPage(p)}
                      disabled={pendingPage !== null && p !== currentPage}
                      className={`size-11 items-center justify-center rounded-sm border text-sm font-semibold tabular-nums transition-colors ${
                        p === 0 || p === totalPages - 1 || Math.abs(p - currentPage) <= 1
                          ? "inline-flex"
                          : "hidden sm:inline-flex"
                      } ${
                        p === currentPage
                          ? "border-ink bg-ink text-card"
                          : "border-line-strong bg-card text-ink hover:border-ink/40 disabled:opacity-40"
                      }`}
                    >
                      {p === pendingPage ? (
                        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                      ) : (
                        p + 1
                      )}
                    </button>
                  ),
                )}
                <button
                  type="button"
                  aria-label="Next page"
                  onClick={() => goToPage(currentPage + 1)}
                  disabled={currentPage >= totalPages - 1 || pendingPage !== null}
                  className="inline-flex size-11 items-center justify-center rounded-sm border border-line-strong bg-card text-ink transition-colors hover:border-ink/40 disabled:opacity-40"
                >
                  <ChevronRight className="size-4" aria-hidden="true" />
                </button>
              </div>
              <p className="text-xs text-muted tabular-nums">
                {resultCount === 0
                  ? "No listings"
                  : `${(pageStart + 1).toLocaleString()}–${(
                      pageStart + shown.length
                    ).toLocaleString()} of ${resultCount.toLocaleString()}`}
              </p>
            </nav>
          </>
        )}
      </main>

      <footer className="mx-auto mt-16 max-w-6xl border-t border-line px-4 py-8 sm:px-6">
        <p className="max-w-2xl text-sm leading-relaxed text-muted">
          Every listing is a public repository with a free licence. Private repos and paywalled
          skills are never indexed. Saved listings live in this browser only.
        </p>
      </footer>

      {active && (
        <div
          className="fixed inset-0 z-40 flex justify-end bg-ink/40"
          onClick={() => setActive(null)}
        >
          <article
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="listing-title"
            className="h-full w-full max-w-lg overflow-y-auto bg-card p-5 shadow-xl sm:p-7"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3">
              <p className="label-caps text-teal">
                {active.kind === "skill" ? "Skill" : "MCP server"} / {labelFor(active.category)}
              </p>
              <button
                ref={closeRef}
                type="button"
                onClick={() => setActive(null)}
                aria-label="Close this listing"
                className="inline-flex size-11 items-center justify-center rounded-sm border border-line-strong text-ink transition-colors hover:bg-paper"
              >
                <X className="size-4" aria-hidden="true" />
              </button>
            </div>
            <h2
              id="listing-title"
              className="font-display mt-3 text-3xl leading-tight text-balance text-ink"
            >
              {active.name}
            </h2>
            <p className="mt-3 text-base leading-relaxed text-pretty text-ink">{active.description}</p>
            {active.via?.length ? (
              <p className="label-caps mt-2 text-teal">Found on {viaLabel(active.via)}</p>
            ) : null}

            <dl className="mt-5 grid grid-cols-2 gap-px overflow-hidden rounded-sm border border-line bg-line text-sm">
              <Meta k="Licence" v={active.license} />
              <Meta k="Host" v={sourceLabel(active.source)} />
              <Meta k="Stars" v={formatStars(active.stars) ?? "Not listed"} />
              <Meta k="Updated" v={formatUpdated(active.updated) ?? "Not listed"} />
            </dl>

            <p className="mt-4 text-sm leading-relaxed text-muted">{active.access}</p>

            <div className="mt-5">
              <div className="mb-2 flex items-center justify-between gap-3">
                <h3 className="text-sm font-semibold text-ink">Install it yourself</h3>
                <button
                  type="button"
                  onClick={() => copyInstall(active.install)}
                  className="inline-flex min-h-11 items-center gap-2 rounded-sm border border-line-strong px-3 text-sm transition-colors hover:bg-paper"
                >
                  {copied ? (
                    <Check className="size-4 text-teal" aria-hidden="true" />
                  ) : (
                    <Copy className="size-4" aria-hidden="true" />
                  )}
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
              <pre className="overflow-x-auto rounded-sm bg-ink p-4 text-xs leading-relaxed text-card">
                {active.install}
              </pre>
            </div>

            <div className="mt-5 flex flex-col gap-2 pb-2 sm:flex-row">
              <a
                href={active.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex min-h-12 flex-1 items-center justify-center gap-2 rounded-sm bg-teal px-4 text-sm font-semibold text-card transition-colors hover:bg-[#0b5c54]"
              >
                Open the repository
                <ExternalLink className="size-4" aria-hidden="true" />
              </a>
              <button
                type="button"
                onClick={() => toggleShelf(active.id)}
                aria-pressed={shelf.includes(active.id)}
                className={`inline-flex min-h-12 flex-1 items-center justify-center gap-2 rounded-sm border px-4 text-sm font-semibold transition-colors ${
                  shelf.includes(active.id)
                    ? "border-clay-ink bg-clay-soft text-clay-ink"
                    : "border-ink text-ink hover:bg-paper"
                }`}
              >
                <Bookmark
                  className={`size-4 ${shelf.includes(active.id) ? "fill-clay-ink" : ""}`}
                  aria-hidden="true"
                />
                {shelf.includes(active.id) ? "On your shelf" : "Save to your shelf"}
              </button>
            </div>
          </article>
        </div>
      )}
    </div>
  );
}

function Meta({ k, v }: { k: string; v: string }) {
  return (
    <div className="bg-card px-3 py-3">
      <dt className="text-xs text-muted">{k}</dt>
      <dd className="mt-1 font-medium text-ink tabular-nums">{v}</dd>
    </div>
  );
}

function labelFor(id: string): string {
  return CATEGORIES.find((c) => c.id === id)?.label ?? id;
}

function sourceLabel(id: SourceId): string {
  return SOURCES.find((s) => s.id === id)?.label ?? id;
}

function viaLabel(via: DiscoveredVia[]): string {
  const set = new Set(via);
  if (set.has("reddit") && set.has("x") && set.has("threads")) return "Reddit, X, Threads";
  if (set.has("reddit") && set.has("x")) return "Reddit, X";
  if (set.has("threads") && set.has("reddit")) return "Reddit, Threads";
  if (set.has("threads") && set.has("x")) return "X, Threads";
  if (set.has("threads")) return "Threads";
  if (set.has("x")) return "X";
  return "Reddit";
}

function timeAgo(iso: string, now: number): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "just now";
  const seconds = Math.max(0, Math.round(((now || Date.now()) - then) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
