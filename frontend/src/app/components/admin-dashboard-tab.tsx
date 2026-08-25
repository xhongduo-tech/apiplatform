import { useCallback, useState } from "react";
import { RefreshCw, FileText } from "lucide-react";
import type { HeatmapMode } from "../api/gateway";
import { useT } from "../i18n";
import { useUsageDashboardData } from "../hooks/use-usage-dashboard-data";
import { UsageDashboardPanel } from "./usage-dashboard-panel";
import { AdminReportDialog } from "./admin-report-dialog";
import { ADMIN_LOGS_FILTERS_KEY, ADMIN_NAV_TAB_EVENT } from "./admin-tab-utils";
import { PageHeader } from "./ui/page-header";
import type { FiltersState } from "./logs/shared/types";

export default function DashboardTab({ token }: { token: string }) {
  const { t } = useT();
  const dashboard = useUsageDashboardData("admin", token);
  const [reportOpen, setReportOpen] = useState(false);

  const handleRefresh = () => {
    dashboard.reloadAll();
  };

  const handleHeatmapCellClick = useCallback((ctx: {
    mode: HeatmapMode; row: number; col: number; value: number; date: string;
  }) => {
    if (ctx.value === 0) return;
    const filters: Partial<FiltersState> = {};
    if (ctx.mode === "week") {
      filters.dateFrom = ctx.date;
      filters.dateTo = ctx.date;
    } else {
      filters.dateFrom = ctx.date;
      filters.dateTo = ctx.date;
    }
    try {
      sessionStorage.setItem(ADMIN_LOGS_FILTERS_KEY, JSON.stringify(filters));
    } catch { /* ignore */ }
    window.dispatchEvent(new CustomEvent(ADMIN_NAV_TAB_EVENT, { detail: { tab: "logs" } }));
  }, []);

  return (
    <>
      <PageHeader
        title={t("admin.nav.dashboard")}
        description={t("admin.nav.dashboard.desc")}
        actions={
          <>
            <button
              type="button"
              onClick={handleRefresh}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-[12px] text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${dashboard.loading ? "animate-spin" : ""}`} />
              {t("admin.dashboard.refresh")}
            </button>
            <button
              type="button"
              onClick={() => setReportOpen(true)}
              className="flex items-center gap-1.5 rounded-xl bg-primary px-3.5 py-1.5 text-[12px] font-medium text-primary-foreground transition-opacity hover:opacity-90"
            >
              <FileText className="w-3.5 h-3.5" />
              {t("admin.dashboard.reportBtn")}
            </button>
          </>
        }
      />

      <UsageDashboardPanel
        data={dashboard}
        token={token}
        onHeatmapCellClick={handleHeatmapCellClick}
      />

      <AdminReportDialog open={reportOpen} onClose={() => setReportOpen(false)} token={token} />
    </>
  );
}
