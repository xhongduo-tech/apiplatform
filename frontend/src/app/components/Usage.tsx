import { useCallback } from "react";
import { useNavigate } from "react-router-dom";
import type { HeatmapMode } from "../api/gateway";
import { PAGE_TITLE_CLASS } from "./ui/utils";
import { useAuth } from "../hooks/use-auth";
import { useT } from "../i18n";
import { ConsolePageShell } from "./console-page-shell";
import { useUsageDashboardData } from "../hooks/use-usage-dashboard-data";
import { UsageDashboardPanel } from "./usage-dashboard-panel";

export function Usage() {
  const { token, name, department } = useAuth();
  const { t } = useT();
  const navigate = useNavigate();
  const dashboard = useUsageDashboardData("user", token);

  const handleHeatmapCellClick = useCallback((ctx: {
    mode: HeatmapMode; row: number; col: number; value: number; date: string;
  }) => {
    if (ctx.value === 0) return;
    if (ctx.mode === "week") {
      const params = new URLSearchParams({ wd: String(ctx.row), h: String(ctx.col) });
      navigate(`/logs?${params.toString()}`);
      return;
    }
    const params = new URLSearchParams({ date_from: ctx.date, date_to: ctx.date });
    navigate(`/logs?${params.toString()}`);
  }, [navigate]);

  return (
    <ConsolePageShell className="space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap apiplatform-fade-slide-up">
        <div>
          <div className="flex items-center gap-3 mb-1">
            <h1 className={PAGE_TITLE_CLASS}>{t("usage.title")}</h1>
          </div>
          <p className="text-[13px] text-muted-foreground">
            {name}{department ? ` · ${department}` : ""}
          </p>
        </div>
      </div>

      <UsageDashboardPanel
        data={dashboard}
        token={token!}
        onHeatmapCellClick={handleHeatmapCellClick}
        showEmptyState
      />
    </ConsolePageShell>
  );
}
