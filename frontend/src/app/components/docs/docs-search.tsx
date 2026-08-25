import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { Search } from "lucide-react";

import { useT } from "../../i18n";

interface SearchItem {
  id: string;
  label: string;
  content: string;
}

interface Props {
  items: SearchItem[];
  onSelect: (id: string) => void;
  onClose: () => void;
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, "");
}

function findSnippet(text: string, query: string, len = 80): string {
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return text.slice(0, len);
  const start = Math.max(0, idx - 30);
  const end = Math.min(text.length, idx + query.length + len);
  let snippet = text.slice(start, end);
  if (start > 0) snippet = "…" + snippet;
  if (end < text.length) snippet = snippet + "…";
  return snippet;
}

export function DocsSearchModal({ items, onSelect, onClose }: Props) {
  const { t } = useT();
  const [query, setQuery] = useState("");
  const [selectedIdx, setSelectedIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return items
      .map((item) => {
        const plainText = stripHtml(item.content);
        const matchLabel = item.label.toLowerCase().includes(q);
        const matchContent = plainText.toLowerCase().includes(q);
        if (!matchLabel && !matchContent) return null;
        const score = matchLabel ? 2 : 1;
        return { ...item, plainText, snippet: findSnippet(plainText, q), score };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
      .sort((a, b) => b.score - a.score);
  }, [items, query]);

  useEffect(() => {
    setSelectedIdx(0);
  }, [query]);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIdx((prev) => Math.min(prev + 1, results.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIdx((prev) => Math.max(prev - 1, 0));
      } else if (e.key === "Enter" && results[selectedIdx]) {
        e.preventDefault();
        onSelect(results[selectedIdx].id);
        onClose();
      } else if (e.key === "Tab") {
        // 焦点陷阱：让 Tab 只在弹窗内循环
        const focusables = panelRef.current?.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input, [tabindex]:not([tabindex="-1"])',
        );
        if (!focusables || focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose, onSelect, results, selectedIdx]);

  // 打开时聚焦输入框，关闭时把焦点还给此前的触发元素
  useEffect(() => {
    const prevFocused = document.activeElement as HTMLElement | null;
    inputRef.current?.focus();
    return () => prevFocused?.focus?.();
  }, []);

  // 键盘选中项自动滚入可视区
  useEffect(() => {
    const el = listRef.current?.children[selectedIdx] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [selectedIdx]);

  const handleSelect = useCallback(
    (id: string) => {
      onSelect(id);
      onClose();
    },
    [onSelect, onClose],
  );

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-start justify-center bg-ink/30 pt-[15vh] px-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("docsPage.search.placeholder")}
        className="w-full max-w-lg overflow-hidden rounded-2xl border border-border bg-card shadow-pop"
      >
        <div className="flex items-center gap-3 border-b border-border px-4 py-3">
          <Search size={15} className="text-fg-subtle shrink-0" />
          <input
            ref={inputRef}
            type="text"
            className="flex-1 border-none bg-transparent text-[14px] text-foreground outline-none placeholder:text-fg-subtle"
            placeholder={t("docsPage.search.placeholder")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <kbd className="text-[10px] text-fg-subtle bg-secondary px-1.5 py-0.5 rounded font-mono">ESC</kbd>
        </div>

        <div ref={listRef} className="max-h-[400px] overflow-y-auto py-2">
          {query.trim() && results.length === 0 && (
            <p className="px-4 py-6 text-center text-[13px] text-fg-muted">
              {t("docsPage.search.noResults")}
            </p>
          )}
          {!query.trim() && (
            <p className="px-4 py-6 text-center text-[13px] text-fg-muted">
              {t("docsPage.search.emptyHint")}
            </p>
          )}
          {results.map((item, i) => (
            <button
              key={item.id}
              onClick={() => handleSelect(item.id)}
              className={`w-full text-left px-4 py-3 transition-colors cursor-pointer border-none bg-transparent font-sans ${
                i === selectedIdx
                  ? "bg-brand-soft text-brand-hover"
                  : "text-fg-muted hover:bg-bg-soft hover:text-fg"
              }`}
            >
              <p className="font-serif text-[13px] font-medium text-foreground">{item.label}</p>
              {item.snippet && (
                <p className="mt-0.5 text-[12px] leading-relaxed text-fg-subtle line-clamp-2">
                  {item.snippet}
                </p>
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
