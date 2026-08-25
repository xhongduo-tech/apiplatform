import { useMemo, useState } from "react";
import { Lock, Search, X, ChevronDown, ArrowUpRight } from "lucide-react";
import { DocsSection } from "./docs-section";
import { useT, type TranslationKey } from "../../i18n";
import { ENDPOINT_ANCHORS } from "./docs-constants";
import { methodBadgeColor } from "./docs-shared";

interface EndpointItem {
  method?: string;
  path?: string;
  key: TranslationKey;
  locked?: boolean;
}

interface EndpointGroup {
  section: TranslationKey;
  id: string;
  items: EndpointItem[];
}

export function DocsEndpointsTable() {
  const { t } = useT();
  const [filter, setFilter] = useState("");

  const groups: EndpointGroup[] = useMemo(
    () => [
      {
        section: "docsPage.reference.endpoints.sectionInference",
        id: "endpoints-inference",
        items: [
          { method: "POST", path: "/v1/chat/completions", key: "docsPage.reference.endpoints.chatCompletions", locked: true },
          { method: "POST", path: "/beta/v1/chat/completions", key: "docsPage.reference.endpoints.betaChatCompletions", locked: true },
          { method: "POST", path: "/v1/completions", key: "docsPage.reference.endpoints.completions", locked: true },
          { method: "POST", path: "/v1/embeddings", key: "docsPage.reference.endpoints.embeddings", locked: true },
          { method: "POST", path: "/v1/responses", key: "docsPage.reference.endpoints.responses", locked: true },
          { method: "POST", path: "/v1/rerank", key: "docsPage.reference.endpoints.rerank", locked: true },
          { method: "POST", path: "/v1/images/generations", key: "docsPage.reference.endpoints.imageGenerations", locked: true },
          { method: "POST", path: "/v1/ocr", key: "docsPage.reference.endpoints.ocr", locked: true },
          { method: "POST", path: "/v1/messages", key: "docsPage.reference.endpoints.messages", locked: true },
          { method: "POST", path: "/v1/messages/count_tokens", key: "docsPage.reference.endpoints.countTokens", locked: true },
          { method: "GET", path: "/v1/models", key: "docsPage.reference.endpoints.models", locked: true },
          { method: "GET", path: "/v1/models/{model_id}", key: "docsPage.reference.endpoints.modelDetail", locked: true },
        ],
      },
      {
        section: "docsPage.reference.endpoints.sectionPublic",
        id: "endpoints-public",
        items: [
          { method: "GET", path: "/api/public/config", key: "docsPage.reference.endpoints.publicConfig" },
          { method: "GET", path: "/api/public/platform-status", key: "docsPage.reference.endpoints.publicStatus" },
          { method: "GET", path: "/api/public/platform-status/breakdown", key: "docsPage.reference.endpoints.publicStatusBreakdown" },
          { method: "GET", path: "/api/public/platform-status/tool-calls", key: "docsPage.reference.endpoints.publicStatusToolCalls" },
          { method: "GET", path: "/api/public/platform-status/context-length", key: "docsPage.reference.endpoints.publicStatusContextLength" },
          { method: "GET", path: "/api/public/platform-status/heatmap", key: "docsPage.reference.endpoints.publicStatusHeatmap" },
          { method: "GET", path: "/api/public/scene-types", key: "docsPage.reference.endpoints.publicSceneTypes" },
          { method: "GET", path: "/api/public/models", key: "docsPage.reference.endpoints.publicModels" },
          { method: "GET", path: "/api/public/models/{model_id}", key: "docsPage.reference.endpoints.publicModelDetail" },
          { method: "GET", path: "/api/public/notifications", key: "docsPage.reference.endpoints.notifications" },
          { method: "POST", path: "/api/public/doc-feedback", key: "docsPage.reference.endpoints.docFeedback" },
          { method: "GET", path: "/api/forum/overview", key: "docsPage.reference.endpoints.userForumOverview" },
          { method: "GET", path: "/api/forum/posts", key: "docsPage.reference.endpoints.userForumPosts" },
          { method: "GET", path: "/api/forum/posts/{post_id}", key: "docsPage.reference.endpoints.userForumPostDetail" },
        ],
      },
      {
        section: "docsPage.reference.endpoints.sectionUser",
        id: "endpoints-user",
        items: [
          { method: "POST", path: "/api/apply", key: "docsPage.reference.endpoints.apply", locked: true },
          { method: "GET", path: "/api/apply/rate", key: "docsPage.reference.endpoints.applyRate", locked: true },
          { method: "POST", path: "/api/apply/upgrade", key: "docsPage.reference.endpoints.upgradeApply", locked: true },
          { method: "GET", path: "/api/apply/upgrade", key: "docsPage.reference.endpoints.upgradeApply", locked: true },
          { method: "PATCH", path: "/api/apply/upgrade/{app_id}", key: "docsPage.reference.endpoints.upgradeApply", locked: true },
          { method: "DELETE", path: "/api/apply/upgrade/{app_id}", key: "docsPage.reference.endpoints.upgradeApply", locked: true },
          { method: "GET", path: "/api/user/early-access", key: "docsPage.reference.endpoints.userEarlyAccess", locked: true },
          { method: "POST", path: "/api/user/early-access", key: "docsPage.reference.endpoints.userEarlyAccess", locked: true },
          { method: "GET", path: "/api/user/stats", key: "docsPage.reference.endpoints.userStats", locked: true },
          { method: "GET", path: "/api/user/stats/yearly", key: "docsPage.reference.endpoints.userStats", locked: true },
          { method: "GET", path: "/api/user/stats/daily", key: "docsPage.reference.endpoints.userStats", locked: true },
          { method: "GET", path: "/api/user/stats/models", key: "docsPage.reference.endpoints.userStats", locked: true },
          { method: "GET", path: "/api/user/stats/projects", key: "docsPage.reference.endpoints.userStats", locked: true },
          { method: "GET", path: "/api/user/stats/scenes", key: "docsPage.reference.endpoints.userStatsScenes", locked: true },
          { method: "GET", path: "/api/user/stats/breakdown", key: "docsPage.reference.endpoints.userStatsBreakdown", locked: true },
          { method: "GET", path: "/api/user/stats/timeseries", key: "docsPage.reference.endpoints.userStats", locked: true },
          { method: "GET", path: "/api/user/stats/context-length", key: "docsPage.reference.endpoints.userStats", locked: true },
          { method: "GET", path: "/api/user/stats/tool-calls", key: "docsPage.reference.endpoints.userStatsToolCalls", locked: true },
          { method: "GET", path: "/api/user/stats/heatmap", key: "docsPage.reference.endpoints.userStats", locked: true },
          { method: "GET", path: "/api/user/stats/heatmap/week", key: "docsPage.reference.endpoints.userStatsHeatmapWeek", locked: true },
          { method: "GET", path: "/api/user/logs", key: "docsPage.reference.endpoints.userLogs", locked: true },
          { method: "GET", path: "/api/user/logs/stats", key: "docsPage.reference.endpoints.userLogs", locked: true },
          { method: "GET", path: "/api/user/rate-limits", key: "docsPage.reference.endpoints.userRateLimits", locked: true },
          { method: "POST", path: "/api/user/keys", key: "docsPage.reference.endpoints.userKeys", locked: true },
          { method: "POST", path: "/api/user/keys/{key_id}/claim", key: "docsPage.reference.endpoints.userKeyClaim", locked: true },
          { method: "PATCH", path: "/api/user/keys/{key_id}", key: "docsPage.reference.endpoints.userKeys", locked: true },
          { method: "DELETE", path: "/api/user/keys/{key_id}", key: "docsPage.reference.endpoints.userKeys", locked: true },
          { method: "POST", path: "/api/user/keys/{key_id}/regenerate", key: "docsPage.reference.endpoints.userKeyRegenerate", locked: true },
          { method: "POST", path: "/api/user/keys/{key_id}/tier", key: "docsPage.reference.endpoints.userKeyTier", locked: true },
          { method: "POST", path: "/api/user/usage", key: "docsPage.reference.endpoints.userKeyUsage", locked: true },
          { method: "POST", path: "/api/user/logs", key: "docsPage.reference.endpoints.userKeyUsage", locked: true },
          { method: "POST", path: "/api/ask-docs", key: "docsPage.reference.endpoints.askDocs", locked: true },
          { method: "POST", path: "/api/ask-docs/stream", key: "docsPage.reference.endpoints.askDocs", locked: true },
        ],
      },
      {
        section: "docsPage.reference.endpoints.sectionForum",
        id: "endpoints-forum",
        items: [
          { method: "POST", path: "/api/forum/posts", key: "docsPage.reference.endpoints.userForumCreatePost", locked: true },
          { method: "POST", path: "/api/forum/posts/{post_id}/replies", key: "docsPage.reference.endpoints.userForumReply", locked: true },
          { method: "POST", path: "/api/forum/posts/{post_id}/like", key: "docsPage.reference.endpoints.userForumLike", locked: true },
          { method: "POST", path: "/api/forum/posts/{post_id}/follow", key: "docsPage.reference.endpoints.userForumFollow", locked: true },
          { method: "POST", path: "/api/forum/posts/{post_id}/resolve", key: "docsPage.reference.endpoints.userForumResolve", locked: true },
          { method: "POST", path: "/api/forum/posts/{post_id}/pin", key: "docsPage.reference.endpoints.userForumPin", locked: true },
        ],
      },
      {
        section: "docsPage.reference.endpoints.sectionAdmin",
        id: "endpoints-admin",
        items: [
          { method: "POST", path: "/api/admin/login", key: "docsPage.reference.endpoints.adminLogin" },
          { method: "GET", path: "/api/admin/models", key: "docsPage.reference.endpoints.adminModels", locked: true },
          { method: "PUT", path: "/api/admin/models/{model_id}", key: "docsPage.reference.endpoints.adminModels", locked: true },
          { method: "PATCH", path: "/api/admin/models/{model_id}", key: "docsPage.reference.endpoints.adminModels", locked: true },
          { method: "DELETE", path: "/api/admin/models/{model_id}", key: "docsPage.reference.endpoints.adminModels", locked: true },
          { method: "POST", path: "/api/admin/models/sync", key: "docsPage.reference.endpoints.adminModels", locked: true },
          { method: "POST", path: "/api/admin/models/{model_id}/launch", key: "docsPage.reference.endpoints.adminModels", locked: true },
          { method: "GET", path: "/api/admin/models/circuits", key: "docsPage.reference.endpoints.adminFallback", locked: true },
          { method: "POST", path: "/api/admin/models/{model_id}/circuit/close", key: "docsPage.reference.endpoints.adminFallback", locked: true },
          { method: "POST", path: "/api/admin/models/{model_id}/connectivity-test", key: "docsPage.reference.endpoints.adminConnectivityTest", locked: true },
          { method: "GET", path: "/api/admin/fallback/policy", key: "docsPage.reference.endpoints.adminFallback", locked: true },
          { method: "PUT", path: "/api/admin/fallback/policy", key: "docsPage.reference.endpoints.adminFallback", locked: true },
          { method: "GET", path: "/api/admin/fallback/logs", key: "docsPage.reference.endpoints.adminFallback", locked: true },
          { method: "GET", path: "/api/admin/keys", key: "docsPage.reference.endpoints.adminKeys", locked: true },
          { method: "POST", path: "/api/admin/keys", key: "docsPage.reference.endpoints.adminKeys", locked: true },
          { method: "PATCH", path: "/api/admin/keys/{key_id}", key: "docsPage.reference.endpoints.adminKeys", locked: true },
          { method: "POST", path: "/api/admin/keys/{key_id}/regenerate", key: "docsPage.reference.endpoints.adminKeys", locked: true },
          { method: "POST", path: "/api/admin/keys/{key_id}/limits", key: "docsPage.reference.endpoints.adminKeys", locked: true },
          { method: "POST", path: "/api/admin/keys/{key_id}/revoke", key: "docsPage.reference.endpoints.adminKeys", locked: true },
          { method: "POST", path: "/api/admin/keys/{key_id}/restore", key: "docsPage.reference.endpoints.adminKeys", locked: true },
          { method: "DELETE", path: "/api/admin/keys/{key_id}", key: "docsPage.reference.endpoints.adminKeys", locked: true },
          { method: "GET", path: "/api/admin/scene-types", key: "docsPage.reference.endpoints.adminSceneTypes", locked: true },
          { method: "POST", path: "/api/admin/scene-types", key: "docsPage.reference.endpoints.adminSceneTypes", locked: true },
          { method: "PUT", path: "/api/admin/scene-types/{key}", key: "docsPage.reference.endpoints.adminSceneTypes", locked: true },
          { method: "DELETE", path: "/api/admin/scene-types/{key}", key: "docsPage.reference.endpoints.adminSceneTypes", locked: true },
          { method: "GET", path: "/api/admin/applications", key: "docsPage.reference.endpoints.adminApplications", locked: true },
          { method: "POST", path: "/api/admin/applications/{app_id}/approve", key: "docsPage.reference.endpoints.adminApplications", locked: true },
          { method: "POST", path: "/api/admin/applications/{app_id}/reject", key: "docsPage.reference.endpoints.adminApplications", locked: true },
          { method: "GET", path: "/api/admin/upgrade-applications", key: "docsPage.reference.endpoints.adminUpgradeApps", locked: true },
          { method: "POST", path: "/api/admin/upgrade-applications/{app_id}/approve", key: "docsPage.reference.endpoints.adminUpgradeApps", locked: true },
          { method: "POST", path: "/api/admin/upgrade-applications/{app_id}/reject", key: "docsPage.reference.endpoints.adminUpgradeApps", locked: true },
          { method: "GET", path: "/api/admin/early-access", key: "docsPage.reference.endpoints.adminEarlyAccess", locked: true },
          { method: "POST", path: "/api/admin/early-access/{app_id}/approve", key: "docsPage.reference.endpoints.adminEarlyAccess", locked: true },
          { method: "POST", path: "/api/admin/early-access/{app_id}/reject", key: "docsPage.reference.endpoints.adminEarlyAccess", locked: true },
          { method: "POST", path: "/api/admin/early-access/{app_id}/revoke", key: "docsPage.reference.endpoints.adminEarlyAccess", locked: true },
          { method: "GET", path: "/api/admin/users", key: "docsPage.reference.endpoints.adminUsers", locked: true },
          { method: "POST", path: "/api/admin/users", key: "docsPage.reference.endpoints.adminUsers", locked: true },
          { method: "PUT", path: "/api/admin/users/{user_id}", key: "docsPage.reference.endpoints.adminUsers", locked: true },
          { method: "POST", path: "/api/admin/users/{user_id}/reset-password", key: "docsPage.reference.endpoints.adminUsers", locked: true },
          { method: "DELETE", path: "/api/admin/users/{user_id}", key: "docsPage.reference.endpoints.adminUsers", locked: true },
          { method: "GET", path: "/api/admin/stats/daily", key: "docsPage.reference.endpoints.adminStatsDaily", locked: true },
          { method: "GET", path: "/api/admin/stats/monthly", key: "docsPage.reference.endpoints.adminStatsMonthly", locked: true },
          { method: "GET", path: "/api/admin/stats/by_model", key: "docsPage.reference.endpoints.adminStatsByModel", locked: true },
          { method: "GET", path: "/api/admin/stats/by_project", key: "docsPage.reference.endpoints.adminStatsByProject", locked: true },
          { method: "GET", path: "/api/admin/stats/by_scene", key: "docsPage.reference.endpoints.adminStatsExtended", locked: true },
          { method: "GET", path: "/api/admin/stats/by_user", key: "docsPage.reference.endpoints.adminStatsByUser", locked: true },
          { method: "GET", path: "/api/admin/stats/breakdown", key: "docsPage.reference.endpoints.adminStatsExtended", locked: true },
          { method: "GET", path: "/api/admin/stats/overview", key: "docsPage.reference.endpoints.adminStatsOverview", locked: true },
          { method: "GET", path: "/api/admin/stats/summary", key: "docsPage.reference.endpoints.adminStatsExtended", locked: true },
          { method: "GET", path: "/api/admin/stats/timeseries", key: "docsPage.reference.endpoints.adminStatsExtended", locked: true },
          { method: "GET", path: "/api/admin/stats/health", key: "docsPage.reference.endpoints.adminStatsExtended", locked: true },
          { method: "GET", path: "/api/admin/stats/tool-calls", key: "docsPage.reference.endpoints.adminStatsExtended", locked: true },
          { method: "GET", path: "/api/admin/stats/context-length", key: "docsPage.reference.endpoints.adminStatsExtended", locked: true },
          { method: "GET", path: "/api/admin/stats/heatmap/week", key: "docsPage.reference.endpoints.adminStatsExtended", locked: true },
          { method: "GET", path: "/api/admin/usage", key: "docsPage.reference.endpoints.adminUsage", locked: true },
          { method: "GET", path: "/api/admin/usage/stats", key: "docsPage.reference.endpoints.adminUsageStats", locked: true },
          { method: "GET", path: "/api/admin/usage/stream", key: "docsPage.reference.endpoints.adminUsageStream", locked: true },
          { method: "GET", path: "/api/admin/infra/top-projects", key: "docsPage.reference.endpoints.adminInfra", locked: true },
          { method: "GET", path: "/api/admin/infra/resources", key: "docsPage.reference.endpoints.adminInfra", locked: true },
          { method: "POST", path: "/api/admin/infra/resources", key: "docsPage.reference.endpoints.adminInfra", locked: true },
          { method: "DELETE", path: "/api/admin/infra/resources/{resource_id}", key: "docsPage.reference.endpoints.adminInfra", locked: true },
          { method: "GET", path: "/api/admin/infra/fleet", key: "docsPage.reference.endpoints.adminInfra", locked: true },
          { method: "GET", path: "/api/admin/reports", key: "docsPage.reference.endpoints.adminReports", locked: true },
          { method: "GET", path: "/api/admin/reports/{report_id}", key: "docsPage.reference.endpoints.adminReportDetail", locked: true },
          { method: "POST", path: "/api/admin/reports/generate", key: "docsPage.reference.endpoints.adminReports", locked: true },
          { method: "GET", path: "/api/admin/audit-logs", key: "docsPage.reference.endpoints.adminAudit", locked: true },
          { method: "GET", path: "/api/admin/backup/dump", key: "docsPage.reference.endpoints.adminMigration", locked: true },
          { method: "GET", path: "/api/admin/backup/export", key: "docsPage.reference.endpoints.adminMigration", locked: true },
          { method: "GET", path: "/api/admin/backup/status", key: "docsPage.reference.endpoints.adminMigration", locked: true },
          { method: "GET", path: "/api/admin/migration/baseline", key: "docsPage.reference.endpoints.adminMigration", locked: true },
          { method: "PUT", path: "/api/admin/migration/baseline", key: "docsPage.reference.endpoints.adminMigrationBaseline", locked: true },
          { method: "GET", path: "/api/admin/notifications", key: "docsPage.reference.endpoints.adminContent", locked: true },
          { method: "POST", path: "/api/admin/notifications", key: "docsPage.reference.endpoints.adminContent", locked: true },
          { method: "DELETE", path: "/api/admin/notifications/{notification_id}", key: "docsPage.reference.endpoints.adminContent", locked: true },
          { method: "GET", path: "/api/admin/ask-docs-config", key: "docsPage.reference.endpoints.adminAskDocs", locked: true },
          { method: "PUT", path: "/api/admin/ask-docs-config", key: "docsPage.reference.endpoints.adminAskDocs", locked: true },
          { method: "GET", path: "/api/admin/doc-feedback", key: "docsPage.reference.endpoints.adminDocFeedback", locked: true },
        ],
      },
      {
        section: "docsPage.reference.endpoints.sectionNightBatch",
        id: "endpoints-night-batch",
        items: [
          { method: "GET", path: "/api/night-batch", key: "docsPage.reference.endpoints.nightBatch", locked: true },
          { method: "POST", path: "/api/night-batch", key: "docsPage.reference.endpoints.nightBatch", locked: true },
          { method: "PATCH", path: "/api/night-batch/{reg_id}", key: "docsPage.reference.endpoints.nightBatchPatch", locked: true },
          { method: "DELETE", path: "/api/night-batch/{reg_id}", key: "docsPage.reference.endpoints.nightBatch", locked: true },
          { method: "PATCH", path: "/api/night-batch/series/{series_id}", key: "docsPage.reference.endpoints.nightBatchPatch", locked: true },
          { method: "DELETE", path: "/api/night-batch/series/{series_id}", key: "docsPage.reference.endpoints.nightBatchSeries", locked: true },
        ],
      },
    ],
    [],
  );

  const q = filter.trim().toLowerCase();

  const filteredGroups = useMemo(() => {
    if (!q) return groups.map((g) => ({ ...g, items: g.items, sectionLabel: t(g.section), visible: true }));
    return groups
      .map((g) => {
        const sectionLabel = t(g.section);
        const sectionMatch = sectionLabel.toLowerCase().includes(q);
        const items = g.items.filter((ep) => {
          const desc = t(ep.key).toLowerCase();
          return (
            (ep.method?.toLowerCase() ?? "").includes(q) ||
            (ep.path?.toLowerCase() ?? "").includes(q) ||
            desc.includes(q)
          );
        });
        return { ...g, items, sectionLabel, visible: sectionMatch || items.length > 0 };
      })
      .filter((g) => g.visible);
  }, [groups, q, t]);

  const [openMap, setOpenMap] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(groups.map((g) => [g.id, true])),
  );

  const totalMatches = useMemo(
    () => filteredGroups.reduce((sum, g) => sum + g.items.length, 0),
    [filteredGroups],
  );

  return (
    <DocsSection
      id="api-reference/endpoints"
      eyebrow={t("docsPage.reference.eyebrow")}
      title={t("docsPage.reference.endpoints.title")}
      desc={t("docsPage.reference.endpoints.desc")}
    >
      <div className="space-y-4">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-fg-subtle" />
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={t("docsPage.reference.endpoints.filterPlaceholder")}
            className="h-9 w-full rounded-lg border border-border bg-card pl-9 pr-8 text-[13px] text-foreground outline-none transition-all placeholder:text-fg-subtle focus:border-primary/60 focus:ring-2 focus:ring-primary/10"
          />
          {filter && (
            <button
              type="button"
              onClick={() => setFilter("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-fg-subtle transition-colors hover:bg-secondary hover:text-foreground"
              aria-label={t("docsPage.search.clear")}
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>

        {q && (
          <p className="text-[12px] text-fg-subtle">
            {t("docsPage.reference.endpoints.matchCount").replace("{count}", String(totalMatches))}
          </p>
        )}

        {filteredGroups.map((group) => {
          const isOpen = q ? true : (openMap[group.id] ?? true);
          return (
            <details
              key={group.id}
              id={group.id}
              className="group overflow-hidden rounded-xl border border-border"
              open={isOpen}
              onToggle={(e) => {
                if (!q) {
                  const isOpen = e.currentTarget.open;
                  setOpenMap((prev) => ({ ...prev, [group.id]: isOpen }));
                }
              }}
            >
              <summary className="docs-endpoints__summary flex cursor-pointer list-none items-center justify-between bg-secondary/40 px-4 py-2.5 text-[12px] font-semibold uppercase tracking-wide text-foreground transition-colors hover:bg-secondary/60">
                <span>{group.sectionLabel}</span>
                <span className="flex items-center gap-2">
                  <span className="text-[11px] tabular-nums text-fg-subtle">
                    {group.items.length}
                  </span>
                  <ChevronDown className="h-4 w-4 text-fg-subtle transition-transform duration-200 group-open:rotate-180" />
                </span>
              </summary>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] text-[13px]">
                  <thead className="sticky top-0 z-10 bg-secondary/90 backdrop-blur">
                    <tr className="border-b border-border">
                      <th className="w-[12%] px-4 py-2 text-left font-semibold text-foreground">
                        {t("docsPage.reference.endpoints.methodHeader")}
                      </th>
                      <th className="px-4 py-2 text-left font-semibold text-foreground">
                        {t("docsPage.reference.endpoints.pathHeader")}
                      </th>
                      <th className="px-4 py-2 text-left font-semibold text-foreground">
                        {t("docsPage.reference.endpoints.descHeader")}
                      </th>
                    </tr>
                  </thead>
                  <tbody className="bg-card">
                    {group.items.map((ep) => (
                      <tr
                        key={`${ep.method}-${ep.path}`}
                        className="even:bg-secondary/20 border-b border-border/50 last:border-b-0"
                      >
                        <td className="px-4 py-2">
                          <span
                            className="rounded px-1.5 py-0.5 text-[11px] font-semibold"
                            style={{ background: methodBadgeColor(ep.method ?? "").bg, color: methodBadgeColor(ep.method ?? "").fg }}
                          >
                            {ep.method}
                          </span>
                        </td>
                        <td className="whitespace-nowrap px-4 py-2">
                          <div className="flex items-center gap-2">
                            {ep.path && ENDPOINT_ANCHORS[ep.path] ? (
                              <a
                                href={`#${ENDPOINT_ANCHORS[ep.path]}`}
                                className="docs-endpoints__path-link inline-flex items-center gap-1 rounded bg-secondary px-1.5 py-0.5 text-[12px] text-foreground"
                                style={{ fontFamily: "var(--font-mono)" }}
                                title={t("docsPage.reference.endpoints.jumpToDetail")}
                              >
                                {ep.path}
                                <ArrowUpRight className="h-3 w-3 opacity-60" />
                              </a>
                            ) : (
                              <code
                                className="rounded bg-secondary px-1.5 py-0.5 text-[12px] text-foreground"
                                style={{ fontFamily: "var(--font-mono)" }}
                              >
                                {ep.path}
                              </code>
                            )}
                            {ep.locked && <Lock className="docs-endpoints__lock h-3 w-3" />}
                          </div>
                        </td>
                        <td className="px-4 py-2 text-fg-muted">{t(ep.key)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          );
        })}
      </div>
    </DocsSection>
  );
}
