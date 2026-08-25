import { useState, useRef, useMemo } from "react";
import { Loader2, FileText, X } from "lucide-react";
import { toast } from "sonner";
import { ModalPortal } from "./admin-tab-utils";
import {
  OpsReportDocument,
  ReportDownloadBar,
  adminReportFetch,
  useReportKinds,
  useKindLabel,
  type ReportDetailData,
} from "./admin-reports-tab";
import { useT } from "../i18n";

function fmtStr(template: string, replacements: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, key) => String(replacements[key] ?? `{${key}}`));
}

export function AdminReportDialog({
  open,
  onClose,
  token,
}: {
  open: boolean;
  onClose: () => void;
  token: string;
}) {
  const { t } = useT();
  const reportKinds = useReportKinds(t);
  const kindLabelFromT = useKindLabel(t);
  const [selectedKind, setSelectedKind] = useState<string>("weekly");
  const [report, setReport] = useState<ReportDetailData | null>(null);
  const [generating, setGenerating] = useState(false);
  const exportRef = useRef<HTMLDivElement>(null);

  async function generate() {
    setGenerating(true);
    setReport(null);
    try {
      const data = await adminReportFetch<ReportDetailData>(
        token,
        "/api/admin/reports/generate",
        { method: "POST", body: JSON.stringify({ kind: selectedKind }) },
        t("auth.sessionExpired"),
      );
      setReport(data);
      toast.success(fmtStr(t("report.generated"), { kind: kindLabelFromT[selectedKind] }));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("report.generateFailed"));
    } finally {
      setGenerating(false);
    }
  }

  const kindLabel = useMemo(() => kindLabelFromT[selectedKind] ?? selectedKind, [kindLabelFromT, selectedKind]);

  return (
    <ModalPortal open={open} onClose={onClose} zIndex={10060}>
      <div
        className="relative flex max-h-[min(92vh,920px)] w-full max-w-[960px] flex-col overflow-hidden rounded-2xl border border-border/50 bg-card shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-start justify-between gap-4 border-b border-border/40 px-5 py-4 sm:px-6">
          <div>
            <h2 className="font-serif text-[16px] font-medium text-foreground">{t("admin.dashboard.reportDialog.title")}</h2>
            <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">{t("admin.dashboard.reportDialog.desc")}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-2 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
            aria-label={t("docsPage.modal.close")}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4 sm:px-6">
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {reportKinds.map((k) => {
              const active = selectedKind === k.key;
              return (
                <button
                  key={k.key}
                  type="button"
                  onClick={() => setSelectedKind(k.key)}
                  className={`rounded-xl border px-3.5 py-3 text-left transition-all ${
                    active
                      ? "border-primary bg-primary/5 ring-1 ring-primary/20"
                      : "border-border/40 bg-background hover:border-border"
                  }`}
                >
                  <div className="font-serif text-[13px] font-medium">{k.label}</div>
                  <div className="mt-0.5 text-[11px] text-muted-foreground line-clamp-2">{k.desc}</div>
                </button>
              );
            })}
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button
              type="button"
              disabled={generating}
              onClick={generate}
              className="flex items-center gap-2 rounded-xl bg-primary px-5 py-2.5 text-[13px] font-medium text-primary-foreground hover:opacity-90 disabled:opacity-60"
            >
              {generating ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />}
              {generating ? t("report.generating") : fmtStr(t("report.generate"), { kind: kindLabel })}
            </button>
          </div>

          {report && !generating && (
            <div className="mt-4">
              <ReportDownloadBar report={report} exportRef={exportRef} />
            </div>
          )}

          {generating && (
            <div className="mt-6 flex min-h-[240px] items-center justify-center rounded-2xl border border-dashed border-border/50 bg-secondary/20">
              <div className="text-center">
                <Loader2 className="mx-auto h-8 w-8 animate-spin text-primary" />
                <p className="mt-3 text-[13px] text-muted-foreground">{t("report.loading")}</p>
              </div>
            </div>
          )}

          {!generating && report && (
            <div id="ops-report-export-root" ref={exportRef} className="mt-5 pb-2">
              <OpsReportDocument d={report} />
            </div>
          )}

          {!generating && !report && (
            <div className="mt-6 flex min-h-[180px] flex-col items-center justify-center rounded-2xl border border-dashed border-border/40 bg-secondary/10 px-6 text-center">
              <FileText className="h-9 w-9 text-muted-foreground/30" />
              <p className="mt-3 text-[13px] text-muted-foreground">{t("report.emptyHint")}</p>
            </div>
          )}
        </div>
      </div>
    </ModalPortal>
  );
}
