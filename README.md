# Ease Skills

A checked directory of free, public agent skills and MCP servers. Browse by category, copy an install snippet, and keep a shortlist on a local shelf. The catalog scans public hosts and picks up fresh finds from Reddit and X.

![Ease Skills](public/og.jpg)

## What it does

- **Free only.** Every listing is a public repo with a free license. Private repos and paywalled skills are left out.
- **Three kinds of discovery.** A verified seed catalog in `src/data/catalog.ts`, on-demand host scans across GitHub, GitLab, and Bitbucket, and a live layer that pulls new repos mentioned on Reddit and X.
- **Auto-refresh.** The live layer rebuilds every 8 minutes on the server, and the page checks back on the same cadence. No keys or accounts required.
- **Useful filters.** Search, category, skill vs. MCP server, and a "Reddit + X" view for community finds.
- **Ready-to-paste installs.** Each card includes the clone command and where to drop the folder for Claude Code, Cursor, or Codex.
- **A local shelf.** Saved items stay in the browser's `localStorage`; nothing is sent to a server.
- **Installable.** Ships with a web app manifest and offline assets for adding to a home screen.

## Stack

React 19, TanStack Router and Start, TypeScript, Tailwind CSS 4, Vite 8, and Nitro. Optional Postgres via `DATABASE_URL`; otherwise the app uses an embedded PGlite database.

## Run locally

Requires Node.js 22.12 or newer.

```bash
npm install
npm run dev
```

Open <http://localhost:8080>.

| Command | What it does |
| --- | --- |
| `npm run dev` | Start the dev server on port 8080 |
| `npm run build` | Production build, then run database migrations if configured |
| `npm run typecheck` | TypeScript check |
| `npm run preview` | Preview the production build |

`DATABASE_URL` is optional. Without it, migrations are skipped and PGlite manages its own local database.

## How discovery works

The live layer is served by a TanStack server function in `src/lib/live.functions.ts`:

1. **GitHub** — recent public repos matching `SKILL.md` in the readme or `mcp-server` in the name, pushed within the last 30 days.
2. **Reddit** — posts from `r/mcp`, `r/ClaudeAI`, `r/ClaudeCode`, `r/AI_Agents`, `r/agentic`, and `r/LocalLLaMA` via the Arctic Shift API, with RSS as a fallback.
3. **X** — recent posts from a small set of Nitter RSS instances.

Repo links are resolved against the GitHub API, then filtered by license and kind. Results live in a module-level cache for 8 minutes; individual repo lookups are cached for 6 hours. Anonymous GitHub search can be rate-limited, in which case the last good snapshot and saved index remain available.

The seed catalog is checked in at `src/data/catalog.ts`. The Python scripts under `scripts/` are the one-shot snapshot tools used to build and clean it.

## Project layout

```
src/
  components/       Directory UI and live feed
  data/             Checked-in seed catalog
  lib/              Discovery, scanning, classification, auth, database
  routes/           TanStack Router routes
scripts/            Build, PWA, migration, and catalog tooling
server/             Nitro server middleware
public/             Icons, share card, and install assets
```

## Deployment

`npm run build` produces a Nitro output in `.vercel/output`, ready for Vercel. A database is only needed if you enable accounts; the directory itself runs without one.

To deploy from the CLI:

```bash
npm run build
npx vercel deploy --prebuilt
```

## Notes

- The index only links to third-party repositories. Each project keeps its own license and terms.
- Reddit and X sources are read through public endpoints; if one changes or rate-limits, the rest of the catalog still works.
