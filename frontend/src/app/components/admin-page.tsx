import { useState, useEffect, useCallback, Suspense, useMemo, type ComponentType } from "react";
import {
  Loader2, Lock, LogOut, ExternalLink,
  TrendingUp, Database, Key, ArrowLeftRight,
  ScrollText, Users, Sparkles, Tags, Zap, Server, ShieldAlert, Palette,
} from "lucide-react";
import { EarlyAccessIcon } from "./early-access-icon";
import { toast } from "sonner";
import { ModelProvider } from "./model-context";
import { AdminShell } from "./AdminShell";
import { ADMIN_NAV_TAB_EVENT } from "./admin-tab-utils";
import { api, ADMIN_EXPIRED_EVENT, COOKIE_SESSION_TOKEN } from "../api/gateway";
import { lazyRetry, prefetchOnIdle } from "../lazy-retry";
import { ConsoleLayout, type NavItem } from "./ui/console-layout";
import { PageHeader } from "./ui/page-header";
import { useT } from "../i18n";
import { usePlatformConfig } from "../hooks/use-platform-config";

const importDashboardTab = () => import("./admin-dashboard-tab");
const importKeysTab = () => import("./admin-keys-tab");
const importModelsTab = () => import("./admin-models-tab");
const importMigrationTab = () => import("./admin-migration-tab");
const importLogsTab = () => import("./admin-logs-tab");
const importInfraTab = () => import("./admin-infra-tab");
const importUsersTab = () => import("./admin-users-tab");
const importEarlyAccessTab = () => import("./admin-early-access-tab");
const importAskDocsTab = () => import("./admin-ask-docs-tab");
const importSceneTypesTab = () => import("./admin-scene-types-tab");
const importUpgradeAppsTab = () => import("./admin-upgrade-apps-tab");
const importFallbackTab = () => import("./admin-fallback-tab");
const importBrandingTab = () => import("./admin-branding-tab");

const DashboardTab = lazyRetry(importDashboardTab);
const KeysTab = lazyRetry(importKeysTab);
const ModelsTab = lazyRetry(importModelsTab);
const MigrationTab = lazyRetry(importMigrationTab);
const LogsTab = lazyRetry(importLogsTab);
const InfraTab = lazyRetry(importInfraTab);
const UsersTab = lazyRetry(importUsersTab);
const EarlyAccessTab = lazyRetry(importEarlyAccessTab);
const AskDocsTab = lazyRetry(importAskDocsTab);
const SceneTypesTab = lazyRetry(importSceneTypesTab);
const UpgradeAppsTab = lazyRetry(importUpgradeAppsTab);
const FallbackTab = lazyRetry(importFallbackTab);
const BrandingTab = lazyRetry(importBrandingTab);

type Tab = "dashboard" | "infra" | "keys" | "models" | "fallback" | "migration" | "logs" | "users" | "early-access" | "ask-docs" | "scene-types" | "upgrade-apps" | "branding";

interface TabDef {
  key: Tab;
  label: string;
  icon: ComponentType<{ className?: string }>;
  desc: string;
  /** 导航角标（待办数），运行时由 AdminPage 注入 */
  badge?: number;
}

function makeNavGroups(t: ReturnType<typeof useT>["t"]): { title: string; items: TabDef[] }[] {
  return [
    {
      title: t("admin.nav.ops"),
      items: [
        { key: "dashboard", label: t("admin.nav.dashboard"), icon: TrendingUp, desc: t("admin.nav.dashboard.desc") },
        { key: "infra", label: t("admin.nav.infra"), icon: Server, desc: t("admin.nav.infra.desc") },
        { key: "logs", label: t("admin.nav.logs"), icon: ScrollText, desc: t("admin.nav.logs.desc") },
      ],
    },
    {
      title: t("admin.nav.resources"),
      items: [
        { key: "keys", label: t("admin.nav.keys"), icon: Key, desc: t("admin.nav.keys.desc") },
        { key: "models", label: t("admin.nav.models"), icon: Database, desc: t("admin.nav.models.desc") },
        { key: "fallback", label: t("admin.nav.fallback"), icon: ShieldAlert, desc: t("admin.nav.fallback.desc") },
        { key: "users", label: t("admin.nav.users"), icon: Users, desc: t("admin.nav.users.desc") },
        { key: "early-access", label: t("admin.nav.earlyAccess"), icon: EarlyAccessIcon, desc: t("admin.nav.earlyAccess.desc") },
        { key: "upgrade-apps", label: t("admin.nav.upgradeApps"), icon: Zap, desc: t("admin.nav.upgradeApps.desc") },
      ],
    },
    {
      title: t("admin.nav.system"),
      items: [
        { key: "branding", label: t("admin.nav.branding"), icon: Palette, desc: t("admin.nav.branding.desc") },
        { key: "scene-types", label: t("admin.nav.sceneTypes"), icon: Tags, desc: t("admin.nav.sceneTypes.desc") },
        { key: "ask-docs", label: t("admin.nav.askDocs"), icon: Sparkles, desc: t("admin.nav.askDocs.desc") },
        { key: "migration", label: t("admin.nav.backup"), icon: ArrowLeftRight, desc: t("admin.nav.backup.desc") },
      ],
    },
  ];
}

function TabFallback() {
  const { t } = useT();
  return (
    <div className="flex items-center justify-center gap-2 py-20 text-[14px] text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin" />
      <span>{t("common.loading")}</span>
    </div>
  );
}

function clearAdminSession() {
  try {
    sessionStorage.removeItem("apiplatform-admin");
  } catch {
    /* ignore */
  }
}

function AdminNavItem({
  item,
  isActive,
  isMobile,
  onClick,
}: {
  item: NavItem;
  isActive: boolean;
  isMobile: boolean;
  onClick: () => void;
}) {
  const Icon = item.icon;
  const baseClass = isMobile
    ? "flex items-center gap-1.5 whitespace-nowrap rounded-lg px-3 py-1.5 text-[13px] transition-colors"
    : "flex items-center gap-3 rounded-xl px-3 py-2.5 text-left text-[14px] font-medium transition-colors w-full";
  const activeClass = isMobile
    ? "bg-secondary font-medium text-foreground"
    : "bg-secondary text-foreground";
  const inactiveClass = "text-muted-foreground hover:bg-secondary hover:text-foreground";

  return (
    <button
      type="button"
      onClick={onClick}
      className={`${baseClass} ${isActive ? activeClass : inactiveClass}`}
    >
      <Icon className={isMobile ? "h-3.5 w-3.5" : "h-4 w-4 shrink-0"} />
      {item.label}
      {typeof item.badge === "number" && item.badge > 0 && (
        <span
          className={`ml-auto shrink-0 rounded-md px-1.5 py-0.5 text-[11px] font-semibold tabular-nums ${
            isActive ? "bg-foreground/10 text-foreground" : "bg-amber-100 text-amber-700"
          }`}
        >
          {item.badge}
        </span>
      )}
    </button>
  );
}

export function AdminPage() {
  const { t } = useT();
  const { branding } = usePlatformConfig();
  const [token, setToken] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirmation, setPasswordConfirmation] = useState("");
  const [bootstrapToken, setBootstrapToken] = useState("");
  const [bootstrapRequired, setBootstrapRequired] = useState(false);
  const [adminInitialized, setAdminInitialized] = useState<boolean | null>(null);
  const [logging, setLogging] = useState(false);
  const [loginErr, setLoginErr] = useState("");
  const [activeTab, setActiveTab] = useState<Tab>("dashboard");
  // 高并发升级待审批数（导航角标）。审批是慢动作，60s 轮询足够，失败静默。
  const [upgradePending, setUpgradePending] = useState(0);

  const refreshUpgradePending = useCallback(async () => {
    if (!token) return;
    try {
      const d = await api.adminUpgradeApplicationsList(token, { limit: 1, status: "pending" });
      setUpgradePending(d.pendingTotal ?? 0);
    } catch { /* 静默 */ }
  }, [token]);

  useEffect(() => {
    refreshUpgradePending();
    const id = setInterval(refreshUpgradePending, 60000);
    return () => clearInterval(id);
  }, [refreshUpgradePending]);

  const NAV_GROUPS = useMemo(() => {
    const groups = makeNavGroups(t);
    for (const g of groups) {
      for (const item of g.items) {
        if (item.key === "upgrade-apps") item.badge = upgradePending;
      }
    }
    return groups;
  }, [t, upgradePending]);
  const ALL_TABS: TabDef[] = useMemo(() => NAV_GROUPS.flatMap((g) => g.items), [NAV_GROUPS]);

  useEffect(() => {
    let active = true;
    clearAdminSession();
    api.adminSession()
      .then(() => {
        if (!active) return;
        setAdminInitialized(true);
        setBootstrapRequired(false);
        setToken(COOKIE_SESSION_TOKEN);
      })
      .catch(() => api.adminLoginStatus().then((data) => {
        if (!active) return;
        setAdminInitialized(data.initialized !== false);
        setBootstrapRequired(Boolean(data.bootstrapRequired));
      }))
      .catch(() => {
        if (!active) return;
        setAdminInitialized(true);
        setLoginErr(t("admin.backendConnectFailed"));
      });
    return () => { active = false; };
  }, [t]);

  useEffect(() => {
    const onExpired = () => {
      setToken("");
      // 只要浏览器曾持有服务端签发的管理员会话，首次认领必然已经完成；重新
      // 验证时不能再显示密码确认/bootstrap 输入框。
      setAdminInitialized(true);
      setBootstrapRequired(false);
      clearAdminSession();
      void api.adminLogout().catch(() => {});
      setLoginErr(t("auth.sessionExpired"));
    };
    window.addEventListener(ADMIN_EXPIRED_EVENT, onExpired);
    return () => window.removeEventListener(ADMIN_EXPIRED_EVENT, onExpired);
  }, [t]);

  useEffect(() => {
    const onNavTab = (e: Event) => {
      const tab = (e as CustomEvent<{ tab?: Tab }>).detail?.tab;
      if (tab) setActiveTab(tab);
    };
    window.addEventListener(ADMIN_NAV_TAB_EVENT, onNavTab);
    return () => window.removeEventListener(ADMIN_NAV_TAB_EVENT, onNavTab);
  }, []);

  useEffect(() => {
    if (!token) return;
    prefetchOnIdle([
      importKeysTab, importModelsTab, importLogsTab, importInfraTab,
      importUsersTab, importMigrationTab, importEarlyAccessTab,
      importAskDocsTab, importSceneTypesTab, importUpgradeAppsTab, importFallbackTab,
      importBrandingTab,
    ]);
  }, [token]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginErr("");
    if (adminInitialized === false && password !== passwordConfirmation) {
      setLoginErr(t("admin.passwordMismatch"));
      return;
    }
    setLogging(true);
    try {
      await api.adminLogin(
        password,
        adminInitialized === false ? passwordConfirmation : undefined,
        bootstrapRequired ? bootstrapToken : undefined,
      );
      setAdminInitialized(true);
      setBootstrapRequired(false);
      setToken(COOKIE_SESSION_TOKEN);
      setPassword("");
      setPasswordConfirmation("");
      setBootstrapToken("");
    } catch (err) {
      const detail = err instanceof Error ? err.message : t("admin.backendConnectFailed");
      setLoginErr(detail);
      toast.error(detail);
    }
    setLogging(false);
  };

  function logout() {
    setToken("");
    clearAdminSession();
    void api.adminLogout().catch(() => {});
  }

  if (!token) {
    return (
      <AdminShell bare>
        <div className="mx-auto flex min-h-screen max-w-sm items-center px-5 py-16">
          <div className="w-full animate-enter rounded-2xl bg-card p-8 text-center shadow-sm apiplatform-card-hover">
            <div className="mx-auto mb-5 flex h-12 w-12 items-center justify-center rounded-xl bg-secondary">
              <Lock className="h-5 w-5 text-muted-foreground" />
            </div>
            <h1 className="font-serif text-[20px] font-medium text-foreground">
              {adminInitialized === false ? t("admin.setup") : t("admin.verification")}
            </h1>
            <p className="mt-1 text-[13px] text-muted-foreground">
              {adminInitialized === false ? t("admin.setupIntro") : t("admin.enterPassword")}
            </p>
            {adminInitialized === null ? (
              <div className="mt-6 flex items-center justify-center gap-2 text-[13px] text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                {t("admin.checkingSetup")}
              </div>
            ) : <form onSubmit={handleLogin} className="mt-6 space-y-4 text-left">
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                aria-label={t("admin.passwordPlaceholder")}
                placeholder={t("admin.passwordPlaceholder")}
                className="w-full rounded-xl border border-border/60 bg-background px-4 py-3 text-center text-[14px] focus:outline-none focus:ring-2 focus:ring-primary/15"
                autoComplete={adminInitialized === false ? "new-password" : "current-password"}
                minLength={adminInitialized === false ? 12 : 1}
                maxLength={128}
                autoFocus
              />
              {adminInitialized === false && <>
                {bootstrapRequired && (
                  <input
                    type="password"
                    value={bootstrapToken}
                    onChange={(e) => setBootstrapToken(e.target.value)}
                    aria-label={t("admin.bootstrapTokenPlaceholder")}
                    placeholder={t("admin.bootstrapTokenPlaceholder")}
                    className="w-full rounded-xl border border-border/60 bg-background px-4 py-3 text-center text-[14px] focus:outline-none focus:ring-2 focus:ring-primary/15"
                    autoComplete="off"
                    maxLength={512}
                  />
                )}
                <input
                  type="password"
                  value={passwordConfirmation}
                  onChange={(e) => setPasswordConfirmation(e.target.value)}
                  aria-label={t("admin.confirmPasswordPlaceholder")}
                  placeholder={t("admin.confirmPasswordPlaceholder")}
                  className="w-full rounded-xl border border-border/60 bg-background px-4 py-3 text-center text-[14px] focus:outline-none focus:ring-2 focus:ring-primary/15"
                  autoComplete="new-password"
                  minLength={12}
                  maxLength={128}
                />
                <p className="px-1 text-center text-[12px] leading-5 text-muted-foreground">
                  {t("admin.passwordPolicy")}
                </p>
              </>}
              {loginErr && <div className="text-center text-[13px] text-red-600">{loginErr}</div>}
              <button
                type="submit"
                disabled={logging || !password || (adminInitialized === false && (!passwordConfirmation || (bootstrapRequired && !bootstrapToken)))}
                className="flex w-full items-center justify-center gap-2 rounded-xl bg-primary py-2.5 text-[14px] text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-60 apiplatform-btn"
              >
                {logging ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                {logging
                  ? (adminInitialized === false ? t("admin.initializing") : t("admin.verifying"))
                  : (adminInitialized === false ? t("admin.initialize") : t("admin.enter"))}
              </button>
            </form>}
          </div>
        </div>
      </AdminShell>
    );
  }

  const tabMeta = ALL_TABS.find((t) => t.key === activeTab)!;

  const groups: { title?: string; items: NavItem[] }[] = NAV_GROUPS.map((g) => ({
    title: g.title,
    items: g.items.map((t) => ({ ...t, key: t.key })),
  }));

  const bottomItems: NavItem[] = [
    {
      key: "back",
      label: t("admin.backToPlatform"),
      icon: ExternalLink,
      to: "/",
      newTab: false,
    },
    {
      key: "logout",
      label: t("header.account.logout"),
      icon: LogOut,
      onClick: logout,
    },
  ];

  return (
    <ModelProvider>
      <ConsoleLayout
        brand={branding.brand}
        tag={t("admin.title")}
        groups={groups}
        bottomItems={bottomItems}
        mainClassName={activeTab === "logs" ? "max-w-none p-3 md:p-4" : undefined}
        isActive={(item) => activeTab === item.key}
        renderItem={(item, { isActive, isMobile }) => {
          if (item.to) {
            const Icon = item.icon;
            const baseClass = isMobile
              ? "flex items-center gap-1.5 whitespace-nowrap rounded-lg px-3 py-1.5 text-[13px] transition-colors"
              : "flex items-center gap-3 rounded-xl px-3 py-2.5 text-left text-[14px] font-medium transition-colors w-full";
            const activeClass = isMobile
              ? "bg-secondary font-medium text-foreground"
              : "bg-secondary text-foreground";
            const inactiveClass = "text-muted-foreground hover:bg-secondary hover:text-foreground";
            return (
              <a
                href={item.to}
                className={`${baseClass} ${isActive ? activeClass : inactiveClass}`}
              >
                <Icon className={isMobile ? "h-3.5 w-3.5" : "h-4 w-4 shrink-0"} />
                {item.label}
              </a>
            );
          }
          return (
            <AdminNavItem
              item={item}
              isActive={isActive}
              isMobile={isMobile}
              onClick={() => {
                if (item.onClick) item.onClick();
                else setActiveTab(item.key as Tab);
              }}
            />
          );
        }}
      >
        {activeTab !== "infra" && activeTab !== "logs" && activeTab !== "dashboard" && activeTab !== "models" && activeTab !== "fallback" && (
          <PageHeader title={tabMeta.label} description={tabMeta.desc} />
        )}
        <Suspense fallback={<TabFallback />}>
          {activeTab === "dashboard" && <DashboardTab token={token} />}
          {activeTab === "infra" && <InfraTab token={token} />}
          {activeTab === "keys" && <KeysTab token={token} />}
          {activeTab === "models" && <ModelsTab token={token} />}
          {activeTab === "fallback" && <FallbackTab token={token} />}
          {activeTab === "logs" && <LogsTab token={token} />}
          {activeTab === "users" && <UsersTab token={token} />}
          {activeTab === "early-access" && <EarlyAccessTab token={token} />}
          {activeTab === "ask-docs" && <AskDocsTab token={token} />}
          {activeTab === "scene-types" && <SceneTypesTab token={token} />}
          {activeTab === "upgrade-apps" && <UpgradeAppsTab token={token} />}
          {activeTab === "migration" && <MigrationTab token={token} />}
          {activeTab === "branding" && <BrandingTab token={token} />}
        </Suspense>
      </ConsoleLayout>
    </ModelProvider>
  );
}
