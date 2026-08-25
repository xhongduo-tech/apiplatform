import { useState, useEffect } from "react";
import { Copy, Check } from "lucide-react";
import { toast } from "sonner";

import { useT } from "../i18n";

export type CodeLang = "python" | "bash" | "javascript" | "text";

// VS Code Dark+ color palette mapped to the platform code-editor tokens
const DARK = {
  bg: "var(--code-editor-bg)",
  header: "var(--code-editor-bar)",
  border: "var(--code-editor-border)",
  lineNum: "var(--code-editor-linenum)",
  comment: "var(--code-editor-comment)",
  string: "var(--code-editor-string)",
  keyword: "var(--code-editor-keyword)",
  number: "var(--code-editor-number)",
  builtin: "var(--code-editor-builtin)",
  func: "var(--code-editor-func)",
  decorator: "var(--code-editor-decorator)",
  url: "var(--code-editor-url)",
  operator: "var(--code-editor-operator)",
  plain: "var(--code-editor-plain)",
  type: "var(--code-editor-builtin)",
  copy: "var(--code-editor-copy)",
  copyActive: "var(--code-editor-copy-active)",
  flash: "var(--code-editor-flash)",
  flashBg: "var(--code-editor-flash-bg)",
} as const;

// GitHub / Prism light palette mapped to the platform code-editor-light tokens
const LIGHT = {
  bg: "var(--code-editor-light-bg)",
  header: "var(--code-editor-light-bar)",
  border: "var(--code-editor-light-border)",
  lineNum: "var(--code-editor-light-linenum)",
  comment: "var(--code-editor-light-comment)",
  string: "var(--code-editor-light-string)",
  keyword: "var(--code-editor-light-keyword)",
  number: "var(--code-editor-light-number)",
  builtin: "var(--code-editor-light-builtin)",
  func: "var(--code-editor-light-func)",
  decorator: "var(--code-editor-light-decorator)",
  url: "var(--code-editor-light-url)",
  operator: "var(--code-editor-light-operator)",
  plain: "var(--code-editor-light-plain)",
  type: "var(--code-editor-light-decorator)",
  copy: "var(--code-editor-light-copy)",
  copyActive: "var(--code-editor-light-copy-active)",
  flash: "var(--code-editor-light-flash)",
  flashBg: "var(--code-editor-light-flash-bg)",
} as const;

type Theme = "dark" | "light";

type TokenRule = [string, string]; // [regex source, color]

function getRules(theme: Theme): Record<CodeLang, TokenRule[]> {
  const C = theme === "light" ? LIGHT : DARK;
  return {
  python: [
    ['#[^\\n]*', C.comment],
    ['"""[\\s\\S]*?"""|\'\'\'[\\s\\S]*?\'\'\'', C.string],
    ['f?"(?:[^"\\\\]|\\\\.)*"|f?\'(?:[^\'\\\\]|\\\\.)*\'', C.string],
    ['@\\w+', C.decorator],
    ['\\b(?:from|import|def|class|return|if|elif|else|for|while|try|except|finally|with|as|not|and|or|in|is|True|False|None|await|async|pass|break|continue|raise|lambda|yield)\\b', C.keyword],
    ['\\b(?:print|len|range|str|int|float|list|dict|set|tuple|open|type|isinstance|super|self|OpenAI|base64|json|requests|stream|chunk|delta|response|message|tool_calls?|arguments|client|tools)\\b', C.builtin],
    ['\\b\\d+\\.?\\d*\\b', C.number],
    ['\\b\\w+(?=\\s*\\()', C.func],
  ],
  bash: [
    ['"(?:[^"\\\\]|\\\\.)*"|\'(?:[^\'\\\\]|\\\\.)*\'', C.string],
    ['https?:\\/\\/[^\\s"\'\\\\,}]+', C.url],
    ['\\b(?:curl|POST|GET|PUT|DELETE|PATCH)\\b', C.keyword],
    ['-[a-zA-Z]\\b|--[\\w-]+', C.keyword],
    ['\\\\$', C.operator],
    ['\\b\\d+\\b', C.number],
  ],
  javascript: [
    ['\\/\\/[^\\n]*', C.comment],
    ['`(?:[^`\\\\]|\\\\.)*`', C.string],
    ['"(?:[^"\\\\]|\\\\.)*"|\'(?:[^\'\\\\]|\\\\.)*\'', C.string],
    ['\\b(?:import|export|from|const|let|var|function|return|if|else|for|while|try|catch|finally|class|new|await|async|of|in|true|false|null|undefined|throw|this)\\b', C.keyword],
    ['\\b(?:OpenAI|console|process|Buffer|fetch|JSON|Math|Object|Array|Promise|Error)\\b', C.builtin],
    ['\\b\\d+\\.?\\d*\\b', C.number],
    ['\\b\\w+(?=\\s*\\()', C.func],
  ],
  text: [],
  };
}

interface Tok { text: string; color: string }

function tokenize(code: string, lang: CodeLang, theme: Theme): Tok[] {
  const rules = getRules(theme)[lang];
  const marked = new Uint8Array(code.length);
  const tokens: { start: number; end: number; color: string }[] = [];

  for (const [src, color] of rules) {
    const re = new RegExp(src, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(code)) !== null) {
      const s = m.index, e = s + m[0].length;
      let overlaps = false;
      for (let i = s; i < e; i++) {
        if (marked[i]) { overlaps = true; break; }
      }
      if (!overlaps) {
        tokens.push({ start: s, end: e, color });
        for (let i = s; i < e; i++) marked[i] = 1;
      }
    }
  }

  tokens.sort((a, b) => a.start - b.start);

  const result: Tok[] = [];
  let pos = 0;
  const C = theme === "light" ? LIGHT : DARK;
  for (const tok of tokens) {
    if (tok.start > pos) result.push({ text: code.slice(pos, tok.start), color: C.plain });
    result.push({ text: code.slice(tok.start, tok.end), color: tok.color });
    pos = tok.end;
  }
  if (pos < code.length) result.push({ text: code.slice(pos), color: C.plain });

  return result;
}

interface CodeBlockProps {
  code: string;
  lang: CodeLang;
  label?: string;
  maxHeight?: number;
  variant?: Theme;
  /** Optional cue: when this string changes, the block briefly flashes an amber
   *  background to signal the code was just updated by an upstream input. */
  pulseKey?: string;
}

export function CodeBlock({ code, lang, label, maxHeight, variant = "dark", pulseKey }: CodeBlockProps) {
  const { t } = useT();
  const [copied, setCopied] = useState(false);
  const [pulse, setPulse] = useState(false);
  const C = variant === "light" ? LIGHT : DARK;
  const toks = tokenize(code, lang, variant);
  const lineCount = (code.match(/\n/g) || []).length + 1;

  // Trigger a one-shot ring pulse (outer glow) + "已更新" pill whenever
  // pulseKey changes. The class is removed after the longer of the two
  // animations completes (~1.4s for the pill) so both finish cleanly.
  useEffect(() => {
    if (!pulseKey) return;
    setPulse(true);
    const t = setTimeout(() => setPulse(false), 1400);
    return () => clearTimeout(t);
  }, [pulseKey]);

  const handleCopy = () => {
    const copy = (text: string) => {
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text).catch(() => fallback(text));
      } else {
        fallback(text);
      }
    };
    const fallback = (text: string) => {
      const el = document.createElement("textarea");
      el.value = text;
      el.style.cssText = "position:fixed;left:-9999px;top:-9999px;opacity:0";
      document.body.appendChild(el);
      el.focus();
      el.select();
      try { document.execCommand("copy"); } catch { /* silent */ }
      document.body.removeChild(el);
    };
    copy(code);
    setCopied(true);
    toast.success(t("codeBlock.copied"));
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div
      className={`rounded-xl overflow-hidden ${pulse ? "linked-pulse" : ""}`}
      style={{ backgroundColor: C.bg, border: `1px solid ${C.border}` }}
    >
      {/* Titlebar */}
      <div
        className="flex items-center justify-between px-4 py-2.5"
        style={{ backgroundColor: C.header, borderBottom: `1px solid ${C.border}` }}
      >
        <div className="flex items-center gap-3">
          {/* Traffic lights */}
          <div className="flex gap-1.5">
            <div className="w-3 h-3 rounded-full" style={{ backgroundColor: "var(--code-editor-traffic-red)" }} />
            <div className="w-3 h-3 rounded-full" style={{ backgroundColor: "var(--code-editor-traffic-yellow)" }} />
            <div className="w-3 h-3 rounded-full" style={{ backgroundColor: "var(--code-editor-traffic-green)" }} />
          </div>
          {label && (
            <span className="text-[11px]" style={{ color: C.copy, fontFamily: "var(--font-mono)" }}>
              {label}
            </span>
          )}
          {pulse && (
            <span
              key={pulseKey /* force re-trigger of CSS animation on every change */}
              className="flash-tag flex items-center gap-1"
              style={{
                fontSize: "10px",
                color: C.flash,
                backgroundColor: C.flashBg,
                padding: "1px 7px",
                borderRadius: "9999px",
                fontFamily: "var(--font-sans)",
              }}
            >
              <span style={{
                display: "inline-block", width: 5, height: 5, borderRadius: "50%",
                backgroundColor: C.flash,
              }} />
              {t("codeBlock.updated")}
            </span>
          )}
        </div>
        <button
          onClick={handleCopy}
          className="btn-tap flex items-center gap-1.5 transition-colors"
          style={{ color: copied ? C.copyActive : C.copy, fontSize: "11px", background: "none", border: "none", cursor: "pointer", padding: "2px 4px", borderRadius: "4px" }}
        >
          {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
          {copied ? t("codeBlock.copied") : t("codeBlock.copy")}
        </button>
      </div>

      {/* Code area */}
      <div
        className="overflow-auto"
        style={{ maxHeight: maxHeight ? `${maxHeight}px` : undefined, scrollbarWidth: "thin" }}
      >
        <div className="flex min-w-fit">
          {/* Line numbers */}
          <div
            className="select-none py-4 pr-4 pl-4 text-right shrink-0"
            style={{
              color: C.lineNum,
              fontFamily: "var(--font-mono)",
              fontSize: "12.5px",
              lineHeight: "1.8",
              minWidth: "44px",
              borderRight: `1px solid ${C.border}`,
            }}
          >
            {Array.from({ length: lineCount }, (_, i) => (
              <div key={i}>{i + 1}</div>
            ))}
          </div>

          {/* Highlighted code */}
          <pre
            className="py-4 px-5 flex-1"
            style={{ fontSize: "12.5px", lineHeight: "1.8", margin: 0 }}
          >
            {toks.map((tok, i) => (
              <span key={i} style={{ color: tok.color }}>
                {tok.text}
              </span>
            ))}
          </pre>
        </div>
      </div>
    </div>
  );
}
