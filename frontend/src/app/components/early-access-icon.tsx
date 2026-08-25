import type { CSSProperties } from "react";

/**
 * 抢先体验计划专用图标 —— 锥形瓶（实验室器皿）+ 颈部上升气泡。
 *
 * 为什么自绘而不用 lucide 现成图标：
 * - `Sparkles` 在本站已被「推理」能力标签、platform-sota 别名、模型详情「核心特性」
 *   三处占用，再拿它表示抢先体验会造成语义撞车；
 * - lucide 的 `Beaker`（直筒烧杯）实测在 12–16px 下与普通水杯难以区分，而平台
 *   绝大多数使用场景都在这个尺寸区间；锥形瓶的三角轮廓在 12px 仍一眼可辨。
 *
 * 绘制约定与 lucide 对齐（24 网格 / 2px 描边 / round 端点），可与 lucide 图标并排
 * 混用；玻璃用描边、液体用 currentColor 半透明填充、气泡用实心点——实心元素保证
 * 小尺寸下不糊成一团。气泡在 12px 左右会自然隐没，退化为纯瓶身，仍然清晰。
 *
 * API 与 lucide 一致（size / strokeWidth / className / style），因此可直接塞进
 * `icon: ComponentType<{ className?: string }>` 这类插槽；className 里的
 * Tailwind 尺寸类（h-4 w-4）会覆盖 width/height 属性。
 */
export function EarlyAccessIcon({
  size = 24,
  strokeWidth = 2,
  className,
  style,
  fillOpacity = 0.22,
  title,
}: {
  size?: number | string;
  strokeWidth?: number;
  className?: string;
  style?: CSSProperties;
  /** 液体填充浓度；置 0 可得纯描边版本 */
  fillOpacity?: number;
  /** 传入后图标对读屏可见，否则默认按装饰性元素隐藏 */
  title?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={style}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      {/* 液体：填充在液面以下的瓶身内 */}
      {fillOpacity > 0 && (
        <path
          d="M8.6 13.4h6.8l3.3 5.1A1.4 1.4 0 0 1 17.5 21h-11a1.4 1.4 0 0 1-1.2-2.5Z"
          fill="currentColor"
          fillOpacity={fillOpacity}
          stroke="none"
        />
      )}
      {/* 瓶口 */}
      <path d="M8.4 2.8h7.2" />
      {/* 瓶身轮廓：颈部 → 锥形 → 平底 */}
      <path d="M9.8 2.8v6.4L5.1 18.6A1.5 1.5 0 0 0 6.4 21h11.2a1.5 1.5 0 0 0 1.3-2.4L14.2 9.2V2.8" />
      {/* 液面 */}
      <path d="M8.6 13.4h6.8" />
      {/* 上升气泡：由大到小构成上升感，小尺寸下自然隐没 */}
      <circle cx="12" cy="10.7" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="12" cy="7.3" r="0.72" fill="currentColor" stroke="none" />
    </svg>
  );
}
