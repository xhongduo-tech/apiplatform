import {
  Flame, Eye, MessageCircle, CheckCircle2,
  MessageCircleQuestion, TrendingUp, Timer,
} from "lucide-react";
import { useT } from "../i18n";
import type { ForumOverview } from "./forum-utils";

interface HotSidebarProps {
  overview: ForumOverview | null;
  onSelect: (id: string) => void;
}

/** 平均响应时长（小时）→ 人话。不足 1 小时用分钟，其余保留 1 位小数。 */
function formatResponse(hours: number | null, t: (k: any, p?: any) => string): string {
  if (hours == null) return "—";
  if (hours < 1) {
    const mins = Math.max(1, Math.round(hours * 60));
    return t("forum.stats.minutes", { n: String(mins) });
  }
  const val = hours % 1 === 0 ? String(hours) : hours.toFixed(1);
  return t("forum.stats.hours", { n: val });
}

export function HotSidebar({ overview, onSelect }: HotSidebarProps) {
  const { t } = useT();
  const hot = overview?.hot ?? [];

  return (
    <div className="space-y-6">
      {/* 社区动态 */}
      {overview && (
        <div className="rounded-xl bg-card border border-border p-4">
          <h3 className="mb-4 flex items-center gap-1.5 font-serif text-[16px] font-medium tracking-normal text-fg">
            <TrendingUp size={15} className="text-fg-subtle" />{t("forum.stats.title")}
          </h3>
          <div className="space-y-3.5">
            <div className="flex items-center justify-between">
              <span className="text-[13px] text-fg-muted inline-flex items-center gap-1.5">
                <MessageCircleQuestion size={13} className="text-fg-subtle" />{t("forum.stats.pending")}
              </span>
              <span className="tabular-nums text-fg font-bold text-[20px] leading-none">{overview.pending}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[13px] text-fg-muted inline-flex items-center gap-1.5">
                <TrendingUp size={13} className="text-fg-subtle" />{t("forum.stats.recentNew")}
              </span>
              <span className="tabular-nums text-fg font-bold text-[20px] leading-none">{overview.recent7_new}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[13px] text-fg-muted inline-flex items-center gap-1.5">
                <Timer size={13} className="text-fg-subtle" />{t("forum.stats.avgResponse")}
              </span>
              <span className="tabular-nums text-fg font-bold text-[20px] leading-none">
                {formatResponse(overview.avg_response_hours, t)}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* 热门问题 */}
      <div className="rounded-xl bg-card border border-border p-4">
        <h3 className="mb-4 flex items-center gap-1.5 font-serif text-[16px] font-medium tracking-normal text-fg">
          <Flame size={15} className="text-warn" />{t("forum.hot.title")}
        </h3>

        {hot.length > 0 ? (
          <ul className="space-y-0.5">
            {hot.map((hp, idx) => (
              <li key={hp.id}>
                <button
                  type="button"
                  onClick={() => onSelect(hp.id)}
                  className="w-full text-left group py-2.5 -mx-2 px-2 rounded-lg hover:bg-secondary transition-colors"
                >
                  <div className="flex items-start gap-2.5">
                    <span className={`text-[14px] tabular-nums mt-0.5 shrink-0 w-5 font-bold ${
                      idx < 3 ? "text-warn" : "text-fg-muted"
                    }`}>
                      {idx + 1}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="line-clamp-2 text-[14px] font-serif font-medium leading-snug text-fg transition-colors group-hover:text-brand">
                        {hp.title}
                      </p>
                      <div className="flex items-center gap-2.5 mt-1.5 text-[12px] text-fg-subtle">
                        <span className="inline-flex items-center gap-1"><Eye size={12} />{hp.view_count}</span>
                        <span className="inline-flex items-center gap-1"><MessageCircle size={12} />{hp.reply_count}</span>
                        {hp.resolved && (
                          <span className="inline-flex items-center gap-0.5 text-ok">
                            <CheckCircle2 size={11} />{t("forum.badge.solved")}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <div className="py-6 text-center">
            <Flame size={22} className="mx-auto text-fg-subtle mb-2" />
            <p className="text-[13px] text-fg-subtle leading-relaxed">
              {t("forum.hot.empty")}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
