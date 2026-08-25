import { useMemo } from "react";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, Cell,
} from "recharts";
import { useT } from "../../i18n";

export interface ShareBucket {
  label: string;
  count: number;
  share: number;
}

const TOOL_LABELS = ["0", "1–5", "6–10", "11–25", "26–50", "51–100", "100+"] as const;
const CONTEXT_LABELS = [
  "<1k", "1k–2k", "2k–4k", "4k–8k", "8k–16k", "16k–32k",
  "32k–64k", "64k–128k", "128k–256k", "256k–512k", "512k–1m", "1m+",
] as const;

/** 统一 en-dash / em-dash / 连字符，避免前后端分桶标签对不上导致整列归零 */
function normBucketLabel(s: string): string {
  return s.replace(/[\u2013\u2014]/g, "-").trim();
}

/** 示例图青绿渐变色阶（左浅右深） */
const TEAL_BARS = [
  "#E4F5F2",
  "#C8EBE5",
  "#ABE0D8",
  "#8DD6CB",
  "#6FCBBE",
  "#4FC0B1",
  "#2BAFA0",
];

const CONTEXT_BAR = "#58A8F7";
const GRID_STROKE = "var(--border)";
const AXIS_STROKE = "var(--border-strong)";
const TICK_FILL = "var(--fg-muted)";

export function normalizeToolBuckets(buckets: ShareBucket[]): ShareBucket[] {
  const map = new Map(buckets.map((b) => [normBucketLabel(b.label), b]));
  return TOOL_LABELS.map((label) => {
    const hit = map.get(normBucketLabel(label));
    return hit
      ? { label, count: Number(hit.count) || 0, share: Number(hit.share) || 0 }
      : { label, count: 0, share: 0 };
  });
}

export function normalizeContextBuckets(buckets: ShareBucket[]): ShareBucket[] {
  const map = new Map(buckets.map((b) => [normBucketLabel(b.label), b]));
  return CONTEXT_LABELS.map((label) => {
    const hit = map.get(normBucketLabel(label));
    return hit
      ? { label, count: Number(hit.count) || 0, share: Number(hit.share) || 0 }
      : { label, count: 0, share: 0 };
  });
}

function buildYTicks(max: number, step: number): number[] {
  const top = Math.max(step, Math.ceil(max / step) * step);
  const ticks: number[] = [];
  for (let v = 0; v <= top; v += step) ticks.push(v);
  return ticks;
}

function SessionBarChart({
  data,
  yLabel,
  xLabel,
  yStep,
  yCap,
  barColors,
  rotateX = false,
  plotHeight = 220,
  barCategoryGap = "22%",
  maxBarSize,
}: {
  data: ShareBucket[];
  yLabel: string;
  xLabel: string;
  yStep: number;
  yCap?: number;
  barColors: string[] | string;
  rotateX?: boolean;
  plotHeight?: number;
  barCategoryGap?: string | number;
  maxBarSize?: number;
}) {
  const maxShare = useMemo(() => Math.max(...data.map((d) => d.share), 0), [data]);
  const yMax = yCap ?? Math.max(yStep, Math.ceil(maxShare / yStep) * yStep);
  const yTicks = useMemo(() => buildYTicks(yMax, yStep), [yMax, yStep]);
  const xHeight = rotateX ? 56 : 24;

  return (
    <div className="w-full" role="group" aria-label={`${xLabel} — ${yLabel}`}>
      <p className="sr-only">
        {data.map((item) => `${item.label}: ${item.share}%, ${item.count}`).join("; ")}
      </p>
      {/* 左 Y 轴标题只对齐绘图区高度，避免被底部 X 轴标题往下拽 */}
      <div className="flex items-start gap-1">
        <div
          className="flex w-6 shrink-0 items-center justify-center"
          style={{ height: plotHeight }}
          aria-hidden
        >
          <span
            className="inline-block whitespace-nowrap text-[11px] font-medium text-fg-muted"
            style={{ transform: "rotate(-90deg) translateX(8px)" }}
          >
            {yLabel}
          </span>
        </div>
        <div className="min-w-0 flex-1">
          <div style={{ width: "100%", height: plotHeight }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                accessibilityLayer
                data={data}
                margin={{ top: 8, right: 12, left: 0, bottom: rotateX ? 4 : 0 }}
                barCategoryGap={barCategoryGap}
              >
                <CartesianGrid stroke={GRID_STROKE} vertical={false} strokeDasharray="" />
                <XAxis
                  dataKey="label"
                  tickLine={{ stroke: AXIS_STROKE, strokeWidth: 1 }}
                  axisLine={{ stroke: AXIS_STROKE, strokeWidth: 1.25 }}
                  interval={0}
                  tick={{
                    fontSize: rotateX ? 9.5 : 11,
                    fill: TICK_FILL,
                    fontWeight: 500,
                  }}
                  angle={rotateX ? -38 : 0}
                  textAnchor={rotateX ? "end" : "middle"}
                  dy={rotateX ? 4 : 2}
                  height={xHeight}
                />
                <YAxis
                  domain={[0, yMax]}
                  ticks={yTicks}
                  allowDecimals={false}
                  tickLine={false}
                  axisLine={false}
                  width={48}
                  tick={{ fontSize: 10.5, fill: TICK_FILL, fontWeight: 500 }}
                  tickFormatter={(v: number) => `${v}%`}
                />
                <Tooltip
                  cursor={{ fill: "rgba(var(--brand-rgb), 0.06)" }}
                  contentStyle={{
                    background: "var(--card)",
                    border: "1px solid var(--border)",
                    borderRadius: 8,
                    fontSize: 12,
                    boxShadow: "0 4px 12px rgba(0,0,0,0.08)",
                  }}
                  formatter={(value, _name, item) => [
                    `${Number(value ?? 0)}% · ${(item.payload as ShareBucket | undefined)?.count ?? 0}`,
                    yLabel,
                  ]}
                />
                <Bar dataKey="share" radius={0} maxBarSize={maxBarSize ?? (rotateX ? 28 : 52)}>
                  {data.map((_, i) => (
                    <Cell
                      key={i}
                      fill={Array.isArray(barColors) ? (barColors[i] ?? barColors[barColors.length - 1]) : barColors}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
          <p className="mt-1 text-center text-[11px] font-medium text-fg-muted">{xLabel}</p>
        </div>
      </div>
    </div>
  );
}

export function SessionToolCallsChart({ buckets }: { buckets: ShareBucket[] }) {
  const { t } = useT();
  const data = useMemo(() => normalizeToolBuckets(buckets), [buckets]);
  const maxShare = Math.max(...data.map((d) => d.share), 0);
  // 多数 session 无 tool call 时「0」档常 >30%，硬封顶会导致柱子顶穿坐标轴
  const yCap = maxShare <= 30 ? 30 : Math.min(100, Math.ceil(maxShare / 10) * 10);

  return (
    <SessionBarChart
      data={data}
      yLabel={t("usage.session.shareOfSessions")}
      xLabel={t("usage.session.toolCalls.xAxis")}
      yStep={yCap <= 30 ? 5 : 10}
      yCap={yCap}
      barColors={TEAL_BARS}
      plotHeight={228}
      barCategoryGap="24%"
      maxBarSize={48}
    />
  );
}

export function SessionContextLengthChart({ buckets }: { buckets: ShareBucket[] }) {
  const { t } = useT();
  const data = useMemo(() => normalizeContextBuckets(buckets), [buckets]);
  const maxShare = Math.max(...data.map((d) => d.share), 0);
  const yCap = maxShare <= 12 ? 12 : Math.ceil(maxShare / 2) * 2;

  return (
    <SessionBarChart
      data={data}
      yLabel={t("usage.session.shareOfSessions")}
      xLabel={t("usage.session.contextLength.xAxis")}
      yStep={2}
      yCap={yCap}
      barColors={CONTEXT_BAR}
      rotateX
      plotHeight={248}
      barCategoryGap="12%"
      maxBarSize={24}
    />
  );
}
