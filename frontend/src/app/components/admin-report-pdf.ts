type ReportExportMeta = {
  label: string;
  kind: string;
  summary_md?: string;
};

function triggerBlobDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** 等待 Recharts SVG 完成布局后再截图。 */
async function waitForCharts(ms = 1200): Promise<void> {
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
  await new Promise((r) => setTimeout(r, ms));
}

function reportExportBasename(label: string, kind: string): string {
  const safe = label.replace(/[^\w\u4e00-\u9fff.-]+/g, "_").slice(0, 80);
  return `Platform_Ops_Report_${kind}_${safe || "report"}`;
}

export function reportPdfFilename(label: string, kind: string): string {
  return `${reportExportBasename(label, kind)}.pdf`;
}

/** 下载 Markdown 摘要（服务端 summary_md）。 */
export function downloadReportMarkdown(report: ReportExportMeta): void {
  const body = (report.summary_md || "").trim();
  if (!body) throw new Error("报告 Markdown 内容为空");
  const blob = new Blob([body], { type: "text/markdown;charset=utf-8" });
  triggerBlobDownload(blob, `${reportExportBasename(report.label, report.kind)}.md`);
}

/** 下载完整 JSON 数据，便于存档或二次分析。 */
export function downloadReportJson(report: Record<string, unknown>): void {
  const label = String(report.label ?? "report");
  const kind = String(report.kind ?? "custom");
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json;charset=utf-8" });
  triggerBlobDownload(blob, `${reportExportBasename(label, kind)}.json`);
}

/** 将 DOM 节点渲染为多页 A4 PDF 并触发下载（按需加载 html2canvas / jspdf）。 */
export async function downloadElementAsPdf(element: HTMLElement, filename: string): Promise<void> {
  element.scrollIntoView({ block: "start" });
  await waitForCharts(1600);

  const [{ default: html2canvas }, { jsPDF }] = await Promise.all([
    import("html2canvas"),
    import("jspdf"),
  ]);

  const canvas = await html2canvas(element, {
    scale: 2,
    useCORS: true,
    logging: false,
    backgroundColor: "#ffffff",
    width: element.scrollWidth,
    height: element.scrollHeight,
    windowWidth: element.scrollWidth,
    windowHeight: element.scrollHeight,
    onclone: (doc) => {
      const root = doc.getElementById("ops-report-export-root");
      if (root) {
        root.style.boxShadow = "none";
        root.style.borderRadius = "0";
        root.style.maxWidth = "none";
      }
      doc.querySelectorAll("svg").forEach((svg) => {
        const box = svg.getBoundingClientRect();
        if (box.width > 0 && box.height > 0) {
          svg.setAttribute("width", String(box.width));
          svg.setAttribute("height", String(box.height));
        }
      });
    },
  });
  const imgData = canvas.toDataURL("image/png", 1.0);
  const pdf = new jsPDF({ orientation: "portrait", unit: "pt", format: "a4" });
  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();
  const margin = 24;
  const imgWidth = pageWidth - margin * 2;
  const imgHeight = (canvas.height * imgWidth) / canvas.width;

  let heightLeft = imgHeight;
  let position = margin;

  pdf.addImage(imgData, "PNG", margin, position, imgWidth, imgHeight);
  heightLeft -= pageHeight - margin * 2;

  while (heightLeft > 0) {
    pdf.addPage();
    position = margin - (imgHeight - heightLeft);
    pdf.addImage(imgData, "PNG", margin, position, imgWidth, imgHeight);
    heightLeft -= pageHeight - margin * 2;
  }

  pdf.save(filename.endsWith(".pdf") ? filename : `${filename}.pdf`);
}
