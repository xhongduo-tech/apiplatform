import { useState, useRef, useCallback } from "react";
import {
  KeyRound,
  ShieldCheck,
  Clock,
  Gauge,
  GitBranch,
  ArrowRightLeft,
  Cpu,
  RefreshCw,
  FileJson2,
  Info,
  ChevronRight,
} from "lucide-react";
import { useT } from "../../i18n";
import type { TranslationKey } from "../../i18n";
import { Html } from "./i18n-html";

type NodeKey =
  | "client"
  | "auth"
  | "whitelist"
  | "timewindow"
  | "ratelimit"
  | "route"
  | "forward"
  | "upstream"
  | "fallback"
  | "metering";

interface FlowNode {
  key: NodeKey;
  titleKey: TranslationKey;
  descKey: TranslationKey;
  Icon: typeof KeyRound;
  tone: "amber" | "peach" | "blue" | "ink";
  anchor?: string;
}

const NODES: FlowNode[] = [
  {
    key: "client",
    titleKey: "docsPage.flow.nodes.client.title",
    descKey: "docsPage.flow.nodes.client.desc",
    Icon: KeyRound,
    tone: "ink",
    anchor: "#authentication",
  },
  {
    key: "auth",
    titleKey: "docsPage.flow.nodes.auth.title",
    descKey: "docsPage.flow.nodes.auth.desc",
    Icon: ShieldCheck,
    tone: "peach",
    anchor: "#authentication",
  },
  {
    key: "whitelist",
    titleKey: "docsPage.flow.nodes.whitelist.title",
    descKey: "docsPage.flow.nodes.whitelist.desc",
    Icon: ShieldCheck,
    tone: "peach",
    anchor: "#rate-limits",
  },
  {
    key: "timewindow",
    titleKey: "docsPage.flow.nodes.timewindow.title",
    descKey: "docsPage.flow.nodes.timewindow.desc",
    Icon: Clock,
    tone: "amber",
    anchor: "#rate-limits",
  },
  {
    key: "ratelimit",
    titleKey: "docsPage.flow.nodes.ratelimit.title",
    descKey: "docsPage.flow.nodes.ratelimit.desc",
    Icon: Gauge,
    tone: "amber",
    anchor: "#rate-limits",
  },
  {
    key: "route",
    titleKey: "docsPage.flow.nodes.route.title",
    descKey: "docsPage.flow.nodes.route.desc",
    Icon: GitBranch,
    tone: "blue",
    anchor: "#models",
  },
  {
    key: "forward",
    titleKey: "docsPage.flow.nodes.forward.title",
    descKey: "docsPage.flow.nodes.forward.desc",
    Icon: ArrowRightLeft,
    tone: "blue",
    anchor: "#infrastructure",
  },
  {
    key: "upstream",
    titleKey: "docsPage.flow.nodes.upstream.title",
    descKey: "docsPage.flow.nodes.upstream.desc",
    Icon: Cpu,
    tone: "ink",
    anchor: "#infrastructure",
  },
  {
    key: "fallback",
    titleKey: "docsPage.flow.nodes.fallback.title",
    descKey: "docsPage.flow.nodes.fallback.desc",
    Icon: RefreshCw,
    tone: "peach",
    anchor: "#infrastructure",
  },
  {
    key: "metering",
    titleKey: "docsPage.flow.nodes.metering.title",
    descKey: "docsPage.flow.nodes.metering.desc",
    Icon: FileJson2,
    tone: "blue",
    anchor: "#usage-logs",
  },
];

const TONE_STYLES: Record<FlowNode["tone"], { bg: string; border: string; text: string; detailText: string; dot: string }> = {
  amber: {
    bg: "bg-block-amber/30",
    border: "border-block-amber",
    text: "text-block-amber",
    detailText: "text-block-amber",
    dot: "bg-block-amber",
  },
  peach: {
    bg: "bg-block-peach/30",
    border: "border-block-peach",
    text: "text-on-peach",
    detailText: "text-on-peach",
    dot: "bg-block-peach",
  },
  blue: {
    bg: "bg-block-blue/30",
    border: "border-block-blue",
    text: "text-block-blue",
    detailText: "text-block-blue",
    dot: "bg-block-blue",
  },
  ink: {
    bg: "bg-block-ink/30",
    border: "border-block-ink",
    text: "text-block-ink",
    detailText: "text-block-ink",
    dot: "bg-block-ink",
  },
};

export function DocsFlowDiagram() {
  const { t } = useT();
  const [active, setActive] = useState<NodeKey>("auth");
  const [detailTop, setDetailTop] = useState(0);
  const nodeRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const boardRef = useRef<HTMLDivElement | null>(null);

  const activeNode = NODES.find((n) => n.key === active)!;
  const activeIdx = NODES.findIndex((n) => n.key === active);

  const handleActivate = useCallback((key: NodeKey) => {
    setActive(key);
    const el = nodeRefs.current[key];
    const board = boardRef.current;
    if (el && board) {
      const elRect = el.getBoundingClientRect();
      const boardRect = board.getBoundingClientRect();
      setDetailTop(elRect.top - boardRect.top);
    }
  }, []);

  return (
    <div className="docs-flow" id="request-flow">
      <div className="docs-flow__hint">
        <Info size={14} />
        <span>{t("docsPage.flow.hint")}</span>
      </div>
      <div className="docs-flow__board" ref={boardRef}>
        <div className="docs-flow__rail">
          <span className="docs-flow__rail-label">{t("docsPage.flow.gatewayLabel")}</span>
          {NODES.map((node, i) => {
            const isActive = node.key === active;
            const style = TONE_STYLES[node.tone];
            return (
              <div key={node.key} className="docs-flow__slot">
                <button
                  ref={(el) => { nodeRefs.current[node.key] = el; }}
                  type="button"
                  onClick={() => handleActivate(node.key)}
                  className={`docs-flow__node ${style.bg} ${
                    isActive ? `docs-flow__node--active ${style.border}` : "border-transparent"
                  }`}
                >
                  <span className={`docs-flow__node-dot ${style.dot}`} />
                  <node.Icon size={16} className={isActive ? style.text : "text-fg-muted"} />
                  <span className="docs-flow__node-title">{t(node.titleKey)}</span>
                  {node.anchor && (
                    <ChevronRight size={12} className="docs-flow__node-chev text-fg-subtle" />
                  )}
                </button>
                {i < NODES.length - 1 && <span className="docs-flow__connector" aria-hidden />}
              </div>
            );
          })}
        </div>

        <div className={`docs-flow__detail ${TONE_STYLES[activeNode.tone].border}`} style={{ marginTop: detailTop }}>
          <div className="docs-flow__detail-head">
            <span className={`docs-flow__detail-icon ${TONE_STYLES[activeNode.tone].bg}`}>
              <activeNode.Icon size={18} className={TONE_STYLES[activeNode.tone].detailText} />
            </span>
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wider text-fg-subtle">
                {t("docsPage.flow.stepLabel")} {String(activeIdx + 1).padStart(2, "0")} / {String(NODES.length).padStart(2, "0")}
              </p>
              <h4 className="font-serif text-[16px] font-medium text-fg">{t(activeNode.titleKey)}</h4>
            </div>
            {activeNode.anchor && (
              <a href={activeNode.anchor} className="docs-flow__detail-link">
                {t("docsPage.flow.goto")}
                <ChevronRight size={13} />
              </a>
            )}
          </div>
          <Html as="p" className="docs-flow__detail-body" html={t(activeNode.descKey)} />
        </div>
      </div>
    </div>
  );
}
