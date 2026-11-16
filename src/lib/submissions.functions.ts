import { createServerFn } from "@tanstack/react-start";
import { getSql } from "@/lib/db";
import { classifyCategory, detectKind, installLines, licenseFromText, listingId, normalizeLicense } from "@/lib/classify";
import { clip, fetchText, githubRepoToListing } from "@/lib/hosts";
import type { CategoryId, Kind, Listing, SubmissionResult } from "@/lib/types";
import { z } from "zod";

/**
 * Submission pipeline.
 *
 * A person pastes a repository URL. We verify it ourselves rather than trusting
 * the form: the repo must be public, must carry a free licence, and must look
 * like a skill or an MCP server. Only then does it become `approved` and join
 * the index. Anything unverifiable stays `pending` with a note explaining what
 * the check found, so the queue is honest about why.
 */

const SubmissionInput = z.object({
  url: z.string().trim().min(8).max(400),
  submitter: z.string().trim().max(80).optional().default(""),
  note: z.string().trim().max(500).optional().default(""),
});

/** Accept `owner/repo`, a github/gitlab/bitbucket URL, or a bare URL. */
export function normalizeRepoUrl(raw: string): { host: "github" | "gitlab" | "bitbucket"; owner: string; repo: string; url: string } | null {
  const trimmed = raw.trim().replace(/\.git$/, "").replace(/\/+$/, "");
  if (!trimmed) return null;

  // Bare `owner/repo` defaults to GitHub, the most common case.
  if (!/^https?:\/\//i.test(trimmed)) {
    const bare = trimmed.replace(/^github\.com\//i, "");
    const m = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(bare);
    if (!m) return null;
    return { host: "github", owner: m[1], repo: m[2], url: `https://github.com/${m[1]}/${m[2]}` };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  const hostname = parsed.hostname.toLowerCase().replace(/^www\./, "");
  // Only the three hosts the rest of the app knows how to verify.
  const host =
    hostname === "github.com" ? "github" : hostname === "gitlab.com" ? "gitlab" : hostname === "bitbucket.org" ? "bitbucket" : null;
  if (!host) return null;
  const parts = parsed.pathname.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const [owner, repoRaw] = parts;
  const repo = repoRaw.replace(/\.git$/, "");
  if (!owner || !repo) return null;
  const url =
    host === "github"
      ? `https://github.com/${owner}/${repo}`
      : host === "gitlab"
        ? `https://gitlab.com/${owner}/${repo}`
        : `https://bitbucket.org/${owner}/${repo}`;
  return { host, owner, repo, url };
}

/**
 * Any other public link a person might publish to (npm, PyPI, their own site,
 * an MCP registry page). We cannot verify these automatically, so they are
 * queued for review instead of being turned away.
 */
export function normalizePublicUrl(raw: string): { url: string; host: string; guessName: string } | null {
  const trimmed = raw.trim();
  if (!/^https?:\/\//i.test(trimmed)) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  if (!host.includes(".")) return null;
  const parts = parsed.pathname.split("/").filter(Boolean);
  const last = parts[parts.length - 1]?.replace(/\.git$/, "") ?? "";
  const guessName = last ? `${host}/${last}` : host;
  parsed.hash = "";
  return { url: parsed.toString().replace(/\/+$/, ""), host, guessName };
}

type Verified = {
  ok: boolean;
  reason: string;
  listing?: Listing;
  license: string;
  licenseVerified: boolean;
  topics: string[];
  stars: number | null;
  updated: string | null;
  description: string;
  category: CategoryId;
  kind: Kind | null;
};

/**
 * Verify a repo against its host. GitHub is verified through the public API
 * (one request, includes licence); GitLab and Bitbucket read their LICENSE file
 * the same way the runtime scanners do.
 */
async function verifyRepo(target: NonNullable<ReturnType<typeof normalizeRepoUrl>>): Promise<Verified> {
  const base: Verified = {
    ok: false,
    reason: "",
    license: "",
    licenseVerified: false,
    topics: [],
    stars: null,
    updated: null,
    description: "",
    category: "development",
    kind: null,
  };

  if (target.host === "github") {
    const res = await fetchText(`https://api.github.com/repos/${target.owner}/${target.repo}`, 9000);
    if (!res.ok) {
      if (res.status === 404) return { ...base, reason: "That GitHub repository is not public." };
      // The anonymous API allows only 60 requests/hour, so it is regularly
      // exhausted. Fall back to the public page plus the raw LICENSE file
      // rather than telling the submitter their repo cannot be checked.
      return verifyGithubFromPage(target, base);
    }
    let repo: {
      full_name: string;
      name: string;
      html_url: string;
      description: string | null;
      stargazers_count?: number;
      pushed_at?: string;
      updated_at?: string;
      topics?: string[];
      license?: { spdx_id?: string | null } | null;
      owner?: { login?: string };
      archived?: boolean;
      fork?: boolean;
      private?: boolean;
      default_branch?: string;
    };
    try {
      repo = JSON.parse(res.text);
    } catch {
      return { ...base, reason: "GitHub returned an unreadable response." };
    }
    if (repo.private) return { ...base, reason: "That repository is private." };
    if (repo.archived) return { ...base, reason: "That repository is archived, so it is not offered." };

    const topics = repo.topics ?? [];
    const description = repo.description?.trim() || "";
    const license = normalizeLicense(repo.license?.spdx_id);
    const kind = detectKind(repo.name || repo.full_name, description, topics);

    if (!license) {
      // The API reports NOASSERTION for repos that do ship a LICENSE file, so
      // read the file before rejecting on the API's word alone.
      const fallback = await readGithubLicense(target.owner, target.repo, repo.default_branch || "main");
      if (!fallback) {
        return {
          ...base,
          topics,
          stars: repo.stargazers_count ?? null,
          updated: repo.pushed_at ?? repo.updated_at ?? null,
          description,
          kind,
          reason: "No free licence found. The index only lists repositories with a free, public licence.",
        };
      }
      const listing = githubRepoToListing({ ...repo, license: { spdx_id: fallback } });
      if (!listing) {
        return { ...base, reason: "That repository does not look like a skill or an MCP server." };
      }
      return {
        ...base,
        ok: true,
        reason: "Verified public, free licence, and a skill or MCP server.",
        listing,
        license: fallback,
        licenseVerified: true,
        topics: topics.slice(0, 6),
        stars: repo.stargazers_count ?? null,
        updated: repo.pushed_at ?? repo.updated_at ?? null,
        description,
        category: listing.category,
        kind: listing.kind,
      };
    }

    const listing = githubRepoToListing(repo);
    if (!listing) {
      return {
        ...base,
        topics,
        stars: repo.stargazers_count ?? null,
        updated: repo.pushed_at ?? repo.updated_at ?? null,
        description,
        license,
        licenseVerified: true,
        kind,
        reason: "Public and free, but it does not describe a skill or an MCP server.",
      };
    }
    return {
      ...base,
      ok: true,
      reason: "Verified public, free licence, and a skill or MCP server.",
      listing,
      license,
      licenseVerified: true,
      topics: listing.topics,
      stars: listing.stars,
      updated: listing.updated,
      description,
      category: listing.category,
      kind: listing.kind,
    };
  }

  // GitLab / Bitbucket: read the licence file directly, as the scanners do.
  const licenseNames = ["LICENSE", "LICENSE.md", "LICENSE.txt", "LICENCE", "COPYING"];
  let license: string | null = null;
  for (const name of licenseNames) {
    const fileUrl =
      target.host === "gitlab"
        ? `https://gitlab.com/${target.owner}/${target.repo}/-/raw/main/${name}`
        : `https://api.bitbucket.org/2.0/repositories/${target.owner}/${target.repo}/src/main/${name}`;
    const res = await fetchText(fileUrl, 7000);
    if (!res.ok) continue;
    license = licenseFromText(res.text);
    if (license) break;
  }
  if (!license) {
    return { ...base, reason: "No free licence file found at the repository root." };
  }
  const kind = detectKind(`${target.owner}/${target.repo}`, "", []);
  if (!kind) {
    return { ...base, license, licenseVerified: true, reason: "Free, but it does not describe a skill or an MCP server." };
  }
  const listing: Listing = {
    id: listingId(target.url),
    kind,
    name: `${target.owner}/${target.repo}`,
    description: clip(`${kind === "skill" ? "Agent skill" : "MCP server"} on ${target.host}.`),
    category: classifyCategory(`${target.owner}/${target.repo}`),
    source: target.host,
    url: target.url,
    owner: target.owner,
    license,
    stars: null,
    updated: null,
    install: installLines({ kind, url: target.url, license, source: target.host }),
    access: `Public ${target.host} repository. License file checked. Free to clone.`,
    topics: [],
  };
  return {
    ...base,
    ok: true,
    reason: "Verified public and free.",
    listing,
    license,
    licenseVerified: true,
    category: listing.category,
    kind,
  };
}

/**
 * API-free GitHub check: read the public repository page for the description,
 * then the raw LICENSE file on either common default branch. Stars are unknown
 * here, which is fine — they are refreshed by the crawler.
 */
async function verifyGithubFromPage(
  target: { owner: string; repo: string; url: string },
  base: Verified,
): Promise<Verified> {
  const page = await fetchText(`https://github.com/${target.owner}/${target.repo}`, 9000);
  if (!page.ok) {
    return {
      ...base,
      reason:
        page.status === 404
          ? "That GitHub repository is not public."
          : "GitHub did not answer that lookup.",
    };
  }
  const rawDesc =
    /<p class="f4 my-3">([\s\S]*?)<\/p>/i.exec(page.text)?.[1] ??
    /<meta[^>]+name="description"[^>]+content="([^"]*)"/i.exec(page.text)?.[1] ??
    "";
  const description = decodeEntities(rawDesc.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
  const license =
    (await readGithubLicense(target.owner, target.repo, "main")) ??
    (await readGithubLicense(target.owner, target.repo, "master"));
  const kind = detectKind(target.repo, description, []);

  if (!license) {
    return {
      ...base,
      description,
      kind,
      reason: "No free licence found. The index only lists repositories with a free, public licence.",
    };
  }
  if (!kind) {
    return {
      ...base,
      description,
      license,
      licenseVerified: true,
      reason: "Public and free, but it does not describe a skill or an MCP server.",
    };
  }
  const listing: Listing = {
    id: listingId(target.url),
    kind,
    name: `${target.owner}/${target.repo}`,
    description: clip(description || `${kind === "skill" ? "Agent skill" : "MCP server"} on GitHub.`),
    category: classifyCategory(`${target.repo} ${description}`),
    source: "github",
    url: target.url,
    owner: target.owner,
    license,
    stars: null,
    updated: null,
    install: installLines({ kind, url: target.url, license, source: "github" }),
    access: "Public GitHub repository. Free license. Clone it with no account.",
    topics: [],
  };
  return {
    ...base,
    ok: true,
    reason: "Verified public and free (checked without the GitHub API).",
    listing,
    license,
    licenseVerified: true,
    category: listing.category,
    kind,
    description,
  };
}

function decodeEntities(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

async function readGithubLicense(owner: string, repo: string, branch: string): Promise<string | null> {
  for (const name of ["LICENSE", "LICENSE.md", "LICENSE.txt", "LICENCE", "COPYING"]) {
    const res = await fetchText(
      `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(branch)}/${name}`,
      6000,
    );
    if (!res.ok) continue;
    const spdx = licenseFromText(res.text);
    if (spdx) return spdx;
  }
  return null;
}

/** Submit one repository and have it verified before it enters the index. */
export const submitSkill = createServerFn({ method: "POST" })
  .validator((input: unknown) => SubmissionInput.parse(input ?? {}))
  .handler(async ({ data }): Promise<SubmissionResult> => {
    const target = normalizeRepoUrl(data.url);
    if (!target) {
      // Not one of the three hosts we can verify. If it is still a public URL,
      // queue it for a human look rather than rejecting it outright — people
      // publish skills on npm, PyPI, their own sites, and other registries.
      const other = normalizePublicUrl(data.url);
      if (!other) {
        return {
          ok: false,
          state: "rejected",
          message:
            "Paste a public link. GitHub, GitLab, or Bitbucket is verified automatically; any other public page is queued for review.",
        };
      }
      const sql = await getSql();
      const id = listingId(other.url);
      const seen = await sql.query<{ state: string }>(
        "select state from skill_submissions where url = $1",
        [id],
      );
      if (seen.length > 0) {
        return {
          ok: seen[0].state === "approved",
          state: "duplicate",
          message:
            seen[0].state === "approved"
              ? "That one is already listed."
              : "That one is already in the queue for review.",
        };
      }
      const blob = `${other.guessName} ${data.note}`.toLowerCase();
      const kind: Kind = /(^|[^a-z])mcp|model context protocol/.test(blob) ? "mcp" : "skill";
      await sql.query(
        `insert into skill_submissions
           (url, name, kind, description, category, license, license_verified, topics, submitter, state, check_note)
         values ($1, $2, $3, $4, $5, $6, false, $7, $8, 'pending', $9)
         on conflict (url) do nothing`,
        [
          id,
          other.guessName,
          kind,
          clip(data.note || `Published on ${other.host}.`),
          classifyCategory(`${other.guessName} ${data.note}`),
          "",
          [],
          data.submitter,
          `Queued for review: ${other.host} cannot be verified automatically.`,
        ],
      );
      return {
        ok: false,
        state: "pending",
        message: `Queued for review. ${other.host} cannot be checked automatically, so a person will confirm it is public and free before it appears.`,
      };
    }

    const sql = await getSql();
    const id = listingId(target.url);
    const existing = await sql.query<{ url: string; state: string }>(
      "select url, state from skill_submissions where url = $1",
      [id],
    );

    const verified = await verifyRepo(target);

    if (existing.length > 0) {
      const state = existing[0].state;
      return {
        ok: state === "approved",
        state: "duplicate",
        message:
          state === "approved"
            ? "That one is already listed."
            : state === "pending"
              ? "That one is already in the queue for review."
              : "That one was already submitted and could not be verified.",
        listing: verified.listing,
      };
    }

    // `state` is decided by the verification, not by the submitter.
    const state = verified.ok ? "approved" : "pending";
    const name = verified.listing?.name ?? `${target.owner}/${target.repo}`;
    const kind = verified.kind ?? "skill";

    await sql.query(
      `insert into skill_submissions
         (url, name, kind, description, category, license, license_verified, stars, updated, topics, submitter, state, check_note)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       on conflict (url) do nothing`,
      [
        id,
        name,
        kind,
        clip(verified.description || data.note || "", 400),
        verified.category,
        verified.license,
        verified.licenseVerified,
        verified.stars,
        verified.updated,
        verified.topics,
        data.submitter,
        state,
        verified.reason,
      ],
    );

    return {
      ok: verified.ok,
      state,
      message: verified.ok
        ? `Added to the index. ${verified.reason}`
        : `Saved for review. ${verified.reason}`,
      listing: verified.listing,
    };
  });

export type ApprovedListing = Listing & { submittedAt: string };

/** Approved community submissions, shaped as listings so the UI can merge them. */
export const approvedSubmissions = createServerFn({ method: "GET" }).handler(
  async (): Promise<ApprovedListing[]> => {
    const sql = await getSql();
    const rows = await sql.query<{
      url: string;
      name: string;
      kind: string;
      description: string;
      category: string;
      license: string;
      stars: number | null;
      updated: string | null;
      topics: string[];
      created_at: string;
    }>(
      `select url, name, kind, description, category, license, stars, updated, topics, created_at
         from skill_submissions
        where state = 'approved'
        order by created_at desc
        limit 500`,
    );
    return rows.map((r) => {
      const kind = (r.kind === "mcp" ? "mcp" : "skill") as Kind;
      return {
        id: listingId(r.url),
        kind,
        name: r.name,
        description: r.description,
        category: (r.category as CategoryId) ?? "development",
        source: r.url.includes("gitlab.com") ? "gitlab" : r.url.includes("bitbucket.org") ? "bitbucket" : "github",
        url: r.url,
        owner: r.name.split("/")[0] ?? "",
        license: r.license || "free",
        stars: r.stars,
        updated: r.updated,
        install: installLines({ kind, url: r.url, license: r.license || "free", source: "github" }),
        access: "Community submission, verified public with a free licence.",
        topics: r.topics ?? [],
        submittedAt: new Date(r.created_at).toISOString(),
      } satisfies ApprovedListing;
    });
  },
);
