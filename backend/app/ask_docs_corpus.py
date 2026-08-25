"""Ask Docs 文档语料加载与检索。

语料由 scripts/sync_ask_docs_corpus.py 从接口文档（zh-CN i18n + 端点表）生成，
落盘为 app/data/ask_docs_corpus.json。文档变更后需重新同步。
"""
from __future__ import annotations

import json
import re
from functools import lru_cache
from pathlib import Path

_CORPUS_FILE = Path(__file__).resolve().parent / "data" / "ask_docs_corpus.json"

# 文档页一级章节（与 docs-sidebar / buildTocItems 对齐）；检索无命中时的兜底摘要用
_FALLBACK_SECTIONS = (
    "introduction",
    "quickstart",
    "authentication",
    "chat-api",
    "faq",
)

_TOKEN_RE = re.compile(r"[a-z0-9_./@+-]+", re.I)
_CJK_RUN_RE = re.compile(r"[\u4e00-\u9fff]+")


@lru_cache(maxsize=1)
def load_docs_corpus() -> dict[str, str]:
    """返回 section_id → 纯文本正文。文件缺失或损坏时返回空 dict。"""
    try:
        raw = json.loads(_CORPUS_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, TypeError):
        return {}
    sections = raw.get("sections") if isinstance(raw, dict) else None
    if not isinstance(sections, dict):
        return {}
    out: dict[str, str] = {}
    for k, v in sections.items():
        if isinstance(k, str) and isinstance(v, str) and v.strip():
            out[k] = v.strip()
    return out


def corpus_section_ids() -> list[str]:
    return sorted(load_docs_corpus().keys())


def _query_terms(query: str) -> list[str]:
    """中英混合分词：英文按 token；中文取整段 + 双字窗口。"""
    q = (query or "").strip().lower()
    if not q:
        return []
    terms: list[str] = []
    for t in _TOKEN_RE.findall(q):
        if len(t) >= 2 or t.isdigit():
            terms.append(t.lower())
    for run in _CJK_RUN_RE.findall(q):
        terms.append(run)
        if len(run) >= 2:
            for i in range(len(run) - 1):
                terms.append(run[i : i + 2])
    # 去重保序
    seen: set[str] = set()
    out: list[str] = []
    for t in terms:
        if t not in seen:
            seen.add(t)
            out.append(t)
    return out


def _score_section(section_id: str, text: str, terms: list[str]) -> int:
    if not terms:
        return 0
    blob = f"{section_id} {text}".lower()
    score = 0
    for term in terms:
        if not term:
            continue
        # 章节 id 命中加权（如用户问「分页」命中 pagination）
        if term in section_id.replace("-", " ") or term in section_id:
            score += 8
        score += blob.count(term) * (3 if len(term) >= 2 else 1)
    return score


def search_docs(query: str, top_n: int = 6) -> str:
    """关键词匹配找出最相关的文档章节，拼接成 context 字符串。"""
    corpus = load_docs_corpus()
    if not corpus:
        return "（文档语料尚未同步，请管理员运行 scripts/sync_ask_docs_corpus.py）"

    terms = _query_terms(query)
    scored: list[tuple[int, str]] = []
    for section_id, text in corpus.items():
        # 兼容键 api-reference 与 api-reference/endpoints 内容相同，检索时跳过短别名避免重复
        if section_id == "api-reference" and "api-reference/endpoints" in corpus:
            continue
        score = _score_section(section_id, text, terms)
        if score > 0:
            scored.append((score, section_id))
    scored.sort(key=lambda x: x[0], reverse=True)
    top = scored[: max(1, top_n)]

    if not top:
        pieces = []
        for sid in _FALLBACK_SECTIONS:
            text = corpus.get(sid)
            if text:
                pieces.append(f"【{sid}】{text[:500]}")
        return "\n\n".join(pieces) if pieces else next(iter(corpus.values()))[:800]

    return "\n\n".join(f"【{sid}】{corpus[sid]}" for _, sid in top)
