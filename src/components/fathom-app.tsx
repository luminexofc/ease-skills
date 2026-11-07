import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useServerFn } from "@tanstack/react-start";
import {
  Bookmark,
  Check,
  Copy,
  ExternalLink,
  Loader2,
  RefreshCw,
  Search,
  Sparkles,
  X,
} from "lucide-react";
import { catalog } from "@/data/catalog";
import { CATEGORIES, SOURCES, mergeVia } from "@/lib/classify";
import { liveCatalog } from "@/lib/live.functions";
import { scanHosts } from "@/lib/scan.functions";
import type { CategoryId, DiscoveredVia, Kind, Listing, ScanNote, SourceId } from "@/lib/types";

type Row = Listing & { indexed: boolean };
type SortKey = "stars" | "updated" | "name";

const SHELF_KEY = "fathom.shelf";
const LIVE_KEY = "fathom.live.v1";
const LIVE_REFRESH_MS = 8 * 60 * 1000;

function formatStars(n: number | null): string {
  if (n == null) return "—";
  if (n >= 10000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function formatUpdated(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en", { month: "short", year: "numeric" });
}

export function FathomApp() {
  const scan = useServerFn(scanHosts);
  const liveScan = useServerFn(liveCatalog);
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
  const [refreshing, setRefreshing] = useState(false);
  const [communityOnly, setCommunityOnly] = useState(false);
  const [clock, setClock] = useState(0);
  const [active, setActive] = useState<Row | null>(null);
  const [copied, setCopied] = useState(false);
  const refreshRef = useRef(false);
  const lastCallRef = useRef(0);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(SHELF_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as unknown;
        if (Array.isArray(parsed)) setShelf(parsed.filter((x) => typeof x === "string"));
      }
    } catch {
      /* ignore broken local shelf */
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
      /* ignore broken snapshot */
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
        try {
          localStorage.setItem(LIVE_KEY, JSON.stringify({ at: snapshot.at, items: snapshot.items }));
        } catch {
          /* storage can be full */
        }
      } catch {
        /* keep the last good snapshot */
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
      if (e.key === "Escape") setActive(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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
    return [...map.values()];
  }, [feed, live]);

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
      const hay = `${item.name} ${item.description} ${item.license} ${item.topics.join(" ")} ${item.category}`.toLowerCase();
      return hay.includes(q);
    });
    rows.sort((a, b) => {
      if (sort === "name") return a.name.localeCompare(b.name);
      if (sort === "updated") return (b.updated ?? "").localeCompare(a.updated ?? "");
      return (b.stars ?? -1) - (a.stars ?? -1) || a.name.localeCompare(b.name);
    });
    return rows;
  }, [merged, query, kind, category, sources, savedOnly, communityOnly, shelf, sort]);

  const counts = useMemo(() => {
    const skills = merged.filter((i) => i.kind === "skill").length;
    const mcps = merged.filter((i) => i.kind === "mcp").length;
    const fresh = merged.filter((i) => !i.indexed);
    return {
      skills,
      mcps,
      total: merged.length,
      fresh: fresh.length,
      community: fresh.filter((i) => i.via?.length).length,
    };
  }, [merged]);

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
      const result = await scan({
        data: { query, kind, sources, category },
      });
      setLive(result.items);
      setNotes(result.notes);
    } catch {
      setNotes([
        {
          source: "github",
          status: "error",
          detail: "The scan didn't finish. The saved index is still available.",
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
    <div className="min-h-screen overflow-x-clip pb-24">
      <header className="sticky top-0 z-20 border-b border-line bg-paper/95 backdrop-blur-sm">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3">
          <a href="/" className="flex items-baseline gap-3">
            <span className="font-display text-2xl tracking-tight text-ink">Ease Skills</span>
            <span className="hidden text-sm text-muted sm:inline">Free skills & MCP servers</span>
          </a>
          <div className="flex rounded-md border border-line bg-card p-1" role="tablist" aria-label="Kind">
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
                className={`min-h-11 rounded-sm px-3 text-sm font-medium ${
                  kind === id ? "bg-ink text-card" : "text-muted hover:text-ink"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4">
        <section className="grid gap-8 border-b border-line py-8 md:grid-cols-[minmax(0,1.4fr)_minmax(16rem,0.8fr)] md:py-12">
          <div>
            <p className="text-xs font-medium tracking-widest text-teal uppercase">
              GitHub · GitLab · Bitbucket · Reddit · X
            </p>
            <h1 className="font-display mt-3 text-4xl leading-[1.05] text-balance text-ink sm:text-5xl">
              Only the free ones.
            </h1>
            <p className="mt-4 max-w-xl text-lg leading-relaxed text-pretty text-muted">
              Agent skills and MCP servers anyone can open, clone, and run. Ease Skills keeps a
              checked index, scans the three public hosts, and pulls fresh finds from Reddit and X
              every few minutes. Private repos and anything without a free license never stay.
            </p>
            <form onSubmit={onScan} className="mt-6 flex flex-col gap-2 sm:flex-row">
              <label className="relative min-w-0 flex-1">
                <span className="sr-only">Search the index</span>
                <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" />
                <input
                  id="fathom-search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search design, video, postgres, playwright…"
                  className="h-12 w-full rounded-md border border-ink bg-card pr-3 pl-10 text-base text-ink outline-none placeholder:text-muted focus:ring-2 focus:ring-teal"
                />
              </label>
              <button
                type="submit"
                disabled={scanning}
                className="inline-flex h-12 min-w-36 items-center justify-center gap-2 rounded-md bg-teal px-4 text-sm font-semibold text-card disabled:opacity-70"
              >
                {scanning ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />}
                {scanning ? "Scanning" : "Scan hosts"}
              </button>
            </form>
            <p className="mt-3 max-w-xl text-sm text-muted">
              Press / to search. Bitbucket has no anonymous global search, so a scan checks public
              workspaces and still drops anything without a free license. If a server calls someone
              else's API, that API can have its own limits — the code itself stays free to clone.
            </p>
            <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-muted">
              <span className="inline-flex items-center gap-2">
                <span
                  className={`size-2 rounded-full ${refreshing ? "animate-pulse bg-clay" : "bg-teal"}`}
                />
                {feedAt
                  ? `Live index · updated ${timeAgo(feedAt, clock)}`
                  : "Live index · checking Reddit, X, and GitHub…"}
              </span>
              {counts.community > 0 && (
                <span className="rounded-sm bg-teal-soft px-2 py-1 text-xs font-semibold tracking-wide text-teal uppercase">
                  +{counts.community} from Reddit &amp; X
                </span>
              )}
              <button
                type="button"
                onClick={() => void refreshFeed(true)}
                disabled={refreshing}
                className="inline-flex min-h-9 items-center gap-1.5 rounded-md border border-line bg-card px-2.5 text-xs font-medium text-ink disabled:opacity-60"
              >
                <RefreshCw className={`size-3.5 ${refreshing ? "animate-spin" : ""}`} />
                Refresh
              </button>
            </div>
            {feedNotes.some((n) => n.status !== "ok") && (
              <p className="mt-2 max-w-xl text-xs text-muted">
                {feedNotes
                  .filter((n) => n.status !== "ok")
                  .map((n) => n.detail)
                  .join(" ")}
              </p>
            )}
          </div>
          <dl className="grid grid-cols-2 gap-px self-end overflow-hidden rounded-md border border-line bg-line">
            <Stat label="Skills" value={counts.skills} />
            <Stat label="MCP servers" value={counts.mcps} />
            <Stat label="Listed" value={counts.total} />
            <Stat label="New finds" value={counts.fresh} />
          </dl>
        </section>

        <section className="sticky top-16 z-10 min-w-0 border-b border-line bg-paper/95 py-3 backdrop-blur-sm">
          <div className="flex w-full min-w-0 gap-2 overflow-x-auto pb-1">
            {CATEGORIES.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => setCategory(c.id)}
                className={`min-h-11 shrink-0 rounded-md border px-3 text-sm ${
                  category === c.id
                    ? "border-teal bg-teal-soft text-teal"
                    : "border-line bg-card text-ink"
                }`}
              >
                {c.label}
              </button>
            ))}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {SOURCES.map((s) => {
              const on = sources.includes(s.id);
              return (
                <button
                  key={s.id}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggleSource(s.id)}
                  className={`min-h-11 rounded-md border px-3 text-sm ${
                    on ? "border-ink bg-ink text-card" : "border-line bg-card text-muted"
                  }`}
                >
                  {s.label}
                </button>
              );
            })}
            <button
              type="button"
              aria-pressed={savedOnly}
              onClick={() => setSavedOnly((v) => !v)}
              className={`inline-flex min-h-11 items-center gap-2 rounded-md border px-3 text-sm ${
                savedOnly ? "border-clay bg-clay-soft text-clay" : "border-line bg-card text-ink"
              }`}
            >
              <Bookmark className="size-4" />
              Saved
            </button>
            <button
              type="button"
              aria-pressed={communityOnly}
              onClick={() => setCommunityOnly((v) => !v)}
              className={`inline-flex min-h-11 items-center gap-2 rounded-md border px-3 text-sm ${
                communityOnly
                  ? "border-teal bg-teal-soft text-teal"
                  : "border-line bg-card text-ink"
              }`}
            >
              <Sparkles className="size-4" />
              Reddit + X
            </button>
            <label className="ml-auto flex min-h-11 items-center gap-2 text-sm text-muted">
              Sort
              <select
                value={sort}
                onChange={(e) => setSort(e.target.value as SortKey)}
                className="h-11 rounded-md border border-line bg-card px-2 text-ink"
              >
                <option value="stars">Stars</option>
                <option value="updated">Updated</option>
                <option value="name">Name</option>
              </select>
            </label>
          </div>
        </section>

        {notes.length > 0 && (
          <ul className="mt-4 space-y-1 text-sm text-muted">
            {notes.map((n) => (
              <li key={n.source}>
                <span className="font-medium text-ink capitalize">{n.source}.</span> {n.detail}
              </li>
            ))}
          </ul>
        )}

        <p className="mt-5 text-sm text-muted tabular-nums">
          {visible.length} free {visible.length === 1 ? "listing" : "listings"}
          {live.length > 0 ? ` · ${live.length} from the last scan` : ""}
          {counts.fresh > 0 ? ` · ${counts.fresh} fresh from the live index` : ""}
        </p>

        {visible.length === 0 ? (
          <div className="mt-6 rounded-md border border-dashed border-line bg-card px-5 py-10">
            <p className="font-display text-2xl text-ink">Nothing free matches.</p>
            <p className="mt-2 max-w-md text-muted">
              Clear a filter, or scan the hosts. Results without a free, public license are left out
              on purpose.
            </p>
          </div>
        ) : (
          <ul className="mt-3 divide-y divide-line border-y border-line">
            {visible.map((item) => (
              <li key={item.id}>
                <article className="grid gap-3 py-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-start">
                  <button type="button" onClick={() => setActive(item)} className="min-w-0 text-left">
                    <p className="text-xs font-medium tracking-wide text-teal uppercase">
                      {item.kind === "skill" ? "Skill" : "MCP server"}
                      <span className="text-muted"> · {labelFor(item.category)}</span>
                      <span className="text-muted"> · {sourceLabel(item.source)}</span>
                      {item.via?.length ? (
                        <span className="text-teal"> · via {viaLabel(item.via)}</span>
                      ) : null}
                    </p>
                    <h2 className="mt-1 max-w-full font-display text-2xl leading-tight break-words text-balance text-ink">
                      {item.name}
                    </h2>
                    <p className="mt-1 max-w-3xl text-sm leading-relaxed text-pretty text-muted">
                      {item.description}
                    </p>
                  </button>
                  <div className="flex flex-wrap items-center gap-2 md:max-w-48 md:flex-col md:items-end">
                    <span className="rounded-sm bg-clay-soft px-2 py-1 text-xs font-semibold tracking-wide text-clay uppercase">
                      Free · {item.license}
                    </span>
                    <span className="text-sm text-muted tabular-nums">
                      {item.stars == null ? "no star count" : `${formatStars(item.stars)} stars`}
                    </span>
                    <span className="text-xs text-muted">{item.indexed ? "Indexed" : "Fresh"}</span>
                    <button
                      type="button"
                      aria-label={shelf.includes(item.id) ? "Remove from saved" : "Save"}
                      aria-pressed={shelf.includes(item.id)}
                      onClick={() => toggleShelf(item.id)}
                      className="inline-flex size-11 items-center justify-center rounded-md border border-line bg-card text-ink"
                    >
                      <Bookmark className={`size-4 ${shelf.includes(item.id) ? "fill-clay text-clay" : ""}`} />
                    </button>
                  </div>
                </article>
              </li>
            ))}
          </ul>
        )}
      </main>

      {active && (
        <div
          className="fixed inset-0 z-40 flex justify-end bg-ink/40"
          role="presentation"
          onClick={() => setActive(null)}
        >
          <article
            role="dialog"
            aria-modal="true"
            aria-labelledby="listing-title"
            className="h-full w-full max-w-lg overflow-y-auto bg-card p-5 shadow-xl sm:p-7"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3">
              <p className="text-xs font-medium tracking-wide text-teal uppercase">
                {active.kind === "skill" ? "Skill" : "MCP server"} · {labelFor(active.category)}
              </p>
              <button
                type="button"
                onClick={() => setActive(null)}
                aria-label="Close"
                className="inline-flex size-11 items-center justify-center rounded-md border border-line"
              >
                <X className="size-4" />
              </button>
            </div>
            <h2 id="listing-title" className="font-display mt-3 text-3xl leading-tight text-balance text-ink">
              {active.name}
            </h2>
            <p className="mt-3 text-base leading-relaxed text-pretty text-ink">{active.description}</p>
            {active.via?.length ? (
              <p className="mt-2 text-xs font-medium tracking-wide text-teal uppercase">
                Found on {viaLabel(active.via)}
              </p>
            ) : null}
            <dl className="mt-5 grid grid-cols-2 gap-px overflow-hidden rounded-md border border-line bg-line text-sm">
              <Meta k="License" v={active.license} />
              <Meta k="Host" v={sourceLabel(active.source)} />
              <Meta k="Stars" v={formatStars(active.stars)} />
              <Meta k="Updated" v={formatUpdated(active.updated)} />
            </dl>
            <p className="mt-4 text-sm leading-relaxed text-muted">{active.access}</p>
            <div className="mt-5">
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-sm font-semibold text-ink">Get it, free</h3>
                <button
                  type="button"
                  onClick={() => copyInstall(active.install)}
                  className="inline-flex min-h-11 items-center gap-2 rounded-md border border-line px-3 text-sm"
                >
                  {copied ? <Check className="size-4 text-teal" /> : <Copy className="size-4" />}
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
              <pre className="overflow-x-auto rounded-md bg-ink p-4 text-xs leading-relaxed text-card">
                {active.install}
              </pre>
            </div>
            <div className="mt-5 flex flex-col gap-2 sm:flex-row">
              <a
                href={active.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex h-12 flex-1 items-center justify-center gap-2 rounded-md bg-teal text-sm font-semibold text-card"
              >
                Open repository
                <ExternalLink className="size-4" />
              </a>
              <button
                type="button"
                onClick={() => toggleShelf(active.id)}
                className="inline-flex h-12 flex-1 items-center justify-center gap-2 rounded-md border border-ink text-sm font-semibold"
              >
                <Bookmark className={`size-4 ${shelf.includes(active.id) ? "fill-clay text-clay" : ""}`} />
                {shelf.includes(active.id) ? "Saved" : "Save"}
              </button>
            </div>
          </article>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="bg-card px-3 py-4">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="font-display mt-1 text-3xl text-ink tabular-nums">{value}</dd>
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
  if (set.has("reddit") && set.has("x")) return "Reddit + X";
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
