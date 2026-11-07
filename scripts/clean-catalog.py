#!/usr/bin/env python3
"""Drop false positives, fix skill blurbs, add two canonical free MCP repos."""
import json, re, urllib.request
from pathlib import Path

path = Path("/workspace/src/data/catalog.ts")
raw = path.read_text()
start = raw.index("= [") + 2
end = raw.rindex("]") + 1
items = json.loads(raw[start:end])

DROP = {
    "https://github.com/morluto/rea",
    "https://github.com/paperclipai/paperclip",
    "https://github.com/google-gemini/gemini-cli",
    "https://github.com/d4vinci/scrapling",
    "https://github.com/koala73/worldmonitor",
    "https://github.com/ruvnet/ruflo",
    "https://github.com/career-ops-hq/career-ops",
    "https://github.com/sansan0/trendradar",
    "https://github.com/reactive-resume/reactive-resume",
    "https://github.com/bytedance/ui-tars-desktop",
    "https://github.com/apify/apify-mcp-server",
    "https://github.com/nexu-io/open-design",
}

CAT = {
    "algorithmic-art": "design",
    "brand-guidelines": "design",
    "canvas-design": "design",
    "frontend-design": "design",
    "slack-gif-creator": "video",
    "theme-factory": "design",
    "web-artifacts-builder": "development",
    "webapp-testing": "development",
    "docx": "writing",
    "pdf": "writing",
    "pptx": "writing",
    "xlsx": "data",
    "internal-comms": "writing",
    "mcp-builder": "development",
    "skill-creator": "development",
    "claude-api": "development",
    "academy-guide": "research",
    "discernment-nudge": "research",
    "kepano/obsidian-skills": "productivity",
}

def clip(text, n=220):
    clean = re.sub(r"\s+", " ", text or "").strip()
    clean = re.sub(r"[\U0001F300-\U0001FAFF\U00002700-\U000027BF\U0001F1E0-\U0001F1FF\uFE0F]", "", clean)
    clean = re.sub(r"\s+", " ", clean).strip(" -–")
    if len(clean) <= n:
        return clean
    return clean[: n - 1].rstrip() + "…"

def description_from_skill(text):
    if not text.startswith("---"):
        return ""
    end = text.find("\n---", 3)
    fm = text[3:end]
    m = re.search(r"^description:\s*(.*)$", fm, re.M)
    if not m:
        return ""
    first = m.group(1).strip()
    if first in {">", "|", ">-", "|-", "|+"} or first.startswith(">") or first.startswith("|"):
        lines = []
        for line in fm[m.end() :].splitlines():
            if line and not line[:1].isspace():
                break
            lines.append(line.strip())
        return " ".join(x for x in lines if x)
    return first.strip("\"'")

UA = {"User-Agent": "EaseSkillsCatalog/1.0"}
kept = []
for item in items:
    if item["url"].rstrip("/").lower() in DROP or item["id"].rstrip("/") in DROP:
        print("drop", item["name"])
        continue
    item["description"] = clip(item["description"])
    if item["owner"] == "anthropics" and item["url"].startswith("https://github.com/anthropics/skills/tree/"):
        skill = item["name"]
        url = f"https://raw.githubusercontent.com/anthropics/skills/main/skills/{skill}/SKILL.md"
        try:
            body = urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=20).read().decode()
            desc = description_from_skill(body)
            if desc:
                item["description"] = clip(desc)
        except Exception as e:
            print("desc fail", skill, e)
        if skill in CAT:
            item["category"] = CAT[skill]
    if item["name"] in CAT:
        item["category"] = CAT[item["name"]]
    if item["name"] == "wshobson/agents":
        item["kind"] = "skill"
        item["category"] = "development"
    if item["name"] == "upstash/context7":
        item["kind"] = "mcp"
        item["category"] = "research"
        item["access"] = "MIT source on GitHub. Public documentation lookup works without a paid plan."
    if not item["description"] or item["description"] in {">", "|-", "|"}:
        print("blank desc", item["name"])
        continue
    kept.append(item)

def add_repo(full, kind, category, license_id, access, description=None):
    url = f"https://github.com/{full}"
    if any(i["id"] == url.lower() for i in kept):
        print("already", full)
        return
    req = urllib.request.Request(
        f"https://api.github.com/repos/{full}",
        headers={**UA, "Accept": "application/vnd.github+json"},
    )
    data = json.loads(urllib.request.urlopen(req, timeout=20).read().decode())
    kept.append({
        "id": url.lower(),
        "kind": kind,
        "name": full,
        "description": clip(description or data.get("description") or ""),
        "category": category,
        "source": "github",
        "url": url,
        "owner": full.split("/")[0],
        "license": license_id,
        "stars": data.get("stargazers_count"),
        "updated": data.get("updated_at"),
        "install": "\n".join([
            f"# {license_id} · public source · free to read, clone, and run",
            f"git clone --depth 1 {url}.git",
            "# Follow the README to register it with any MCP client.",
            "# No paid plan is required to get the code.",
        ]),
        "access": access,
        "topics": (data.get("topics") or [])[:6],
    })
    print("added", full, data.get("stargazers_count"))

add_repo(
    "microsoft/playwright-mcp",
    "mcp",
    "automation",
    "Apache-2.0",
    "Public Apache-2.0 repo. Run it locally against a browser you already have. No subscription.",
)
add_repo(
    "modelcontextprotocol/servers",
    "mcp",
    "development",
    "MIT / Apache-2.0",
    "Official reference servers. The repo is public and free: existing code MIT, new code Apache-2.0. Clone and run locally.",
    "Reference MCP servers you run yourself — filesystem, fetch, git, memory, and more. Free to clone.",
)

kept.sort(key=lambda x: (-(x["stars"] or 0), x["name"].lower()))
print("now", len(kept), "skills", sum(i["kind"]=="skill" for i in kept), "mcp", sum(i["kind"]=="mcp" for i in kept))
from collections import Counter
print(Counter(i["category"] for i in kept))
print(Counter(i["source"] for i in kept))
header = '''import type { Listing } from "@/lib/types";

/** Verified public, free-license skills and MCP servers. A host scan can add more. */
export const catalog: Listing[] = '''
path.write_text(header + json.dumps(kept, indent=2, ensure_ascii=False) + ";\n")
