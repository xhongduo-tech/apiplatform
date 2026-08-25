import { ArrowRight, BookOpen, Braces, Play, Share2 } from "lucide-react";
import type { SVGProps } from "react";
import { NewTabLink } from "../NewTabLink";
import { HomeSection } from "./section-shell";
import { useT } from "../../i18n";

/* ------------------------------------------------------------------ */
/* 顶部插画：生产级矢量图,统一 2px 描边 + round linejoin/linecap,     */
/* 分层渲染(地面投影 → 主体 → 高光),全部使用主题 CSS 变量兼容亮/暗模式  */
/* ------------------------------------------------------------------ */

function CodeWindowIllo(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      width="160"
      height="132"
      viewBox="0 0 160 132"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
      {...props}
    >
      <defs>
        <filter id="cw-shadow" x="-20%" y="-10%" width="140%" height="140%">
          <feGaussianBlur in="SourceAlpha" stdDeviation="3" result="blur" />
          <feOffset in="blur" dx="0" dy="4" result="offsetBlur" />
          <feComponentTransfer in="offsetBlur" result="shadow">
            <feFuncA type="linear" slope="0.12" />
          </feComponentTransfer>
          <feMerge>
            <feMergeNode in="shadow" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      {/* 地面投影 */}
      <ellipse cx="80" cy="124" rx="56" ry="4" fill="var(--fg)" opacity="0.07" />

      {/* 顶部小标签(探出的 tab) */}
      <path
        d="M36 20 h36 c5 0 9 4 9 9 v3 H27 v-3 c0 -5 4 -9 9 -9 z"
        fill="var(--bg-soft)"
        stroke="var(--fg-muted)"
        strokeOpacity="0.45"
        strokeWidth="1.5"
      />

      {/* 窗口主体 */}
      <g filter="url(#cw-shadow)">
        <rect
          x="18"
          y="28"
          width="124"
          height="88"
          rx="10"
          fill="var(--card)"
          stroke="var(--fg-muted)"
          strokeOpacity="0.55"
          strokeWidth="2"
        />
        {/* 顶栏分隔线 */}
        <path
          d="M18 50 h124"
          stroke="var(--fg-muted)"
          strokeOpacity="0.25"
          strokeWidth="1.5"
        />
        {/* 三个交通灯 */}
        <circle cx="32" cy="39" r="3" fill="var(--danger)" opacity="0.55" />
        <circle cx="44" cy="39" r="3" fill="var(--warn)" opacity="0.6" />
        <circle cx="56" cy="39" r="3" fill="var(--ok)" opacity="0.6" />

        {/* 代码主体 </>  —— 居中、缩小,与窗口留白和谐 */}
        <g
          stroke="var(--fg)"
          strokeOpacity="0.7"
          strokeWidth="3.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        >
          <path d="M66 88 L56 80 L66 72" />
          <path d="M82 72 L78 88" />
          <path d="M94 72 L104 80 L94 88" />
        </g>
      </g>
    </svg>
  );
}

function CloudStackIllo(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      width="172"
      height="132"
      viewBox="0 0 172 132"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
      {...props}
    >
      <defs>
        <filter id="cs-shadow" x="-15%" y="-10%" width="130%" height="140%">
          <feGaussianBlur in="SourceAlpha" stdDeviation="3" result="blur" />
          <feOffset in="blur" dx="0" dy="4" result="offsetBlur" />
          <feComponentTransfer in="offsetBlur" result="shadow">
            <feFuncA type="linear" slope="0.12" />
          </feComponentTransfer>
          <feMerge>
            <feMergeNode in="shadow" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      {/* 地面投影 */}
      <ellipse cx="86" cy="124" rx="62" ry="4" fill="var(--fg)" opacity="0.07" />

      {/* 后面的大云(轮廓) */}
      <g filter="url(#cs-shadow)">
        <path
          d="M42 78
             c0 -15.5 12.5 -28 28 -28
             c4.2 0 8.2 0.9 11.8 2.6
             4.8 -10.8 15.6 -18.2 28 -18.2
             c16.8 0 30.5 13 31.6 29.6
             9 2.8 15.6 11 15.6 20.8
             c0 12.2 -10 22 -22.6 22
             H64.6 C52.2 106.8 42 96.8 42 83.6 z"
          fill="var(--card)"
          stroke="var(--fg-muted)"
          strokeOpacity="0.6"
          strokeWidth="2"
          strokeLinejoin="round"
        />
        {/* 云身高光弧 */}
        <path
          d="M82 66 q8 8 0 16"
          stroke="var(--fg-muted)"
          strokeOpacity="0.35"
          strokeWidth="2"
          strokeLinecap="round"
          fill="none"
        />
        <path
          d="M108 60 q10 9 0 18"
          stroke="var(--fg-muted)"
          strokeOpacity="0.35"
          strokeWidth="2"
          strokeLinecap="round"
          fill="none"
        />
      </g>

      {/* 前面的小云(实心) —— 放在大云之后绘制以覆盖其底部描边,形成层次 */}
      <path
        d="M60 118
           c-12 0 -21 -8.4 -21 -19.4
           c0 -10 7.8 -18 18 -19.2
           2.8 -9.6 11.8 -16.6 22.4 -16.6
           c9.8 0 18.2 5.8 21.8 14.4
           9 0.8 15.8 8.4 15.8 17.8
           0 10 -8.2 18.2 -19.4 18.2
           H74 v4.8 z"
        fill="var(--bg-soft)"
        stroke="var(--fg-muted)"
        strokeOpacity="0.5"
        strokeWidth="2"
        strokeLinejoin="round"
      />

      {/* Agent 标识:小云身上的三粒节点,暗示"多智能体/网络" */}
      <circle cx="78" cy="92" r="2.6" fill="var(--brand)" opacity="0.8" />
      <circle cx="92" cy="86" r="2.6" fill="var(--fg-muted)" opacity="0.45" />
      <circle cx="104" cy="94" r="2.6" fill="var(--fg-muted)" opacity="0.45" />
      {/* 节点之间的连线,强化"网络/编排"语义 */}
      <path
        d="M80.6 92 L89.4 87 M94.6 87 L101.4 93"
        stroke="var(--fg-muted)"
        strokeOpacity="0.35"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function ChooseSection() {
  const { t } = useT();

  const cards = [
    {
      illo: CodeWindowIllo,
      title: t("choose.api.title"),
      desc: t("choose.api.desc"),
      links: [
        { label: t("choose.api.link1"), to: "/docs?section=quickstart", icon: Play },
        { label: t("choose.api.link2"), to: "/docs?section=api-reference", icon: BookOpen },
        { label: t("choose.api.link3"), to: "/docs?section=chat-api", icon: Braces },
      ],
    },
    {
      illo: CloudStackIllo,
      title: t("choose.agent.title"),
      desc: t("choose.agent.desc"),
      links: [
        { label: t("choose.agent.link1"), to: "/docs?section=agent-tools", icon: Play },
        { label: t("choose.agent.link2"), to: "/models", icon: BookOpen },
        { label: t("choose.agent.link3"), to: "/docs?section=agent-tools", icon: Share2 },
      ],
    },
  ] as const;

  return (
    <HomeSection
      eyebrow="Choose how you build"
      title={t("choose.title")}
      desc={t("choose.desc")}
    >
      <div className="grid gap-5 md:grid-cols-2">
        {cards.map((card) => {
          const Illo = card.illo;
          return (
            <div key={card.title} className="card flex flex-col overflow-hidden p-0">
              <div className="relative flex h-[232px] items-center justify-center border-b border-border bg-bg-soft">
                <div
                  aria-hidden
                  className="absolute inset-0"
                  style={{
                    backgroundImage:
                      "radial-gradient(circle, rgba(var(--ink-rgb), 0.14) 0.7px, transparent 0.7px)",
                    backgroundSize: "12px 12px",
                    backgroundPosition: "0 0",
                  }}
                />
                <Illo className="relative z-10" />
              </div>
              <div className="flex flex-col gap-3 p-7 pt-6">
                <h3
                  className="font-serif text-[28px] leading-tight text-fg"
                  style={{ fontWeight: 500 }}
                >
                  {card.title}
                </h3>
                <p className="text-[14px] leading-relaxed text-fg-muted">
                  {card.desc}
                </p>
                <div className="mt-4 -mx-2 flex flex-col">
                  {card.links.map((link, idx) => {
                    const LinkIcon = link.icon;
                    return (
                      <NewTabLink
                        key={`${link.to}-${idx}`}
                        to={link.to}
                        className="group flex w-full items-center gap-3 rounded-xl px-3 py-3 text-[15px] font-medium text-fg transition-colors hover:bg-bg-soft"
                      >
                        <LinkIcon
                          size={18}
                          strokeWidth={1.5}
                          className="shrink-0 text-fg-muted transition-colors group-hover:text-fg"
                        />
                        <span className="flex-1">{link.label}</span>
                        <ArrowRight
                          size={18}
                          strokeWidth={1.5}
                          className="shrink-0 text-fg-subtle opacity-0 transition-all group-hover:translate-x-0 group-hover:text-fg group-hover:opacity-100"
                        />
                      </NewTabLink>
                    );
                  })}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </HomeSection>
  );
}
