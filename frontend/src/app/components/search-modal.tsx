import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { Search, CornerDownLeft, FileText, Boxes, KeyRound, BarChart3, ScrollText, MessageSquare, Activity, BookOpen, Sparkles, Send, X } from "lucide-react";
import { isDocsPath } from "./NewTabLink";
import { useT, type TranslationKey } from "../i18n";
import { useAuth } from "../hooks/use-auth";
import { createAbortController } from "../browser-compat";
import { buildTocItems } from "./docs/docs-shared";
import { SECTION_CONTENT_KEYS } from "./docs/docs-search-data";
import { API_BASE } from "../config";
import { usePlatformConfig } from "../hooks/use-platform-config";
import { useModalFocus } from "../accessibility";
import { COOKIE_SESSION_TOKEN } from "../api/gateway";

/* ═══════════════════════════════════════════════════════════════════════════
   全局搜索(⌘K)— platform.claude.com "Ask AI" 式面板
   两个视图:Ask Docs(问候 + 示例问题 + 底部输入行,默认)/ Search(检索态);
   示例问题与提问提交都会切到检索态,答案 = 动态索引(接口文档全文 + 平台页面)中最相关的文档/功能入口。
   键盘:↑↓ 选择、Enter 打开、Esc 关闭;文档地址新标签打开,其余结果在当前页 SPA 导航。
 ═══════════════════════════════════════════════════════════════════════════ */

interface SearchEntry {
  title: string;
  desc: string;
  group: string;
  href: string;
  keywords: string;
  icon: typeof FileText;
  content?: string;
}

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

/** Ask Docs 示例问题:label 为展示文案 key,query 为切到检索态后实际执行的关键词 */
const EXAMPLE_QUESTIONS: { labelKey: TranslationKey; query: string }[] = [
  { labelKey: "searchModal.example.apiKey", query: "api key" },
  { labelKey: "searchModal.example.firstCall", query: "openai" },
  { labelKey: "searchModal.example.agentToolchain", query: "agent" },
];

function usePlatformEntries(t: (k: TranslationKey) => string): SearchEntry[] {
  return useMemo(() => [
    { title: t("header.models"), desc: t("searchModal.entry.models.desc"), group: t("docsPage.nav.console"), href: "/models", keywords: "models 模型 广场 chat reasoning embedding", icon: Boxes },
    { title: t("header.keys"), desc: t("searchModal.entry.keys.desc"), group: t("docsPage.nav.console"), href: "/keys", keywords: "key 密钥 凭证 申请 token", icon: KeyRound },
    { title: t("header.usage"), desc: t("searchModal.entry.usage.desc"), group: t("docsPage.nav.console"), href: "/usage", keywords: "usage 用量 统计 token 消耗", icon: BarChart3 },
    { title: t("header.logs"), desc: t("searchModal.entry.logs.desc"), group: t("docsPage.nav.console"), href: "/logs", keywords: "logs 日志 请求 排查 错误", icon: ScrollText },
    { title: t("header.feedback"), desc: t("searchModal.entry.feedback.desc"), group: t("docsPage.nav.console"), href: "/forum", keywords: "forum 反馈 讨论 问题", icon: MessageSquare },
    { title: t("footer.status"), desc: t("searchModal.entry.status.desc"), group: t("searchModal.group.platform"), href: "/status", keywords: "status 状态 可用性 监控", icon: Activity },
  ], [t]);
}

function matchEntries(q: string, index: SearchEntry[]): SearchEntry[] {
  const query = q.trim().toLowerCase();
  if (!query) return index;
  return index.filter((e) =>
    (e.title + " " + e.desc + " " + e.keywords + " " + (e.content ?? "")).toLowerCase().includes(query),
  );
}

export function SearchModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [mode, setMode] = useState<"ask" | "search">("ask");
  const [query, setQuery] = useState("");
  const [askDraft, setAskDraft] = useState("");
  const [cursor, setCursor] = useState(0);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const askInputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);

  const { t } = useT();
  const { token } = useAuth();
  const { branding } = usePlatformConfig();

  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatLoading, setChatLoading] = useState(false);
  const [inChat, setInChat] = useState(false);
  // 防止同面板双点示例/连发提问时两路流交错改写最后一条 assistant
  const askGenRef = useRef(0);
  const askAbortRef = useRef<AbortController | null>(null);

  // 拖拽
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const dragging = useRef(false);
  const dragStart = useRef({ x: 0, y: 0 });
  const panelRef = useRef<HTMLDivElement>(null);
  useModalFocus({
    open,
    containerRef: panelRef,
    onClose,
    initialFocusRef: askInputRef,
  });

  const onDragStart = useCallback((e: React.MouseEvent) => {
    // 只允许从 topbar 拖拽
    if (!(e.target as HTMLElement).closest(".search-modal__topbar")) return;
    dragging.current = true;
    dragStart.current = { x: e.clientX - dragOffset.x, y: e.clientY - dragOffset.y };
    e.preventDefault();
  }, [dragOffset]);

  const onDragMove = useCallback((e: MouseEvent) => {
    if (!dragging.current) return;
    setDragOffset({
      x: e.clientX - dragStart.current.x,
      y: e.clientY - dragStart.current.y,
    });
  }, []);

  const onDragEnd = useCallback(() => {
    dragging.current = false;
  }, []);

  useEffect(() => {
    window.addEventListener("mousemove", onDragMove);
    window.addEventListener("mouseup", onDragEnd);
    return () => {
      window.removeEventListener("mousemove", onDragMove);
      window.removeEventListener("mouseup", onDragEnd);
    };
  }, [onDragMove, onDragEnd]);

  const platformEntries = usePlatformEntries(t as (k: TranslationKey) => string);

  const searchIndex = useMemo((): SearchEntry[] => {
    const tocItems = buildTocItems(t as (k: TranslationKey) => string);
    const docsGroup = t("header.docs");
    const docsEntries: SearchEntry[] = tocItems
      .filter(item => item.level === 2)
      .map(item => {
        const keys = SECTION_CONTENT_KEYS[item.id] ?? [];
        const content = keys.map(k => {
          try { return String(t(k)); } catch { return ""; }
        }).join(" ");
        const isIntro = item.id === "introduction";
        return {
          title: item.label,
          desc: content.slice(0, 80) + (content.length > 80 ? "…" : ""),
          group: docsGroup,
          href: `/docs?section=${item.id}`,
          keywords: item.id.replace(/-/g, " "),
          icon: isIntro ? BookOpen : FileText,
          content,
        };
      });

    return [...docsEntries, ...platformEntries];
  }, [t, platformEntries]);

  const results = useMemo(() => matchEntries(query, searchIndex), [query, searchIndex]);

  useEffect(() => {
    if (open) {
      askAbortRef.current?.abort();
      askAbortRef.current = null;
      askGenRef.current += 1;
      setMode("ask");
      setQuery("");
      setAskDraft("");
      setCursor(0);
      setChatMessages([]);
      setChatLoading(false);
      setInChat(false);
      setDragOffset({ x: 0, y: 0 });
      // 等 portal 挂载后聚焦
      window.setTimeout(() => askInputRef.current?.focus(), 0);
    } else {
      askAbortRef.current?.abort();
      askAbortRef.current = null;
      askGenRef.current += 1;
    }
  }, [open]);

  useEffect(() => { setCursor(0); }, [query]);

  // 切换视图后把焦点移到对应输入框
  useEffect(() => {
    if (!open) return;
    window.setTimeout(() => {
      (mode === "search" ? searchInputRef : askInputRef).current?.focus();
    }, 0);
  }, [mode, open]);

  const navigate = useNavigate();

  const openEntry = useCallback((entry: SearchEntry) => {
    onClose();
    const href = entry.href;
    if (isDocsPath(href)) {
      window.open(href, "_blank", "noopener,noreferrer");
      return;
    }
    // 其余内部结果在当前页 SPA 导航，不新开标签页
    navigate(href);
  }, [onClose, navigate]);

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    if (mode !== "search") return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor((c) => Math.min(c + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => Math.max(c - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (results[cursor]) openEntry(results[cursor]);
    }
  }, [mode, results, cursor, openEntry, onClose]);

  // 示例问题/提问提交 → 调用 Ask Docs API 进行 AI 问答
  const askSearch = useCallback(async (q: string) => {
    const trimmed = q.trim();
    if (!trimmed || chatLoading) return;

    askAbortRef.current?.abort();
    const ac = createAbortController();
    askAbortRef.current = ac;
    const gen = ++askGenRef.current;

    setInChat(true);
    setAskDraft("");
    const userMsg: ChatMessage = { role: "user", content: trimmed };
    setChatMessages((prev) => [...prev, userMsg]);
    setChatLoading(true);

    const stillCurrent = () => askGenRef.current === gen && !ac?.signal.aborted;

    try {
      // Ask Docs 现在要求登录（防止匿名无限制驱动上游 LLM 调用）；未登录时
      // 不带 token 直接打 401，下面走已有的关键词搜索降级，不额外处理。
      const askHeaders: Record<string, string> = { "Content-Type": "application/json" };
      if (token && token !== COOKIE_SESSION_TOKEN) {
        askHeaders["Authorization"] = `Bearer ${token}`;
      }

      // 尝试调用 Ask Docs 流式接口
      const res = await fetch(`${API_BASE}/api/ask-docs/stream`, {
        method: "POST",
        credentials: "same-origin",
        headers: askHeaders,
        body: JSON.stringify({ question: trimmed }),
        signal: ac?.signal,
      });

      if (!stillCurrent()) return;

      if (res.ok) {
        // 流式读取
        let assistantContent = "";
        setChatMessages((prev) => [...prev, { role: "assistant", content: "" }]);
        const reader = res.body?.getReader();
        if (!reader) throw new Error("No reader");
        const decoder = new TextDecoder();
        let buffer = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!stillCurrent()) {
            reader.cancel().catch(() => {});
            return;
          }
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";
          for (const line of lines) {
            if (line.startsWith("data: ")) {
              const data = line.slice(6);
              if (data === "[DONE]") break;
              try {
                const parsed = JSON.parse(data);
                const delta = parsed.choices?.[0]?.delta?.content || "";
                assistantContent += delta;
                if (!stillCurrent()) return;
                setChatMessages((prev) => {
                  const copy = [...prev];
                  const last = copy[copy.length - 1];
                  if (last && last.role === "assistant") {
                    copy[copy.length - 1] = { ...last, content: assistantContent };
                  }
                  return copy;
                });
              } catch {
                // 非 JSON 行，忽略
              }
            }
          }
        }
      } else {
        // 降级到非流式
        const nonStreamRes = await fetch(`${API_BASE}/api/ask-docs`, {
          method: "POST",
          headers: askHeaders,
          body: JSON.stringify({ question: trimmed }),
          signal: ac?.signal,
        });
        if (!stillCurrent()) return;
        if (nonStreamRes.ok) {
          const data = await nonStreamRes.json();
          if (!stillCurrent()) return;
          setChatMessages((prev) => [
            ...prev,
            { role: "assistant", content: data.answer + "\n\n> " + t("searchModal.fallback.nonStream") },
          ]);
        } else {
          throw new Error("Ask Docs unavailable");
        }
      }
    } catch {
      if (ac?.signal.aborted || !stillCurrent()) return;
      // 降级：回退到关键词搜索模式
      setChatMessages((prev) => [
        ...prev,
        { role: "assistant", content: t("searchModal.fallback.unavailable") },
      ]);
    } finally {
      if (askGenRef.current === gen) {
        setChatLoading(false);
        if (askAbortRef.current === ac) askAbortRef.current = null;
      }
    }
  }, [t, token, chatLoading]);

  // 光标变化时保持可见
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${cursor}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  // 聊天消息变化时自动滚动到底部
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatMessages]);

  if (!open) return null;

  // 分组渲染
  const groups: { name: string; items: { entry: SearchEntry; idx: number }[] }[] = [];
  results.forEach((entry, idx) => {
    const g = groups.find((x) => x.name === entry.group);
    if (g) g.items.push({ entry, idx });
    else groups.push({ name: entry.group, items: [{ entry, idx }] });
  });

  return createPortal(
    <div className="search-modal" role="dialog" aria-modal="true" aria-label={t("searchModal.ariaLabel")}>
      <button type="button" className="search-modal__backdrop" aria-label={t("searchModal.closeAriaLabel")} onClick={onClose} />
      <div
        className="search-modal__panel"
        ref={panelRef}
        onMouseDown={onDragStart}
        onKeyDown={onKeyDown}
        style={{ transform: `translate(${dragOffset.x}px, ${dragOffset.y}px)` }}
      >
        <div className="search-modal__topbar">
          <button type="button" className="search-modal__close" aria-label={t("searchModal.closeAriaLabel")} onClick={onClose}>
            <X size={16} />
          </button>
          <div className="search-modal__tabs" role="tablist" aria-label={t("searchModal.tabsAriaLabel")}>
            <button
              type="button"
              role="tab"
              aria-selected={mode === "search"}
              className={`search-modal__tab${mode === "search" ? " search-modal__tab--active" : ""}`}
              onClick={() => setMode("search")}
            >
              <Search size={14} aria-hidden />
              {t("searchModal.tab.search")}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === "ask"}
              className={`search-modal__tab${mode === "ask" ? " search-modal__tab--active" : ""}`}
              onClick={() => setMode("ask")}
            >
              <Sparkles size={14} aria-hidden />
              {t("admin.nav.askDocs")}
            </button>
          </div>
        </div>

        {mode === "search" ? (
          <>
            <div className="search-modal__head">
              <Search size={16} className="search-modal__head-icon" />
              <input
                ref={searchInputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t("searchModal.searchPlaceholder")}
                className="search-modal__input"
                aria-label={t("searchModal.tab.search")}
              />
              <kbd className="search-modal__esc">Esc</kbd>
            </div>
            <div className="search-modal__list" ref={listRef}>
              {groups.length === 0 && (
                <p className="search-modal__empty">{t("searchModal.noResults", { query })}</p>
              )}
              {groups.map((g) => (
                <div key={g.name}>
                  <p className="search-modal__group">{g.name}</p>
                  {g.items.map(({ entry, idx }) => (
                    <button
                      key={entry.group + entry.title}
                      type="button"
                      data-idx={idx}
                      className={`search-modal__item${idx === cursor ? " search-modal__item--active" : ""}`}
                      onMouseEnter={() => setCursor(idx)}
                      onClick={() => openEntry(entry)}
                    >
                      <entry.icon size={15} className="search-modal__item-icon" />
                      <span className="search-modal__item-main">
                        <span className="search-modal__item-title">{entry.title}</span>
                        <span className="search-modal__item-desc">{entry.desc}</span>
                      </span>
                      {idx === cursor && <CornerDownLeft size={13} className="search-modal__item-enter" />}
                    </button>
                  ))}
                </div>
              ))}
            </div>
            <div className="search-modal__foot">
              <span><kbd>↑</kbd><kbd>↓</kbd> {t("searchModal.footer.switch")}</span>
              <span><kbd>Enter</kbd> {t("searchModal.footer.open")}</span>
              <span><kbd>Esc</kbd> {t("searchModal.footer.close")}</span>
            </div>
          </>
        ) : inChat ? (
          <>
            {/* Chat view */}
            <div className="search-modal__chat">
              {chatMessages.map((msg, i) => (
                <div
                  key={i}
                  className={`search-modal__chat-msg ${msg.role === "user" ? "search-modal__chat-msg--user" : "search-modal__chat-msg--ai"}`}
                >
                  <div className="search-modal__chat-bubble">
                    {msg.content || (msg.role === "assistant" && chatLoading && i === chatMessages.length - 1 ? t("searchModal.chatThinking") : "")}
                  </div>
                </div>
              ))}
              {chatLoading && (!chatMessages.length || chatMessages[chatMessages.length - 1].role === "user") && (
                <div className="search-modal__chat-msg search-modal__chat-msg--ai">
                  <div className="search-modal__chat-bubble">
                    <span className="search-modal__chat-dots">
                      <span>.</span><span>.</span><span>.</span>
                    </span>
                  </div>
                </div>
              )}
              <div ref={chatEndRef} />
            </div>
            <form
              className="search-modal__ask-inputrow"
              onSubmit={(e) => { e.preventDefault(); askSearch(askDraft); }}
            >
              <input
                ref={askInputRef}
                value={askDraft}
                onChange={(e) => setAskDraft(e.target.value)}
                placeholder={t("searchModal.continueAskPlaceholder")}
                className="search-modal__ask-input"
                aria-label={t("searchModal.askInputAriaLabel")}
                disabled={chatLoading}
              />
              <button type="submit" className="search-modal__ask-send" aria-label={t("searchModal.askSubmitAriaLabel")} disabled={chatLoading}>
                <Send size={18} aria-hidden />
              </button>
            </form>
          </>
        ) : (
          <>
            {/* Greeting view */}
            <div className="search-modal__ask">
              <div className="search-modal__ask-greeting">
                <BookOpen size={34} strokeWidth={2} className="search-modal__ask-book" aria-hidden />
                <div className="search-modal__ask-text">
                  <p>{t("searchModal.greeting.hello")}</p>
                  <p>{t("searchModal.greeting.line1")}</p>
                  <p>{t("searchModal.greeting.before")} <span className="search-modal__ask-chip">{branding.brand}</span>{t("searchModal.greeting.after")}</p>
                </div>
              </div>
              <p className="search-modal__ask-eyebrow">{t("searchModal.exampleQuestionsEyebrow")}</p>
              <div className="search-modal__ask-examples">
                {EXAMPLE_QUESTIONS.map((ex) => (
                  <button
                    key={ex.labelKey}
                    type="button"
                    className="search-modal__ask-example"
                    onClick={() => askSearch(t(ex.labelKey))}
                    disabled={chatLoading}
                  >
                    {t(ex.labelKey)}
                  </button>
                ))}
              </div>
            </div>
            <form
              className="search-modal__ask-inputrow"
              onSubmit={(e) => { e.preventDefault(); askSearch(askDraft); }}
            >
              <input
                ref={askInputRef}
                value={askDraft}
                onChange={(e) => setAskDraft(e.target.value)}
                placeholder={t("searchModal.askPlaceholder")}
                className="search-modal__ask-input"
                aria-label={t("searchModal.askInputAriaLabel")}
                disabled={chatLoading}
              />
              <button type="submit" className="search-modal__ask-send" aria-label={t("searchModal.askSubmitAriaLabel")} disabled={chatLoading}>
                <Send size={18} aria-hidden />
              </button>
            </form>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}

/** 供任意组件(如首页 hero 搜索框)请求打开全局搜索 */
const SEARCH_OPEN_EVENT = "apiplatform-search-open";
export function openGlobalSearch() {
  window.dispatchEvent(new CustomEvent(SEARCH_OPEN_EVENT));
}

/** 全局 ⌘K / Ctrl+K 快捷键 + openGlobalSearch 事件，返回 [open, setOpen] */
export function useSearchHotkey(): [boolean, (v: boolean) => void] {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener(SEARCH_OPEN_EVENT, onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(SEARCH_OPEN_EVENT, onOpen);
    };
  }, []);
  return [open, setOpen];
}
