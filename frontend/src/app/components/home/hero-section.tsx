import * as React from "react";
import { useState } from "react";
import type { PlatformConfig } from "../../api/gateway";
import { Play, Braces, Copy, Check, Search, TrendingUp } from "lucide-react";
import { NewTabLink } from "../NewTabLink";
import { openGlobalSearch } from "../search-modal";
import { publicApiOrigin } from "../../api/public-api-origin";

import { useT } from "../../i18n";
import { SafeHtml } from "../../safe-html";
import { copyText } from "../../browser-compat";

/* ═══════════════════════════════════════════════════════════════════════════
   HERO — platform.claude.com/docs 首屏同构
   左:eyebrow + 衬线大标题 + 衬线副标题 + 搜索框(⌘K)+ 快捷入口
   右:白底代码卡，语言 tab 切换,GitHub-light 语法配色
═══════════════════════════════════════════════════════════════════════════ */

const BASE_URL = publicApiOrigin();

type Seg = [string, string];
type CodeLines = Seg[][];

const PY_CODE: CodeLines = [
  [["kw", "from"], ["plain", " openai "], ["kw", "import"], ["plain", " OpenAI"]],
  [],
  [["plain", "client = OpenAI("]],
  [["plain", "    "], ["prop", "base_url"], ["plain", "="], ["str", `"${BASE_URL}/v1"`], ["plain", ","]],
  [["plain", "    "], ["prop", "api_key"], ["plain", "="], ["str", '"YOUR_API_KEY"'], ["plain", ","]],
  [["plain", ")"]],
  [],
  [["plain", "response = client.chat.completions."], ["fn", "create"], ["plain", "("]],
  [["plain", "    "], ["prop", "model"], ["plain", "="], ["str", '"platform-flash"'], ["plain", ","]],
  [["plain", "    "], ["prop", "messages"], ["plain", "=[{"], ["str", '"role"'], ["plain", ": "], ["str", '"user"'], ["plain", ", "], ["str", '"content"'], ["plain", ": "], ["str", '"你好"'], ["plain", "}],"]],
  [["plain", ")"]],
  [["fn", "print"], ["plain", "(response.choices["], ["num", "0"], ["plain", "].message.content)"]],
];

const TS_CODE: CodeLines = [
  [["kw", "import"], ["plain", " OpenAI "], ["kw", "from"], ["plain", " "], ["str", '"openai"'], ["plain", ";"]],
  [],
  [["kw", "const"], ["plain", " client = "], ["kw", "new"], ["plain", " "], ["fn", "OpenAI"], ["plain", "({"]],
  [["plain", "  "], ["prop", "baseURL"], ["plain", ": "], ["str", `"${BASE_URL}/v1"`], ["plain", ","]],
  [["plain", "  "], ["prop", "apiKey"], ["plain", ": process.env.PLATFORM_API_KEY,"]],
  [["plain", "});"]],
  [],
  [["kw", "const"], ["plain", " response = "], ["kw", "await"], ["plain", " client.chat.completions."], ["fn", "create"], ["plain", "({"]],
  [["plain", "  "], ["prop", "model"], ["plain", ": "], ["str", '"platform-flash"'], ["plain", ","]],
  [["plain", "  "], ["prop", "messages"], ["plain", ": [{ "], ["prop", "role"], ["plain", ": "], ["str", '"user"'], ["plain", ", "], ["prop", "content"], ["plain", ": "], ["str", '"你好"'], ["plain", " }],"]],
  [["plain", "});"]],
  [["plain", "console."], ["fn", "log"], ["plain", "(response.choices["], ["num", "0"], ["plain", "].message.content);"]],
];

const CURL_CODE: CodeLines = [
  [["fn", "curl"], ["plain", ` -X POST ${BASE_URL}/v1/chat/completions \\`]],
  [["plain", "  -H "], ["str", '"Authorization: Bearer YOUR_API_KEY"'], ["plain", " \\"]],
  [["plain", "  -H "], ["str", '"Content-Type: application/json"'], ["plain", " \\"]],
  [["plain", "  -d "], ["str", "'{"]],
  [["str", '    "model": "platform-flash",']],
  [["str", '    "messages": [{"role": "user", "content": "你好"}]']],
  [["str", "  }'"]],
];

const PHP_CODE: CodeLines = [
  [["kw", "<?php"] as Seg],
  [[] as Seg[]],
  [["plain", "$ch = "], ["fn", "curl_init"], ["plain", "("], ["str", `"${BASE_URL}/v1/chat/completions"`], ["plain", ");"] as Seg],
  [["fn", "curl_setopt_array"], ["plain", "($ch, "], ["kw", "array"], ["plain", "("] as Seg],
  [["plain", "    CURLOPT_POST "], ["kw", "=>"], ["plain", " "], ["kw", "true"], ["plain", ","] as Seg],
  [["plain", "    CURLOPT_HTTPHEADER "], ["kw", "=>"], ["plain", " "], ["kw", "array"], ["plain", "("] as Seg],
  [["plain", "        "], ["str", "'Authorization: Bearer YOUR_API_KEY'"], ["plain", ","] as Seg],
  [["plain", "        "], ["str", "'Content-Type: application/json'"], ["plain", ","] as Seg],
  [["plain", "    ),"] as Seg],
  [["plain", "    CURLOPT_POSTFIELDS "], ["kw", "=>"], ["plain", " "], ["fn", "json_encode"], ["plain", "("], ["kw", "array"], ["plain", "("] as Seg],
  [["plain", "        "], ["str", "'model'"], ["plain", " "], ["kw", "=>"], ["plain", " "], ["str", "'platform-flash'"], ["plain", ","] as Seg],
  [["plain", "        "], ["str", "'messages'"], ["plain", " "], ["kw", "=>"], ["plain", " "], ["kw", "array"], ["plain", "("], ["kw", "array"], ["plain", "("], ["str", "'role'"], ["plain", " "], ["kw", "=>"], ["plain", " "], ["str", "'user'"], ["plain", ", "], ["str", "'content'"], ["plain", " "], ["kw", "=>"], ["plain", " "], ["str", "'你好'"], ["plain", ")),"] as Seg],
  [["plain", "    )),"] as Seg],
  [["plain", "    CURLOPT_RETURNTRANSFER "], ["kw", "=>"], ["plain", " "], ["kw", "true"], ["plain", ","] as Seg],
  [["plain", "));"] as Seg],
  [["plain", "$res = "], ["fn", "json_decode"], ["plain", "("], ["fn", "curl_exec"], ["plain", "($ch), "], ["kw", "true"], ["plain", ");"] as Seg],
  [["kw", "echo"], ["plain", " $res["], ["str", "'choices'"], ["plain", "]["], ["num", "0"], ["plain", "]["], ["str", "'message'"], ["plain", "]["], ["str", "'content'"], ["plain", "];"] as Seg],
] as CodeLines;

const GO_CODE: CodeLines = [
  [["kw", "package"], ["plain", " main"]],
  [],
  [["kw", "import"], ["plain", " ("]],
  [["plain", "    "], ["str", '"bytes"']],
  [["plain", "    "], ["str", '"encoding/json"']],
  [["plain", "    "], ["str", '"net/http"']],
  [["plain", ")"]],
  [],
  [["kw", "func"], ["plain", " main() {"]],
  [["plain", "    body, _ := json."], ["fn", "Marshal"], ["plain", "("], ["kw", "map"], ["plain", "["], ["kw", "string"], ["plain", "]"], ["kw", "interface"], ["plain", "{}{"]],
  [["plain", "        "], ["str", '"model"'], ["plain", ":    "], ["str", '"platform-flash"'], ["plain", ","]],
  [["plain", "        "], ["str", '"messages"'], ["plain", ": []"], ["kw", "map"], ["plain", "["], ["kw", "string"], ["plain", "]"], ["kw", "string"], ["plain", "{"]],
  [["plain", "            {"], ["str", '"role"'], ["plain", ": "], ["str", '"user"'], ["plain", ", "], ["str", '"content"'], ["plain", ": "], ["str", '"你好"'], ["plain", "},"]],
  [["plain", "        },"]],
  [["plain", "    })"]],
  [["plain", "    req, _ := http."], ["fn", "NewRequest"], ["plain", "("], ["str", '"POST"'], ["plain", ", "], ["str", `"${BASE_URL}/v1/chat/completions"`], ["plain", ", bytes."], ["fn", "NewReader"], ["plain", "(body))"]],
  [["plain", "    req.Header."], ["fn", "Set"], ["plain", "("], ["str", '"Authorization"'], ["plain", ", "], ["str", '"Bearer YOUR_API_KEY"'], ["plain", ")"]],
  [["plain", "    req.Header."], ["fn", "Set"], ["plain", "("], ["str", '"Content-Type"'], ["plain", ", "], ["str", '"application/json"'], ["plain", ")"]],
  [["plain", "    resp, _ := http.DefaultClient."], ["fn", "Do"], ["plain", "(req)"]],
  [["plain", "    "], ["kw", "defer"], ["plain", " resp.Body."], ["fn", "Close"], ["plain", "()"]],
  [["com", "    // handle response"]],
  [["plain", "}"]],
];

const JAVA_CODE: CodeLines = [
  [["kw", "import"], ["plain", " java.net.URI;"]],
  [["kw", "import"], ["plain", " java.net.http.*;"]],
  [],
  [["kw", "var"], ["plain", " client = HttpClient."], ["fn", "newHttpClient"], ["plain", "();"]],
  [["kw", "var"], ["plain", " body = "], ["str", '"""']],
  [["str", '{  "model": "platform-flash",']],
  [["str", '   "messages": [{"role": "user", "content": "你好"}]}']],
  [["plain", "   "], ["str", '"""'], ["plain", ";"]],
  [["kw", "var"], ["plain", " req = HttpRequest."], ["fn", "newBuilder"], ["plain", "()"]],
  [["plain", "    ."], ["fn", "uri"], ["plain", "(URI."], ["fn", "create"], ["plain", "("], ["str", `"${BASE_URL}/v1/chat/completions"`], ["plain", "))"]],
  [["plain", "    ."], ["fn", "header"], ["plain", "("], ["str", '"Authorization"'], ["plain", ", "], ["str", '"Bearer YOUR_API_KEY"'], ["plain", ")"]],
  [["plain", "    ."], ["fn", "header"], ["plain", "("], ["str", '"Content-Type"'], ["plain", ", "], ["str", '"application/json"'], ["plain", ")"]],
  [["plain", "    ."], ["fn", "POST"], ["plain", "(HttpRequest.BodyPublishers."], ["fn", "ofString"], ["plain", "(body))"]],
  [["plain", "    ."], ["fn", "build"], ["plain", "();"]],
  [["kw", "var"], ["plain", " resp = client."], ["fn", "send"], ["plain", "(req, HttpResponse.BodyHandlers."], ["fn", "ofString"], ["plain", "());"]],
  [["plain", "System.out."], ["fn", "println"], ["plain", "(resp.body());"]],
];

const RUBY_CODE: CodeLines = [
  [["kw", "require"], ["plain", " "], ["str", '"net/http"']],
  [["kw", "require"], ["plain", " "], ["str", '"json"']],
  [],
  [["plain", "uri = URI("], ["str", `"${BASE_URL}/v1/chat/completions"`], ["plain", ")"]],
  [["plain", "req = Net::HTTP::Post."], ["fn", "new"], ["plain", "(uri)"]],
  [["plain", "req["], ["str", '"Authorization"'], ["plain", "] = "], ["str", '"Bearer YOUR_API_KEY"']],
  [["plain", "req["], ["str", '"Content-Type"'], ["plain", "] = "], ["str", '"application/json"']],
  [["plain", "req.body = {"]],
  [["plain", "  "], ["prop", "model:"], ["plain", " "], ["str", '"platform-flash"'], ["plain", ","]],
  [["plain", "  "], ["prop", "messages:"], ["plain", " [{ "], ["prop", "role:"], ["plain", " "], ["str", '"user"'], ["plain", ", "], ["prop", "content:"], ["plain", " "], ["str", '"你好"'], ["plain", " }]"]],
  [["plain", "}.to_json"]],
  [],
  [["plain", "res = Net::HTTP.start(uri.hostname, uri.port, "], ["prop", "use_ssl:"], ["plain", " "], ["kw", "true"], ["plain", ") { |http| http.request(req) }"]],
  [["fn", "puts"], ["plain", " JSON.parse(res.body).dig("], ["str", '"choices"'], ["plain", ", "], ["num", "0"], ["plain", ", "], ["str", '"message"'], ["plain", ", "], ["str", '"content"'], ["plain", ")"]],
];

const CSHARP_CODE: CodeLines = [
  [["kw", "using"], ["plain", " System.Net.Http.Headers;"]],
  [["kw", "using"], ["plain", " System.Text;"]],
  [["kw", "using"], ["plain", " System.Text.Json;"]],
  [],
  [["kw", "var"], ["plain", " client = "], ["kw", "new"], ["plain", " HttpClient();"]],
  [["plain", "client.DefaultRequestHeaders.Authorization ="]],
  [["plain", "    "], ["kw", "new"], ["plain", " AuthenticationHeaderValue("], ["str", '"Bearer"'], ["plain", ", "], ["str", '"YOUR_API_KEY"'], ["plain", ");"]],
  [],
  [["kw", "var"], ["plain", " body = JsonSerializer."], ["fn", "Serialize"], ["plain", "("], ["kw", "new"], ["plain", " {"]],
  [["plain", "    model = "], ["str", '"platform-flash"'], ["plain", ","]],
  [["plain", "    messages = "], ["kw", "new"], ["plain", "[] {"]],
  [["plain", "        "], ["kw", "new"], ["plain", " { role = "], ["str", '"user"'], ["plain", ", content = "], ["str", '"你好"'], ["plain", " }"]],
  [["plain", "    }"]],
  [["plain", "});"]],
  [],
  [["kw", "var"], ["plain", " content = "], ["kw", "new"], ["plain", " StringContent(body, Encoding.UTF8, "], ["str", '"application/json"'], ["plain", ");"]],
  [["kw", "var"], ["plain", " resp = "], ["kw", "await"], ["plain", " client."], ["fn", "PostAsync"], ["plain", "("], ["str", `"${BASE_URL}/v1/chat/completions"`], ["plain", ", content);"]],
  [["kw", "var"], ["plain", " json = "], ["kw", "await"], ["plain", " resp.Content."], ["fn", "ReadAsStringAsync"], ["plain", "();"]],
  [["plain", "Console."], ["fn", "WriteLine"], ["plain", "(json);"]],
];

const CLI_CODE: CodeLines = [
  [["com", "# pip install openai"]],
  [],
  [["fn", "openai"], ["plain", " api chat.completions.create \\"]],
  [["plain", "  --api-base "], ["str", `${BASE_URL}/v1`], ["plain", " \\"]],
  [["plain", "  --api-key "], ["str", "YOUR_API_KEY"], ["plain", " \\"]],
  [["plain", "  -m "], ["str", "platform-flash"], ["plain", " \\"]],
  [["plain", "  -g user "], ["str", '"你好"']],
];

const CODE_TABS = [
  { id: "python", label: "Python", lines: PY_CODE },
  { id: "typescript", label: "TypeScript", lines: TS_CODE },
  { id: "go", label: "Go", lines: GO_CODE },
  { id: "java", label: "Java", lines: JAVA_CODE },
  { id: "ruby", label: "Ruby", lines: RUBY_CODE },
  { id: "php", label: "PHP", lines: PHP_CODE },
  { id: "csharp", label: "C#", lines: CSHARP_CODE },
  { id: "curl", label: "cURL", lines: CURL_CODE },
  { id: "cli", label: "CLI", lines: CLI_CODE },
] as const;

function linesToText(lines: CodeLines): string {
  return lines.map((line) => line.map(([, text]) => text).join("")).join("\n");
}

function CodeCard() {
  const { t } = useT();
  const [active, setActive] = useState<(typeof CODE_TABS)[number]["id"]>("python");
  const [copied, setCopied] = useState(false);

  const tab = CODE_TABS.find((t) => t.id === active) ?? CODE_TABS[0];

  const copy = () => {
    void copyText(linesToText(tab.lines)).then((ok) => {
      if (!ok) return;
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    });
  };

  return (
    <div className="home-hero__code">
      <div className="home-hero__code-tabs" role="tablist" aria-label={t("hero.codeTabs")}>
        {CODE_TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={t.id === active}
            className={`home-hero__code-tab${t.id === active ? " home-hero__code-tab--active" : ""}`}
            onClick={() => setActive(t.id)}
          >
            {t.label}
          </button>
        ))}
        <button
          type="button"
          className="home-hero__code-tab"
          style={{ marginLeft: "auto" }}
          onClick={copy}
          aria-label={t("hero.copyBtn")}
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
      </div>
      <pre className="home-hero__code-body">
        {tab.lines.map((line, i) => (
          <React.Fragment key={`${tab.id}-${i}`}>
            {line.map(([cls, text], j) =>
              cls === "plain" ? (
                <React.Fragment key={j}>{text}</React.Fragment>
              ) : (
                <span key={j} className={`tok-${cls}`}>{text}</span>
              ),
            )}
            {"\n"}
          </React.Fragment>
        ))}
      </pre>
    </div>
  );
}

function HeroSection({ cfg }: { cfg: PlatformConfig | null }) {
  const { t } = useT();

  const heroActions = [
    { to: "/docs?section=quickstart", label: t("hero.quickstart"), icon: Play },
    { to: "/docs?section=api-reference", label: t("hero.apiRef"), icon: Braces },
    { to: "/status", label: t("platform.viewReport"), icon: TrendingUp },
  ] as const;

  return (
    <section className="home-hero">
      <div className="home-hero__inner">
        <div>
          <p className="home-hero__eyebrow apiplatform-fade-slide-up" style={{ animationDelay: "0ms" }}>
            {t("hero.eyebrow")}
          </p>
          <h1 className="home-hero__title apiplatform-fade-slide-up" style={{ animationDelay: "60ms" }}>
            {cfg?.title ? (
              <span className="whitespace-pre-line" style={{ fontWeight: 550 }}>{cfg.title}</span>
            ) : (
              <SafeHtml as="span" html={t("hero.title")} />
            )}
          </h1>
          <p className="home-hero__subtitle apiplatform-fade-slide-up" style={{ animationDelay: "140ms" }}>
            {cfg?.slogan || t("hero.subtitle")}
          </p>

          {/* search entry */}
          <button
            type="button"
            className="home-hero__search apiplatform-fade-slide-up"
            style={{ animationDelay: "200ms" }}
            onClick={openGlobalSearch}
            aria-label="Search docs (⌘K)"
          >
            <Search size={16} className="home-hero__search-icon" />
            <span className="home-hero__search-placeholder">{t("hero.searchPlaceholder")}</span>
            <kbd className="home-hero__search-kbd">⌘K</kbd>
          </button>

          <div className="home-hero__actions apiplatform-fade-slide-up" style={{ animationDelay: "260ms" }}>
            {heroActions.map((a) => (
              <NewTabLink key={a.to} to={a.to} className="home-hero__action">
                <a.icon size={15} strokeWidth={2} className="home-hero__action-icon" />
                {a.label}
              </NewTabLink>
            ))}
          </div>
        </div>
        <div className="apiplatform-fade-slide-up" style={{ animationDelay: "180ms", minWidth: 0 }}>
          <CodeCard />
        </div>
      </div>
    </section>
  );
}

export { HeroSection };
