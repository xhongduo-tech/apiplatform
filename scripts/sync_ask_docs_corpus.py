#!/usr/bin/env python3
"""从接口文档（zh-CN i18n + 端点表）同步 Ask Docs 语料。

用法（仓库根目录）：
  python3 scripts/sync_ask_docs_corpus.py

输出：backend/app/data/ask_docs_corpus.json
文档正文变更后请重新运行本脚本并提交生成文件，保证智能问答与 /docs 一致。
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
I18N_ZH = ROOT / "frontend/src/app/i18n/zh-CN.ts"
SEARCH_DATA = ROOT / "frontend/src/app/components/docs/docs-search-data.ts"
ENDPOINTS_TSX = ROOT / "frontend/src/app/components/docs/docs-endpoints-table.tsx"
OUT = ROOT / "backend/app/data/ask_docs_corpus.json"

# 搜索索引未覆盖、但文档页存在的补充键
_EXTRA_KEYS: dict[str, list[str]] = {
    "versioning": [
        "docsPage.versioning.header.title",
        "docsPage.versioning.header.body",
        "docsPage.versioning.stability.title",
        "docsPage.versioning.stability.body",
        "docsPage.versioning.deprecation.title",
        "docsPage.versioning.deprecation.body",
    ],
    "rate-limits": [
        "docsPage.rate.tiers.unlimitedValue",
    ],
}

# 组件内硬编码、未进 i18n 的补充句（与 docs-sections-core 档位表一致）
_SUPPLEMENTS: dict[str, str] = {
    "rate-limits": (
        "并发档位数值：平台默认 600 RPM / 6,000,000 TPM；"
        "高并发 3,000 RPM / 60,000,000 TPM；超高并发不限速。"
    ),
}

_HTML_RE = re.compile(r"<[^>]+>")
_WS_RE = re.compile(r"\s+")
_I18N_ENTRY_RE = re.compile(
    r'^\s*"((?:docsPage\.)[^"]+)":\s*"((?:\\.|[^"\\])*)"\s*,?\s*$',
    re.M,
)
# 支持 introduction: [...] 与 "api-reference/endpoints": [...]
_SECTION_BLOCK_RE = re.compile(
    r'^\s*(?:"([^"]+)"|([A-Za-z_][\w/-]*)):\s*\[\s*((?:.|\n)*?)^\s*\],?',
    re.M,
)
_KEY_IN_LIST_RE = re.compile(r'"((?:docsPage\.)[^"]+)"')
_ENDPOINT_ITEM_RE = re.compile(
    r'\{\s*method:\s*"([^"]+)"\s*,\s*path:\s*"([^"]+)"\s*,\s*key:\s*"((?:docsPage\.)[^"]+)"',
)
_ENDPOINT_GROUP_RE = re.compile(
    r'section:\s*"((?:docsPage\.)[^"]+)"\s*,\s*id:\s*"([^"]+)"',
)


def _unescape_ts_string(s: str) -> str:
    return (
        s.replace("\\n", "\n")
        .replace("\\t", "\t")
        .replace('\\"', '"')
        .replace("\\\\", "\\")
    )


def _plain(s: str) -> str:
    s = _HTML_RE.sub("", s)
    s = s.replace("&nbsp;", " ").replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&")
    return _WS_RE.sub(" ", s).strip()


def load_i18n(path: Path) -> dict[str, str]:
    text = path.read_text(encoding="utf-8")
    out: dict[str, str] = {}
    for m in _I18N_ENTRY_RE.finditer(text):
        out[m.group(1)] = _unescape_ts_string(m.group(2))
    if len(out) < 100:
        raise SystemExit(f"解析 i18n 失败，仅得到 {len(out)} 个 docsPage 键：{path}")
    return out


def load_section_keys(path: Path) -> dict[str, list[str]]:
    text = path.read_text(encoding="utf-8")
    # 只取 SECTION_CONTENT_KEYS 对象体
    start = text.find("export const SECTION_CONTENT_KEYS")
    if start < 0:
        raise SystemExit(f"未找到 SECTION_CONTENT_KEYS：{path}")
    body = text[start:]
    sections: dict[str, list[str]] = {}
    for m in _SECTION_BLOCK_RE.finditer(body):
        sid = m.group(1) or m.group(2)
        keys = _KEY_IN_LIST_RE.findall(m.group(3))
        if sid and keys:
            sections[sid] = keys
    if "introduction" not in sections:
        raise SystemExit(f"解析 SECTION_CONTENT_KEYS 失败（已解析 {sorted(sections)}）")
    return sections


def load_endpoints(path: Path, i18n: dict[str, str]) -> str:
    """把端点表编成可读语料：分组标题 + METHOD path — 说明。"""
    text = path.read_text(encoding="utf-8")
    # 按 group 切分：每个 section/id 块后跟 items
    parts: list[str] = []
    # 简单扫描：每遇到 group section，记录当前 section label，再收集 items
    current_section = ""
    lines_out: list[str] = []
    for line in text.splitlines():
        gm = re.search(r'section:\s*"((?:docsPage\.)[^"]+)"', line)
        if gm:
            if lines_out and current_section:
                parts.append(current_section + "\n" + "\n".join(lines_out))
                lines_out = []
            current_section = _plain(i18n.get(gm.group(1), gm.group(1)))
            continue
        im = _ENDPOINT_ITEM_RE.search(line)
        if im:
            method, pth, key = im.group(1), im.group(2), im.group(3)
            desc = _plain(i18n.get(key, key))
            lines_out.append(f"{method} {pth} — {desc}")
    if lines_out and current_section:
        parts.append(current_section + "\n" + "\n".join(lines_out))
    if not parts:
        raise SystemExit(f"解析端点表失败：{path}")
    title = _plain(i18n.get("docsPage.reference.endpoints.title", "端点总表"))
    desc = _plain(i18n.get("docsPage.reference.endpoints.desc", ""))
    return f"{title}。{desc}\n\n" + "\n\n".join(parts)


def build_corpus(i18n: dict[str, str], section_keys: dict[str, list[str]]) -> dict[str, str]:
    corpus: dict[str, str] = {}
    for sid, keys in section_keys.items():
        merged_keys = list(keys)
        for k in _EXTRA_KEYS.get(sid, []):
            if k not in merged_keys:
                merged_keys.append(k)
        # 端点总表：额外纳入所有 reference.endpoints.* 文案键
        if sid == "api-reference/endpoints":
            for k in sorted(i18n):
                if k.startswith("docsPage.reference.endpoints.") and k not in merged_keys:
                    # 表头列名对问答价值低，跳过
                    if k.endswith(("methodHeader", "pathHeader", "descHeader")):
                        continue
                    merged_keys.append(k)

        chunks: list[str] = []
        for k in merged_keys:
            val = i18n.get(k)
            if not val:
                continue
            plain = _plain(val)
            if plain:
                chunks.append(plain)
        text = " ".join(chunks)
        if sid in _SUPPLEMENTS:
            text = (text + " " + _SUPPLEMENTS[sid]).strip()
        if text:
            corpus[sid] = text

    # 用端点表路径信息覆盖/增强端点总表（含 METHOD + path）
    endpoints_text = load_endpoints(ENDPOINTS_TSX, i18n)
    corpus["api-reference/endpoints"] = endpoints_text
    # 兼容旧语料键名
    corpus["api-reference"] = endpoints_text
    return corpus


def main() -> int:
    if not I18N_ZH.is_file():
        print(f"✗ 找不到 {I18N_ZH}", file=sys.stderr)
        return 1
    i18n = load_i18n(I18N_ZH)
    # 只保留 docsPage
    i18n = {k: v for k, v in i18n.items() if k.startswith("docsPage.")}
    section_keys = load_section_keys(SEARCH_DATA)
    corpus = build_corpus(i18n, section_keys)

    required = [
        "introduction", "quickstart", "authentication", "base-urls", "models",
        "errors", "rate-limits", "pagination", "versioning", "thinking-mode",
        "vision", "tool-use", "multi-turn", "json-mode", "token-usage",
        "context-caching", "chat-api", "embeddings-rerank", "completions",
        "responses", "messages", "count-tokens", "api-reference/endpoints",
        "infrastructure", "agent-tools", "usage-logs", "night-batch",
        "best-practices", "faq", "changelog",
    ]
    missing = [s for s in required if s not in corpus or not corpus[s].strip()]
    if missing:
        print(f"✗ 语料缺少章节：{missing}", file=sys.stderr)
        return 1

    OUT.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "source": "frontend/src/app/i18n/zh-CN.ts + docs-search-data.ts + docs-endpoints-table.tsx",
        "section_count": len(corpus),
        "sections": corpus,
    }
    OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    total_chars = sum(len(v) for v in corpus.values())
    print(f"✔ 已写入 {OUT.relative_to(ROOT)}：{len(corpus)} 章，约 {total_chars:,} 字")
    for sid in required:
        print(f"  · {sid}: {len(corpus[sid])} 字")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
