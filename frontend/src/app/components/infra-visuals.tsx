import type { LucideIcon } from "lucide-react";
import {
  BrainCircuit, Workflow, Box, Server, Cpu, Container, AppWindow,
} from "lucide-react";
import type { InfraLayerId } from "./infra-layer-detail-modal";
import type { InfraTechId } from "./infra-stack-data";

/** 五层架构侧栏示意图（紧凑，用于总览页） */
export function InfraStackIllustration({ className = "" }: { className?: string }) {
  const layers = [
    { label: "L5", color: "#8b5cf6", h: 22 },
    { label: "L4", color: "#6366f1", h: 26 },
    { label: "L3", color: "#5B8DEF", h: 28 },
    { label: "L2", color: "#7BC47F", h: 24 },
    { label: "L1", color: "#9B8EC4", h: 34 },
  ];
  let y = 14;
  const nodes = layers.map((layer, i) => {
    const w = 118 - i * 7;
    const x = 42 + i * 3;
    const el = (
      <g key={layer.label}>
        <rect x={x} y={y} width={w} height={layer.h} rx="6" fill={layer.color} fillOpacity={0.18} stroke={layer.color} strokeOpacity={0.45} strokeWidth="1" />
        <text x={x + 8} y={y + layer.h / 2 + 4} fill={layer.color} fontSize="10" fontWeight="700">{layer.label}</text>
        {Array.from({ length: 5 - i }).map((_, j) => (
          <rect
            key={j}
            x={x + 30 + j * 16}
            y={y + layer.h / 2 - 5}
            width="12"
            height="10"
            rx="2"
            fill={layer.color}
            fillOpacity={0.35}
          />
        ))}
      </g>
    );
    y += layer.h + 5;
    return el;
  });

  return (
    <svg viewBox="0 0 200 196" className={className} aria-hidden>
      <defs>
        <linearGradient id="infra-stack-bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="var(--brand)" stopOpacity="0.08" />
          <stop offset="100%" stopColor="var(--chart-3)" stopOpacity="0.04" />
        </linearGradient>
      </defs>
      <rect x="8" y="8" width="184" height="180" rx="16" fill="url(#infra-stack-bg)" stroke="var(--border)" strokeOpacity="0.5" />
      {nodes}
    </svg>
  );
}

const CHIP_META = [
  { id: "DEMO-ACCEL-A", color: "#6366f1", count: 2 },
  { id: "DEMO-ACCEL-B", color: "#5B8DEF", count: 1 },
] as const;

export function InfraChipStrip() {
  return (
    <div className="flex flex-wrap items-center justify-center gap-3">
      {CHIP_META.map((chip) => (
        <div
          key={chip.id}
          className="flex items-center gap-2 rounded-xl border border-border/40 bg-card px-3 py-2 shadow-sm"
        >
          <GpuCardIcon color={chip.color} />
          <div>
            <p className="text-[12px] font-bold tabular-nums" style={{ color: chip.color }}>{chip.id}</p>
            <p className="text-[9px] text-muted-foreground">×{chip.count}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

function GpuCardIcon({ color, size = 32 }: { color: string; size?: number }) {
  return (
    <svg width={size} height={size * 0.75} viewBox="0 0 40 30" aria-hidden>
      <rect x="2" y="4" width="36" height="22" rx="4" fill={color} fillOpacity="0.15" stroke={color} strokeOpacity="0.5" strokeWidth="1.2" />
      <rect x="6" y="8" width="8" height="6" rx="1" fill={color} fillOpacity="0.5" />
      <rect x="16" y="8" width="8" height="6" rx="1" fill={color} fillOpacity="0.5" />
      <rect x="26" y="8" width="8" height="6" rx="1" fill={color} fillOpacity="0.5" />
      <rect x="14" y="18" width="12" height="4" rx="1" fill={color} fillOpacity="0.35" />
    </svg>
  );
}

const LAYER_BANNER: Record<InfraLayerId, { gradient: [string, string]; Icon: LucideIcon }> = {
  application: { gradient: ["#8b5cf6", "#a78bfa"], Icon: AppWindow },
  model: { gradient: ["#6366f1", "#818cf8"], Icon: BrainCircuit },
  inference: { gradient: ["#5B8DEF", "#7BA7F7"], Icon: Workflow },
  runtime: { gradient: ["#7BC47F", "#94D3AA"], Icon: Container },
  hardware: { gradient: ["#9B8EC4", "#B5A8D8"], Icon: Server },
};

export function InfraLayerBanner({ layer }: { layer: InfraLayerId }) {
  const { gradient, Icon } = LAYER_BANNER[layer];
  return (
    <div
      className="relative mb-4 overflow-hidden rounded-xl px-4 py-5"
      style={{ background: `linear-gradient(135deg, ${gradient[0]}22 0%, ${gradient[1]}08 100%)` }}
    >
      <div className="absolute -right-6 -top-6 h-24 w-24 rounded-full opacity-20" style={{ background: gradient[0] }} />
      <div className="relative flex items-center gap-3">
        <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-white/80 shadow-sm dark:bg-card/80">
          <Icon className="h-5 w-5" style={{ color: gradient[0] }} />
        </div>
        <InfraLayerMiniSvg layer={layer} color={gradient[0]} />
      </div>
    </div>
  );
}

function InfraLayerMiniSvg({ layer, color }: { layer: InfraLayerId; color: string }) {
  if (layer === "application") {
    return (
      <svg viewBox="0 0 120 40" className="h-10 w-28 opacity-80" aria-hidden>
        {[0, 1, 2, 3].map((i) => (
          <g key={i}>
            <rect x={6 + i * 28} y="10" width="22" height="20" rx="4" fill={color} fillOpacity={0.15 + i * 0.05} stroke={color} strokeOpacity="0.4" />
            <rect x={10 + i * 28} y="14" width="14" height="3" rx="1" fill={color} fillOpacity="0.45" />
            <rect x={10 + i * 28} y="20" width="10" height="2" rx="1" fill={color} fillOpacity="0.3" />
          </g>
        ))}
      </svg>
    );
  }
  if (layer === "hardware") {
    return (
      <svg viewBox="0 0 120 40" className="h-10 w-28 opacity-80" aria-hidden>
        {[0, 1, 2].map((i) => (
          <g key={i}>
            <rect x={4 + i * 38} y="8" width="32" height="24" rx="3" fill={color} fillOpacity="0.2" stroke={color} strokeOpacity="0.4" />
            <rect x={8 + i * 38} y="14" width="24" height="4" rx="1" fill={color} fillOpacity="0.5" />
          </g>
        ))}
      </svg>
    );
  }
  if (layer === "runtime") {
    return (
      <svg viewBox="0 0 120 40" className="h-10 w-28 opacity-80" aria-hidden>
        <rect x="8" y="10" width="44" height="20" rx="4" fill="#76B900" fillOpacity="0.2" stroke="#76B900" strokeOpacity="0.4" />
        <text x="16" y="24" fill="#76B900" fontSize="8" fontWeight="600">NVIDIA</text>
        <rect x="58" y="10" width="54" height="20" rx="4" fill={color} fillOpacity="0.2" stroke={color} strokeOpacity="0.4" />
        <text x="66" y="24" fill={color} fontSize="8" fontWeight="600">Ascend</text>
      </svg>
    );
  }
  if (layer === "inference") {
    return (
      <svg viewBox="0 0 120 40" className="h-10 w-28 opacity-80" aria-hidden>
        {[0, 1, 2, 3].map((i) => (
          <circle key={i} cx={20 + i * 26} cy="20" r="10" fill={color} fillOpacity={0.15 + i * 0.08} stroke={color} strokeOpacity="0.4" />
        ))}
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 120 40" className="h-10 w-28 opacity-80" aria-hidden>
      <path d="M10 30 L30 10 L50 22 L70 14 L90 26 L110 18" fill="none" stroke={color} strokeWidth="2" strokeOpacity="0.5" />
      {[0, 1, 2, 3, 4].map((i) => (
        <circle key={i} cx={10 + i * 22} cy={28 - (i % 3) * 10} r="4" fill={color} fillOpacity="0.6" />
      ))}
    </svg>
  );
}

const HW_ICON: Record<string, LucideIcon> = {
  "hw-demo-a": Cpu,
  "hw-demo-b": Server,
};

export function InfraHardwareIcon({ nodeId, accent }: { nodeId: string; accent: string }) {
  const Icon = HW_ICON[nodeId] ?? Server;
  return (
    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg" style={{ background: `${accent}18` }}>
      <Icon className="h-4 w-4" style={{ color: accent }} />
    </div>
  );
}

const TECH_VISUAL: Record<InfraTechId, { accent: string; glyph: string }> = {
  vllm: { accent: "#5B8DEF", glyph: "LLM" },
  "embed-serving": { accent: "#F0B954", glyph: "VEC" },
  "container-runtime": { accent: "#7BC47F", glyph: "CTR" },
};

export function InfraTechBadge({ techId, size = "md" }: { techId: InfraTechId; size?: "sm" | "md" | "lg" }) {
  const v = TECH_VISUAL[techId];
  const dim = size === "lg" ? "h-14 w-14 text-[11px]" : size === "md" ? "h-10 w-10 text-[9px]" : "h-8 w-8 text-[8px]";
  return (
    <div
      className={`flex shrink-0 items-center justify-center rounded-xl font-bold tracking-tight ${dim}`}
      style={{ background: `${v.accent}18`, color: v.accent, border: `1px solid ${v.accent}40` }}
    >
      {v.glyph}
    </div>
  );
}

/** 技术详情弹窗顶部插图 */
export function InfraTechHeroImage({ techId }: { techId: InfraTechId }) {
  const v = TECH_VISUAL[techId];
  return (
    <div className="relative h-28 overflow-hidden rounded-xl border border-border/30" style={{ background: `linear-gradient(135deg, ${v.accent}18, transparent)` }}>
      <svg viewBox="0 0 400 112" className="absolute inset-0 h-full w-full" preserveAspectRatio="xMidYMid slice" aria-hidden>
        <defs>
          <pattern id={`grid-${techId}`} width="16" height="16" patternUnits="userSpaceOnUse">
            <path d="M16 0 L0 0 L0 16" fill="none" stroke={v.accent} strokeOpacity="0.12" />
          </pattern>
        </defs>
        <rect width="400" height="112" fill={`url(#grid-${techId})`} />
        <circle cx="320" cy="20" r="60" fill={v.accent} fillOpacity="0.08" />
        <rect x="24" y="24" width="80" height="64" rx="8" fill={v.accent} fillOpacity="0.12" stroke={v.accent} strokeOpacity="0.3" />
        <text x="64" y="62" textAnchor="middle" fill={v.accent} fontSize="14" fontWeight="700">{v.glyph}</text>
        {[0, 1, 2].map((i) => (
          <g key={i}>
            <rect x={130 + i * 70} y={36} width="50" height="40" rx="6" fill={v.accent} fillOpacity={0.08 + i * 0.04} stroke={v.accent} strokeOpacity="0.25" />
          </g>
        ))}
      </svg>
    </div>
  );
}

const DEP_ICON: Record<string, LucideIcon> = {
  "dep-demo-chat": BrainCircuit,
  "dep-demo-embedding": Workflow,
};

export function InfraDeploymentIcon({ depId, accent = "var(--brand)" }: { depId: string; accent?: string }) {
  const Icon = DEP_ICON[depId] ?? Box;
  return (
    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-secondary/60">
      <Icon className="h-5 w-5" style={{ color: accent }} />
    </div>
  );
}

export function InfraTechFlowDiagram({ techId }: { techId: InfraTechId }) {
  const v = TECH_VISUAL[techId];
  const steps: Record<InfraTechId, string[]> = {
    vllm: ["API", "Batch", "Cache", "Device"],
    "embed-serving": ["API", "Queue", "Encode", "Vector"],
    "container-runtime": ["Image", "Runtime", "Schedule", "Device"],
  };
  const list = steps[techId];

  return (
    <div className="rounded-xl border border-border/40 bg-secondary/15 p-4">
      <div className="flex items-center justify-between gap-2">
        {list.map((step, i) => (
          <div key={step} className="flex flex-1 flex-col items-center gap-1">
            <div
              className="flex h-10 w-full max-w-[56px] items-center justify-center rounded-lg text-[9px] font-bold"
              style={{ background: `${v.accent}15`, color: v.accent, border: `1px solid ${v.accent}30` }}
            >
              {step}
            </div>
            {i < list.length - 1 && (
              <div className="hidden sm:block absolute" aria-hidden />
            )}
          </div>
        ))}
      </div>
      <div className="mt-3 flex items-center px-4">
        {list.map((step, i) => (
          <div key={step} className="flex flex-1 items-center">
            <div className="h-1.5 w-1.5 rounded-full" style={{ background: v.accent, opacity: 0.6 }} />
            {i < list.length - 1 && <div className="mx-0.5 h-px flex-1" style={{ background: `${v.accent}35` }} />}
          </div>
        ))}
      </div>
    </div>
  );
}
