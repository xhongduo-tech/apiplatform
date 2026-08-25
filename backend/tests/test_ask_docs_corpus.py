"""Ask Docs 语料覆盖接口文档一级章节，并支持中文检索。"""
from __future__ import annotations

from app.ask_docs_corpus import corpus_section_ids, load_docs_corpus, search_docs

# 与 docs-sidebar / buildTocItems 一级章节对齐
_REQUIRED_SECTIONS = {
    "introduction",
    "quickstart",
    "authentication",
    "base-urls",
    "models",
    "errors",
    "rate-limits",
    "pagination",
    "versioning",
    "thinking-mode",
    "vision",
    "tool-use",
    "multi-turn",
    "json-mode",
    "token-usage",
    "context-caching",
    "chat-api",
    "embeddings-rerank",
    "completions",
    "responses",
    "messages",
    "count-tokens",
    "api-reference/endpoints",
    "infrastructure",
    "agent-tools",
    "usage-logs",
    "night-batch",
    "best-practices",
    "faq",
    "changelog",
}


def test_corpus_covers_all_docs_sections():
    load_docs_corpus.cache_clear()
    corpus = load_docs_corpus()
    missing = sorted(_REQUIRED_SECTIONS - set(corpus))
    assert not missing, f"语料缺少文档章节：{missing}"
    for sid in _REQUIRED_SECTIONS:
        assert len(corpus[sid]) >= 40, f"{sid} 语料过短"


def test_corpus_includes_endpoint_paths():
    load_docs_corpus.cache_clear()
    endpoints = load_docs_corpus()["api-reference/endpoints"]
    for needle in (
        "POST /v1/chat/completions",
        "POST /v1/messages/count_tokens",
        "GET /v1/models",
        "/api/admin/backup/dump",
    ):
        assert needle in endpoints


def test_search_docs_chinese_pagination():
    load_docs_corpus.cache_clear()
    ctx = search_docs("分页 offset limit 怎么用")
    assert "【pagination】" in ctx
    assert "offset" in ctx.lower()


def test_search_docs_versioning_and_count_tokens():
    load_docs_corpus.cache_clear()
    ver = search_docs("模型ID@版本号 弃用 410")
    assert "【versioning】" in ver
    tok = search_docs("count_tokens 预估输入 Token 不计费")
    assert "【count-tokens】" in tok or "count_tokens" in tok


def test_search_docs_rate_tiers_numbers():
    load_docs_corpus.cache_clear()
    ctx = search_docs("高并发 RPM TPM 限流档位")
    assert "【rate-limits】" in ctx
    assert "3,000" in ctx or "3000" in ctx.replace(",", "")


def test_corpus_section_ids_nonempty():
    load_docs_corpus.cache_clear()
    ids = corpus_section_ids()
    assert "introduction" in ids
    assert len(ids) >= len(_REQUIRED_SECTIONS)
