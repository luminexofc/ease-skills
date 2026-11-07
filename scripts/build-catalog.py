#!/usr/bin/env python3
"""One-shot snapshot of free public skills and MCP servers into src/data/catalog.ts."""
import json, re, time, urllib.parse, urllib.request
from pathlib import Path

UA = "EaseSkillsCatalog/1.0"
OUT = Path("/workspace/src/data/catalog.ts")

FREE = {
    "MIT", "MIT-0", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "BSD-3-Clause-Clear",
    "ISC", "MPL-2.0", "Unlicense", "0BSD", "Zlib", "BSL-1.0", "CC0-1.0", "Artistic-2.0",
    "PostgreSQL", "WTFPL", "EUPL-1.2", "GPL-2.0", "GPL-3.0", "AGPL-3.0",
    "LGPL-2.0", "LGPL-2.1", "LGPL-3.0",
}

RULES = [
    ("video", ["video", "ffmpeg", "subtitle", "storyboard", "animation", "remotion", "youtube", "gif", "caption"]),
    ("design", ["design", "figma", "canvas", "brand", "poster", "frontend", "drawio", "diagram", "typography", "css", "blender"]),
    ("writing", ["writing", "docx", "pdf", "pptx", "slides", "markdown", "copywriting", "comms", "documentation"]),
    ("data", ["database", "sql", "postgres", "sqlite", "redis", "spreadsheet", "xlsx", "csv", "analytics"]),
    ("research", ["research", "arxiv", "paper", "search", "docs", "knowledge", "fetch", "wikipedia"]),
    ("automation", ["automation", "browser", "playwright", "puppeteer", "workflow", "scrape", "selenium", "chrome"]),
    ("productivity", ["memory", "calendar", "slack", "email", "task", "notes", "todo", "obsidian"]),
    ("development", ["code", "git", "github", "gitlab", "sdk", "debug", "test", "api", "server", "developer"]),
]


def get(url, accept="application/json", timeout=25):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": accept})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read()
    except Exception as e:
        body = e.read() if hasattr(e, "read") else str(e).encode()
        return getattr(e, "code", 0), body


def norm_license(spdx):
    if not spdx or spdx in {"NOASSERTION", "OTHER", "NONE"}:
        return None
    base = spdx.replace("-only", "").replace("-or-later", "")
    if spdx in FREE or base in FREE:
        return spdx
    return None


def license_from_text(text):
    t = text[:6000].lower()
    if "apache license" in t and "version 2.0" in t:
        return "Apache-2.0"
    if "gnu affero general public license" in t:
        return "AGPL-3.0"
    if "gnu lesser general public license" in t or "gnu library general public license" in t:
        return "LGPL-3.0"
    if "gnu general public license" in t:
        return "GPL-3.0"
    if "mozilla public license" in t:
        return "MPL-2.0"
    if "permission is hereby granted, free of charge" in t:
        return "MIT"
    if "this is free and unencumbered software" in t:
        return "Unlicense"
    if "bsd zero clause" in t or "zero-clause bsd" in t:
        return "0BSD"
    if "isc license" in t or "permission to use, copy, modify, and/or distribute" in t:
        return "ISC"
    if "redistribution and use in source and binary forms" in t:
        return "BSD-3-Clause" if "neither the name" in t else "BSD-2-Clause"
    return None


def classify(text):
    hay = f" {text.lower()} "
    best, score = "development", 0
    for cid, words in RULES:
        n = sum(1 for w in words if w in hay)
        if n > score:
            best, score = cid, n
    return best


def detect_kind(name, description, topics):
    topic_set = {t.lower() for t in topics}
    blob = f"{name} {description}".lower()
    skill = (
        "skill.md" in blob
        or "agent skill" in blob
        or "agent skills" in blob
        or "claude skill" in blob
        or "agent-skills" in topic_set
        or "claude-skills" in topic_set
        or bool(re.search(r"(^|[-_/])skills?$", name.lower()))
    )
    mcp = (
        bool(re.search(r"(^|[-_/])mcp([-_/]|$)", name.lower()))
        or "mcp-server" in name.lower()
        or name.lower().endswith("-mcp")
        or "mcp server" in blob
        or "mcp-server" in blob
        or "model context protocol" in blob
        or "mcp" in topic_set
        or "mcp-server" in topic_set
        or "model-context-protocol" in topic_set
    )
    if skill and mcp:
        return "skill" if "skill" in name.lower() else "mcp"
    if skill:
        return "skill"
    if mcp:
        return "mcp"
    return None


def clip(text, n=220):
    clean = re.sub(r"\s+", " ", text or "").strip()
    if len(clean) <= n:
        return clean
    return clean[: n - 1].rstrip() + "…"


def install(kind, url, license, source):
    clone = url.rstrip("/")
    if kind == "skill":
        return "\n".join([
            f"# {license} · public {source} repo · no account",
            f"git clone --depth 1 {clone}.git",
            "# Copy the skill folder (the one with SKILL.md) into your agent:",
            "# Claude Code  ~/.claude/skills/",
            "# Cursor       .cursor/skills/",
            "# Codex        .agents/skills/",
        ])
    return "\n".join([
        f"# {license} · public source · free to read, clone, and run",
        f"git clone --depth 1 {clone}.git",
        "# Follow the README to register it with any MCP client.",
        "# No paid plan is required to get the code.",
    ])


def listing(**kwargs):
    url = kwargs["url"].rstrip("/")
    kwargs["id"] = url.lower()
    kwargs["description"] = clip(kwargs["description"])
    return kwargs


items = []
seen = set()


def add(item):
    if not item or item["id"] in seen:
        return
    if not item["description"]:
        return
    seen.add(item["id"])
    items.append(item)


# --- Anthropic skills, each Apache-2.0 file checked ---
status, body = get("https://api.github.com/repos/anthropics/skills/contents/skills", "application/vnd.github+json")
dirs = [d["name"] for d in json.loads(body) if d.get("type") == "dir"] if status == 200 else []
print("anthropic skill dirs", len(dirs))
for name in dirs:
    status, body = get(
        f"https://raw.githubusercontent.com/anthropics/skills/main/skills/{name}/SKILL.md",
        "text/plain",
    )
    text = body.decode("utf-8", "replace") if status == 200 else ""
    desc = ""
    m = re.search(r"^description:\s*(.+)$", text, re.M)
    if m:
        desc = m.group(1).strip().strip('"').strip("'")
    status, lic_body = get(
        f"https://raw.githubusercontent.com/anthropics/skills/main/skills/{name}/LICENSE.txt",
        "text/plain",
    )
    license_id = license_from_text(lic_body.decode("utf-8", "replace")) if status == 200 else None
    if license_id != "Apache-2.0":
        print(" skip skill", name, "license", license_id, status)
        continue
    url = f"https://github.com/anthropics/skills/tree/main/skills/{name}"
    add(listing(
        kind="skill",
        name=name,
        description=desc or f"Agent skill {name} from the public Anthropic skills repository.",
        category=classify(f"{name} {desc}"),
        source="github",
        url=url,
        owner="anthropics",
        license="Apache-2.0",
        stars=None,
        updated=None,
        install="\n".join([
            "# Apache-2.0 · public · no account",
            "git clone --depth 1 https://github.com/anthropics/skills.git",
            f"# Copy skills/{name} into your agent:",
            "# Claude Code  ~/.claude/skills/",
            "# Cursor       .cursor/skills/",
            "# Codex        .agents/skills/",
        ]),
        access="One folder inside the public Apache-2.0 repo anthropics/skills. Copy it. No account.",
        topics=["agent-skills", "anthropics/skills"],
    ))
    time.sleep(0.15)

# --- GitHub searches ---
queries = [
    'mcp-server in:name fork:false archived:false',
    '"model context protocol" in:description fork:false archived:false',
    'topic:agent-skills fork:false archived:false',
    '"agent skills" in:description fork:false archived:false',
    '"SKILL.md" video in:description fork:false archived:false',
    'topic:mcp-server fork:false archived:false',
]
for q in queries:
    url = "https://api.github.com/search/repositories?q=" + urllib.parse.quote(q) + "&sort=stars&order=desc&per_page=15"
    status, body = get(url, "application/vnd.github+json")
    print("GH", status, q[:60])
    if status != 200:
        print(body[:180])
        time.sleep(2)
        continue
    data = json.loads(body)
    kept = 0
    for repo in data.get("items", []):
        license_id = norm_license((repo.get("license") or {}).get("spdx_id"))
        if not license_id:
            continue
        topics = repo.get("topics") or []
        desc = repo.get("description") or ""
        kind = detect_kind(repo["name"], desc, topics)
        if not kind:
            continue
        if not desc.strip():
            continue
        web = repo["html_url"]
        add(listing(
            kind=kind,
            name=repo["full_name"],
            description=desc,
            category=classify(f"{repo['name']} {desc} {' '.join(topics)}"),
            source="github",
            url=web,
            owner=(repo.get("owner") or {}).get("login") or repo["full_name"].split("/")[0],
            license=license_id,
            stars=repo.get("stargazers_count"),
            updated=repo.get("updated_at"),
            install=install(kind, web, license_id, "github"),
            access="Public GitHub repository. Free license. Clone it with no account.",
            topics=topics[:6],
        ))
        kept += 1
    print("  kept", kept, "total", data.get("total_count"))
    time.sleep(2.2)

# --- GitLab ---
gl_queries = ["model context protocol", "mcp server", "agent skills", "SKILL.md"]
checked = 0
for q in gl_queries:
    url = "https://gitlab.com/api/v4/projects?search=" + urllib.parse.quote(q) + "&visibility=public&order_by=star_count&sort=desc&per_page=8"
    status, body = get(url)
    print("GL", status, q)
    if status != 200:
        continue
    try:
        projects = json.loads(body)
    except Exception:
        continue
    if not isinstance(projects, list):
        continue
    for p in projects:
        if checked >= 18:
            break
        kind = detect_kind(p.get("path_with_namespace") or "", p.get("description") or "", p.get("topics") or [])
        if not kind:
            continue
        checked += 1
        branch = p.get("default_branch") or "main"
        license_id = None
        for fname in ("LICENSE", "LICENSE.md", "LICENSE.txt", "LICENCE", "COPYING"):
            raw = f"https://gitlab.com/api/v4/projects/{p['id']}/repository/files/{urllib.parse.quote(fname)}/raw?ref={urllib.parse.quote(branch)}"
            st, lb = get(raw, "text/plain", timeout=15)
            if st == 200:
                license_id = license_from_text(lb.decode("utf-8", "replace"))
                if license_id:
                    break
        if not license_id:
            print("  no license", p.get("path_with_namespace"))
            continue
        web = p["web_url"].rstrip("/")
        topics = p.get("topics") or []
        desc = p.get("description") or ""
        add(listing(
            kind=kind,
            name=p["path_with_namespace"],
            description=desc,
            category=classify(f"{p.get('name','')} {desc} {' '.join(topics)}"),
            source="gitlab",
            url=web,
            owner=p["path_with_namespace"].split("/")[0],
            license=license_id,
            stars=p.get("star_count"),
            updated=p.get("last_activity_at"),
            install=install(kind, web, license_id, "gitlab"),
            access="Public GitLab project. License file checked. Free to clone.",
            topics=topics[:6],
        ))
        print("  +", p["path_with_namespace"], license_id)

# --- Bitbucket workspaces ---
workspaces = ["atlassian", "unctad", "_nkhalasi", "toryt", "daam4110", "apache", "python"]
for ws in workspaces:
    for q in ('name ~ "mcp" OR description ~ "mcp"', 'name ~ "skill" OR description ~ "skill"'):
        url = f"https://api.bitbucket.org/2.0/repositories/{urllib.parse.quote(ws)}?" + urllib.parse.urlencode({"q": q, "pagelen": "10"})
        status, body = get(url, timeout=20)
        if status != 200:
            print("BB", ws, status)
            break
        try:
            values = json.loads(body).get("values") or []
        except Exception:
            continue
        print("BB", ws, q[:24], "n", len(values))
        for repo in values:
            if repo.get("is_private"):
                continue
            full = repo.get("full_name") or ""
            desc = repo.get("description") or ""
            kind = detect_kind(full, desc, [])
            if not kind:
                continue
            branch = ((repo.get("mainbranch") or {}).get("name")) or "main"
            license_id = None
            for fname in ("LICENSE", "LICENSE.md", "LICENSE.txt", "LICENCE", "COPYING"):
                raw = f"https://api.bitbucket.org/2.0/repositories/{full}/src/{urllib.parse.quote(branch)}/{fname}"
                st, lb = get(raw, "text/plain", timeout=15)
                if st == 200:
                    license_id = license_from_text(lb.decode("utf-8", "replace"))
                    if license_id:
                        break
            if not license_id:
                print("  no license", full)
                continue
            web = repo["links"]["html"]["href"].rstrip("/")
            add(listing(
                kind=kind,
                name=full,
                description=desc or f"Public {kind} on Bitbucket.",
                category=classify(f"{repo.get('name','')} {desc}"),
                source="bitbucket",
                url=web,
                owner=full.split("/")[0],
                license=license_id,
                stars=None,
                updated=repo.get("updated_on"),
                install=install(kind, web, license_id, "bitbucket"),
                access="Public Bitbucket repository. License file checked. Free to clone.",
                topics=[],
            ))
            print("  +", full, license_id)

items.sort(key=lambda x: (-(x["stars"] or 0), x["name"].lower()))
print("TOTAL", len(items), "skills", sum(1 for i in items if i["kind"]=="skill"), "mcp", sum(1 for i in items if i["kind"]=="mcp"))
by_src = {}
by_cat = {}
for i in items:
    by_src[i["source"]] = by_src.get(i["source"], 0) + 1
    by_cat[i["category"]] = by_cat.get(i["category"], 0) + 1
print("sources", by_src)
print("cats", by_cat)

header = '''import type { Listing } from "@/lib/types";

/** Verified public, free-license skills and MCP servers. Refreshed by a host scan in the app. */
export const catalog: Listing[] = '''
OUT.parent.mkdir(parents=True, exist_ok=True)
OUT.write_text(header + json.dumps(items, indent=2) + ";\n")
print("wrote", OUT)
