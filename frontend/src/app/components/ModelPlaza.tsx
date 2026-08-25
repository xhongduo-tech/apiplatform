/**
 * ModelPlaza — 模型广场  2026-07 refactor
 *
 * 设计语言对齐首页(纸白底 / 陶土橙点缀 / 衬线大标题 / 发丝线描边)。
 *
 * 本文件只保留：数据获取、筛选/排序状态、表格渲染、表头下拉面板。
 * 子组件已抽出到 model-plaza/ 目录：
 *   - FeaturedStrip       主推模型族卡片
 *   - ModelAssistant      按场景推荐模型
 *   - StableDialog        STABLE/LTS 别名说明弹窗
 *   - capability-chips    能力标签定义、tooltip、排序与渲染
 *   - status-badge        状态徽章 & LTS 别名 chip
 *   - plaza-constants     HEAT 热度、SCENARIOS、默认筛选
 */
import { useState, useEffect, useMemo, useCallback, useRef, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { copyText } from "../browser-compat";
import { Copy, Check, Filter, ChevronUp, ChevronDown, ArrowRight } from "lucide-react";
import { type Model } from "./model-types";
import { api } from "../api/gateway";
import { toModels } from "./model-adapter";
import { PRESET_CATALOG } from "./catalog-models";
import { ProviderIcon } from "./provider-logos";
import { useT } from "../i18n";
import { DEFAULT_STATUS_FILTER, LTS_RESOLVE_DEFAULTS } from "./model-plaza/plaza-constants";
import {
  sortModelsPlaza,
  type PlazaSortDir,
  type PlazaSortKey,
} from "./model-plaza/plaza-sort";
import {
  getTaskChips, visibleTaskChips,
  TaskChipBadge, OverflowChipBadge,
} from "./model-plaza/capability-chips";
import { FeaturedStrip } from "./model-plaza/FeaturedStrip";
import { ModelAssistant } from "./model-plaza/ModelAssistant";
import { StableDialog } from "./model-plaza/StableDialog";
import { StatusBadge } from "./model-plaza/status-badge";

function fmtRelease(d?: string) {
  if (!d) return null;
  return d.replace("-", ".");
}

export function ModelPlaza() {
  const navigate = useNavigate();
  const { t } = useT();
  const [models, setModels] = useState<Model[]>(() => toModels(PRESET_CATALOG));
  const [apiError, setApiError] = useState("");

  useEffect(() => {
    api.models()
      .then((r) => {
        setApiError("");
        if (Array.isArray(r.data) && r.data.length) {
          setModels(toModels(r.data));
        }
      })
      .catch((e) => {
        setApiError(e instanceof Error ? e.message : t("modelPlaza.error"));
      });
  }, []);

  // ── 排序 / 筛选 ──
  const [sortKey, setSortKey] = useState<PlazaSortKey>("release");
  const [sortDir, setSortDir] = useState<PlazaSortDir>("asc");
  const [filterCat, setFilterCat] = useState<Set<string>>(new Set());
  // 默认展示在线 + 抢先体验计划：后者是真实可调用的模型（对已授权用户），
  // 只挑 online 会让管理员标记为抢先体验的模型从表里消失。
  const [filterStatus, setFilterStatus] = useState<Set<string>>(new Set(DEFAULT_STATUS_FILTER));
  const [filterTags, setFilterTags] = useState<Set<string>>(new Set());

  // 表头下拉面板(类别/状态/标签筛选)
  const [openHeader, setOpenHeader] = useState<"category" | "status" | "tags" | null>(null);
  const headerRef = useRef<Record<string, HTMLDivElement | null>>({});
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [panelPos, setPanelPos] = useState<{ top: number; left: number } | null>(null);
  useEffect(() => {
    if (!openHeader) { setPanelPos(null); return; }
    const el = headerRef.current[openHeader];
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPanelPos({ top: r.bottom + 4, left: r.left });
  }, [openHeader]);
  useEffect(() => {
    const close = () => setOpenHeader(null);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => { window.removeEventListener("scroll", close, true); window.removeEventListener("resize", close); };
  }, []);
  useEffect(() => {
    if (!openHeader) return;
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (panelRef.current?.contains(target)) return;
      const headerEl = headerRef.current[openHeader];
      if (headerEl?.contains(target)) return;
      setOpenHeader(null);
    };
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [openHeader]);

  const [stableOpen, setStableOpen] = useState(false);

  const ltsResolve = useMemo(() => {
    const sotaModel = models.find(m => m.category === "lts" && m.id.toLowerCase().includes("sota"));
    const flashModel = models.find(m => m.category === "lts" && m.id.toLowerCase().includes("flash"));
    return {
      sota: sotaModel?.resolveToModelId || LTS_RESOLVE_DEFAULTS.sota,
      flash: flashModel?.resolveToModelId || LTS_RESOLVE_DEFAULTS.flash,
    };
  }, [models]);
  const nonLts = useMemo(() => models.filter(m => m.category !== "lts"), [models]);

  const filtered = useMemo(() => {
    let rows = nonLts;
    if (filterCat.size) rows = rows.filter(m => filterCat.has(m.category));
    if (filterStatus.size) {
      rows = rows.filter(m => filterStatus.has(m.status || ""));
    } else {
      // 默认不展示已下线模型，但用户选中"已下线"筛选时仍可看到
      rows = rows.filter(m => m.status !== "offline");
    }
    if (filterTags.size) {
      // OR 逻辑：只要模型具备任一选中标签即可命中（探索式浏览更友好）
      rows = rows.filter(m => {
        const modelTags = new Set(m.tags ?? []);
        return [...filterTags].some(t => modelTags.has(t));
      });
    }
    return rows;
  }, [nonLts, filterCat, filterStatus, filterTags]);

  // 类别 / 状态枚举(表头筛选用)
  const catOptions = useMemo(() => {
    const set = new Set<string>();
    nonLts.forEach(m => set.add(m.category));
    return Array.from(set).sort();
  }, [nonLts]);
  const statusOptions = useMemo(() => {
    const set = new Set<string>();
    nonLts.forEach(m => set.add(m.status || ""));
    return Array.from(set).sort();
  }, [nonLts]);
  const STATUS_LABEL = useMemo<Record<string, string>>(() => ({
    online:      t("modelPlaza.status.online"),
    upcoming:    t("modelPlaza.status.upcoming"),
    upgrading:   t("modelPlaza.status.upgrading"),
    sunsetting:  t("modelPlaza.status.sunsetting"),
    offline:     t("modelPlaza.status.offline"),
    exclusive:   t("modelPlaza.status.exclusive"),
    unstable:    t("modelPlaza.status.unstable"),
    maintenance: t("modelPlaza.status.maintenance"),
  }), [t]);

  /** 大类固定展示顺序（模型广场按此顺序分区排列） */
  const CATEGORY_LABEL = useMemo<Record<string, string>>(() => ({
    flagship:   t("modelPlaza.cat.flagship"),
    chat:       t("modelPlaza.cat.chat"),
    vision:     t("modelPlaza.cat.vision"),
    embedding:  t("modelPlaza.cat.embedding"),
    reranker:   t("modelPlaza.cat.reranker"),
    ocr:        t("modelPlaza.cat.ocr"),
    lts:        t("modelPlaza.cat.lts"),
  }), [t]);

  const sorted = useMemo(
    () => sortModelsPlaza(filtered, sortKey, sortDir),
    [filtered, sortKey, sortDir],
  );

  // ── Table row ──
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const copyId = (id: string) => {
    void copyText(id).then((ok) => {
      if (!ok) {
        toast.error(t("common.copyFailed"));
        return;
      }
      setCopiedId(id);
      toast.success(`${t("modelPlaza.copied")} ${id}`);
      setTimeout(() => setCopiedId(c => (c === id ? null : c)), 1400);
    });
  };

  type ColKey = "name" | "provider" | "category" | "params" | "context" | "release" | "capabilities" | "status";
  type ColDef = {
    key: ColKey; label: string; width: string;
    sortable?: boolean; filterable?: "category" | "status" | "tags"; align?: "right";
  };
  const COLS: ColDef[] = [
    { key: "name",         label: t("modelPlaza.col.model"),        width: "minmax(240px, 2.4fr)", sortable: true },
    { key: "category",     label: t("modelPlaza.col.category"),     width: "minmax(110px, 0.9fr)", filterable: "category" },
    { key: "params",       label: t("modelPlaza.col.params"),       width: "minmax(90px, 0.8fr)",  sortable: true },
    { key: "context",      label: t("modelPlaza.col.context"),      width: "minmax(90px, 0.8fr)",  sortable: true },
    { key: "release",      label: t("modelPlaza.col.release"),      width: "minmax(100px, 0.85fr)", sortable: true },
    { key: "capabilities", label: t("modelPlaza.col.capabilities"), width: "minmax(200px, 1.8fr)", filterable: "tags" },
    { key: "status",       label: t("modelPlaza.col.status"),       width: "minmax(110px, 0.9fr)", filterable: "status", align: "right" },
  ];
  const gridTemplate = COLS.map(c => c.width).join(" ");

  const handleSort = (key: PlazaSortKey) => {
    if (sortKey === key) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSortKey(key); setSortDir("asc"); }
  };
  const toggleSet = (set: Set<string>, v: string) => {
    const next = new Set(set);
    if (next.has(v)) next.delete(v); else next.add(v);
    return next;
  };

  /** 收集所有可见模型的能力标签，按频次排序，供标签筛选使用 */
  const allCapabilityTags = useMemo(() => {
    const count = new Map<string, number>();
    nonLts.forEach(m => {
      (m.tags ?? []).forEach(t => count.set(t, (count.get(t) ?? 0) + 1));
    });
    return [...count.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([tag]) => tag);
  }, [nonLts]);

  const renderHeader = () => (
    <div
      role="row"
      style={{
        display: "grid", gridTemplateColumns: gridTemplate,
        gap: 16, alignItems: "center",
        padding: "10px 20px",
        fontSize: 11, fontWeight: 580,
        textTransform: "uppercase", letterSpacing: "0.08em",
        color: "var(--fg-subtle)",
        borderBottom: "1px solid var(--border)",
        position: "relative",
      }}
    >
      {COLS.map(c => {
        const isSortCol = c.sortable && sortKey === c.key;
        const align = c.align === "right" ? "right" : "left";
        const hasCatFilter = c.filterable === "category" && filterCat.size > 0;
        const hasStatusFilter = c.filterable === "status" && filterStatus.size > 0;
        const hasTagFilter = c.filterable === "tags" && filterTags.size > 0;
        const hasActiveFilter = hasCatFilter || hasStatusFilter || hasTagFilter;
        const isOpen =
          (c.filterable === "category" && openHeader === "category") ||
          (c.filterable === "status"   && openHeader === "status") ||
          (c.filterable === "tags"     && openHeader === "tags");

        return (
          <div
            key={c.key}
            ref={el => { if (c.filterable) headerRef.current[c.filterable] = el; }}
            role="columnheader"
            style={{
              display: "inline-flex", alignItems: "center", gap: 4,
              justifyContent: align === "right" ? "flex-end" : "flex-start",
              cursor: c.sortable || c.filterable ? "pointer" : "default",
              userSelect: "none",
            }}
            onClick={() => { if (c.sortable) handleSort(c.key as PlazaSortKey); }}
          >
            <span>{c.label}</span>

            {c.sortable && (
              <span style={{ display: "inline-flex", flexDirection: "column", marginLeft: 2, lineHeight: 0 }}>
                <ChevronUp
                  size={9} strokeWidth={2.5}
                  style={{
                    color: isSortCol && sortDir === "asc" ? "var(--brand)" : "var(--fg-subtle)",
                    opacity: isSortCol && sortDir === "asc" ? 1 : 0.4,
                  }}
                />
                <ChevronDown
                  size={9} strokeWidth={2.5}
                  style={{
                    color: isSortCol && sortDir === "desc" ? "var(--brand)" : "var(--fg-subtle)",
                    opacity: isSortCol && sortDir === "desc" ? 1 : 0.4,
                    marginTop: -1,
                  }}
                />
              </span>
            )}

            {c.filterable && (
              <span
                role="button" tabIndex={0}
                onClick={(e) => {
                  e.stopPropagation();
                  if (!isOpen && c.filterable === "status" && filterStatus.size === 0) {
                    setFilterStatus(new Set(DEFAULT_STATUS_FILTER));
                  }
                  setOpenHeader(isOpen ? null : c.filterable!);
                }}
                onKeyDown={(e) => { if (e.key === "Enter") { e.stopPropagation(); if (!isOpen && c.filterable === "status" && filterStatus.size === 0) { setFilterStatus(new Set(DEFAULT_STATUS_FILTER)); } setOpenHeader(isOpen ? null : c.filterable!); } }}
                style={{
                  display: "inline-flex", alignItems: "center", justifyContent: "center",
                  marginLeft: 2, padding: 2, borderRadius: 3,
                  color: hasActiveFilter ? "var(--brand)" : "var(--fg-subtle)",
                  background: hasActiveFilter ? "var(--brand-soft)" : "transparent",
                }}
                aria-label={`筛选${c.label}`}
              >
                <Filter size={11} strokeWidth={2} />
              </span>
            )}
          </div>
        );
      })}
    </div>
  );

  const renderRow = useCallback((m: Model, idx: number) => {
    // 抢先体验（upcoming）不算不可用——授权用户可直接调用，只是多一枚徽标
    const unavailable = ["upgrading", "offline"].includes(m.status);
    const allChips = getTaskChips(m, t);
    const { chips: visibleChips, overflow: overflowCount } = visibleTaskChips(allChips);
    const delay = Math.min(idx * 20, 180);
    const copied = copiedId === m.id;

    const cellBase: CSSProperties = { minWidth: 0, overflow: "hidden" };

    return (
      <div
        key={m.id}
        role="row"
        className="animate-enter model-table-row"
        style={{
          display: "grid", gridTemplateColumns: gridTemplate, gap: 16,
          alignItems: "center",
          padding: "12px 20px",
          cursor: "pointer",
          "--card-delay": `${delay}ms`,
          animationDelay: `${delay}ms`,
          opacity: unavailable ? 0.55 : 1,
          borderBottom: "1px solid var(--border)",
        } as CSSProperties}
        onClick={() => navigate(`/models/${m.id}`)}
      >
        {/* 模型名 + 厂商 icon + id + copy */}
        <div role="cell" style={{ ...cellBase, display: "flex", alignItems: "center", gap: 10 }}>
          <ProviderIcon provider={m.provider} id={m.id} size="sm" />
          <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
            <span
              className="font-serif"
              style={{ fontSize: 15, fontWeight: 500, lineHeight: 1.25, color: "var(--fg)" }}
            >
              {m.name}
            </span>
            <span
              style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
              onClick={(e) => e.stopPropagation()}
            >
              <code style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-muted)" }}>
                {m.id}
              </code>
              <span
                role="button" tabIndex={0}
                onClick={(e) => { e.stopPropagation(); copyId(m.id); }}
                onKeyDown={(e) => { if (e.key === "Enter") { e.stopPropagation(); copyId(m.id); } }}
                aria-label="复制模型 ID"
                style={{
                  display: "inline-flex", alignItems: "center", justifyContent: "center",
                  padding: 1, borderRadius: 3, background: "transparent", border: "none",
                  color: "var(--fg-subtle)", cursor: "pointer",
                }}
              >
                {copied ? <Check size={11} strokeWidth={2} /> : <Copy size={11} strokeWidth={1.8} />}
              </span>
            </span>
          </div>
        </div>

        {/* 模型类别 */}
        <div role="cell" style={cellBase}>
          <span style={{ fontSize: 12.5, color: "var(--fg-muted)" }}>
            {CATEGORY_LABEL[m.category] ?? m.category}
          </span>
        </div>

        {/* 参数量 */}
        <div role="cell" style={cellBase}>
          {m.params && m.params !== "TBD" ? (
            <code style={{ fontFamily: "var(--font-mono)", fontSize: 12.5, color: "var(--fg)" }}>
              {m.params}
            </code>
          ) : (
            <span style={{ color: "var(--fg-subtle)", fontSize: 12 }}>—</span>
          )}
        </div>

        {/* 上下文 */}
        <div role="cell" style={cellBase}>
          {m.contextWindow ? (
            <code style={{ fontFamily: "var(--font-mono)", fontSize: 12.5, color: "var(--fg)" }}>
              {m.contextWindow}
            </code>
          ) : (
            <span style={{ color: "var(--fg-subtle)", fontSize: 12 }}>—</span>
          )}
        </div>

        {/* 发布时间 */}
        <div role="cell" style={cellBase}>
          {m.releaseDate ? (
            <span style={{ fontSize: 12.5, color: "var(--fg-muted)" }}>
              {fmtRelease(m.releaseDate)}
            </span>
          ) : (
            <span style={{ color: "var(--fg-subtle)", fontSize: 12 }}>—</span>
          )}
        </div>

        {/* 能力 chips */}
        <div role="cell" style={{ ...cellBase, display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap" }}>
          {visibleChips.map((chip) => (
            <TaskChipBadge key={chip.key} chip={chip} />
          ))}
          {overflowCount > 0 && (
            <OverflowChipBadge chips={allChips.slice(visibleChips.length)} />
          )}
        </div>

        {/* 状态 */}
        <div role="cell" style={{ ...cellBase, display: "flex", justifyContent: "flex-end", position: "relative" }}>
          <span className="plaza-status-text">
            {m.status === "online" ? (
              <span
                style={{
                  display: "inline-flex", alignItems: "center", gap: 5,
                  fontSize: 11.5, color: "var(--ok)", fontWeight: 500,
                }}
              >
                <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--ok)" }} />
                {t("modelPlaza.status.online")}
              </span>
            ) : m.status !== undefined ? (
              <StatusBadge status={m.status} label={STATUS_LABEL[m.status]} />
            ) : (
              <span style={{ color: "var(--fg-subtle)", fontSize: 12 }}>—</span>
            )}
          </span>
          <span className="plaza-row-arrow" style={{ position: "absolute", right: 0, top: "50%", gap: 5 }}>
            <span style={{ fontSize: 12, fontWeight: 500 }}>{t("docsPage.modelFamily.viewDetail")}</span>
            <ArrowRight size={15} strokeWidth={2} />
          </span>
        </div>
      </div>
    );
  }, [navigate, copiedId, gridTemplate, t, CATEGORY_LABEL, STATUS_LABEL]);

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div>
      {apiError && (
        <div
          style={{
            borderRadius: 10,
            border: "1px solid var(--warn-soft-border)",
            background: "var(--warn-soft)",
            padding: "10px 16px",
            fontSize: 13, color: "var(--warn)",
            marginBottom: 24,
          }}
        >
          {apiError}
        </div>
      )}

      {/* ── 主推模型族 ── */}
      <FeaturedStrip onOpen={(id) => navigate(`/models/${id}`)} onStableClick={() => setStableOpen(true)} />

      {/* Model table */}
      <div
        style={{
          borderRadius: 14,
          border: "1px solid var(--border)",
          background: "var(--card)",
          overflow: "hidden",
        }}
      >
        {renderHeader()}
        {sorted.length === 0 ? (
          <div className="animate-fade" style={{ textAlign: "center", padding: "72px 0" }}>
            <div style={{ fontSize: 34, opacity: 0.15, marginBottom: 10 }}>∅</div>
            <p style={{ fontSize: 13.5, color: "var(--fg-muted)" }}>{t("modelPlaza.empty")}</p>
          </div>
        ) : (
          sorted.map((m, i) => renderRow(m, i))
        )}
      </div>

      {/* 表头筛选下拉(类别 / 状态 / 标签) */}
      {openHeader && panelPos && createPortal(
        <div
          ref={panelRef}
          style={{
            position: "fixed",
            top: panelPos.top, left: panelPos.left,
            zIndex: 9999,
            minWidth: openHeader === "tags" ? 380 : 180,
            maxWidth: openHeader === "tags" ? 520 : undefined,
            borderRadius: 10,
            border: "1px solid var(--border-strong)",
            background: "var(--card)",
            boxShadow: "var(--shadow-pop)",
            padding: 6,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <div
            style={openHeader === "tags" ? {
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))",
              gap: 2,
            } : undefined}
          >
          {(openHeader === "category"
            ? catOptions.map(cat => ({ value: cat, label: CATEGORY_LABEL[cat] ?? cat }))
            : openHeader === "status"
            ? statusOptions.map(st => ({ value: st, label: STATUS_LABEL[st] ?? (st || t("modelPlaza.filter.unknown")) }))
            : allCapabilityTags.map(tag => ({ value: tag, label: tag }))
          ).map(opt => {
            const checked = openHeader === "category"
              ? filterCat.has(opt.value)
              : openHeader === "status"
              ? filterStatus.has(opt.value)
              : filterTags.has(opt.value);
            return (
              <label
                key={opt.value}
                style={{
                  display: "flex", alignItems: "center", gap: 8,
                  padding: "6px 8px", borderRadius: 6,
                  fontSize: 12.5, cursor: "pointer",
                }}
                onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = "var(--bg-soft)"; }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => {
                    if (openHeader === "category") setFilterCat(toggleSet(filterCat, opt.value));
                    else if (openHeader === "status") setFilterStatus(toggleSet(filterStatus, opt.value));
                    else setFilterTags(toggleSet(filterTags, opt.value));
                  }}
                  style={{ accentColor: "var(--brand)", width: 13, height: 13 }}
                />
                {opt.label}
              </label>
            );
          })}
          </div>
          {(openHeader === "category" ? filterCat.size : openHeader === "status" ? filterStatus.size : filterTags.size) > 0 && (
            <div>
              <div style={{ height: 1, background: "var(--border)", margin: "4px 0" }} />
              <button
                type="button"
                onClick={() => {
                  if (openHeader === "category") setFilterCat(new Set());
                  else if (openHeader === "status") setFilterStatus(new Set());
                  else setFilterTags(new Set());
                }}
                style={{
                  width: "100%", textAlign: "left",
                  padding: "6px 8px", borderRadius: 6,
                  fontSize: 12, color: "var(--fg-muted)",
                  background: "none", border: "none", cursor: "pointer",
                }}
                onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = "var(--bg-soft)"; }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
              >
                {t("modelPlaza.filter.clear")}
              </button>
            </div>
          )}
        </div>,
        document.body,
      )}

      {/* ── Model assistant ── */}
      <ModelAssistant models={models} />

      {/* STABLE 固定接口说明弹窗 */}
      <StableDialog
        open={stableOpen}
        onOpenChange={setStableOpen}
        sotaResolved={ltsResolve.sota}
        flashResolved={ltsResolve.flash}
        copiedId={copiedId}
        onCopy={copyId}
      />
    </div>
  );
}
