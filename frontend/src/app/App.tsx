import { Suspense, useEffect } from "react";
import { Link, Navigate, Route, Routes } from "react-router-dom";
import { Toaster } from "sonner";
import { Layout } from "./components/Layout";
import { RequireAuth } from "./components/RequireAuth";
import { Home } from "./components/home";
import { lazyRetry, prefetchOnIdle } from "./lazy-retry";
import { useT } from "./i18n";
import { usePlatformConfig } from "./hooks/use-platform-config";

const importModelPlaza = () => import("./components/ModelPlaza").then((m) => ({ default: m.ModelPlaza }));
const importApplyKeys = () => import("./components/ApplyKeys").then((m) => ({ default: m.ApplyKeys }));
const importUsage = () => import("./components/Usage").then((m) => ({ default: m.Usage }));
const importLogs = () => import("./components/Logs").then((m) => ({ default: m.Logs }));
const importDocs = () => import("./components/docs").then((m) => ({ default: m.DocsPage }));
const importForum = () => import("./components/Forum").then((m) => ({ default: m.Forum }));
const importModelDetail = () => import("./components/ModelDetail").then((m) => ({ default: m.ModelDetail }));
const importPlatformStatus = () => import("./components/PlatformStatus").then((m) => ({ default: m.PlatformStatus }));
const importNightBatch = () => import("./components/NightBatch").then((m) => ({ default: m.NightBatch }));

const ModelPlaza = lazyRetry(importModelPlaza);
const ApplyKeys = lazyRetry(importApplyKeys);
const Usage = lazyRetry(importUsage);
const Logs = lazyRetry(importLogs);
const Docs = lazyRetry(importDocs);
const Forum = lazyRetry(importForum);
const ModelDetail = lazyRetry(importModelDetail);
const PlatformStatus = lazyRetry(importPlatformStatus);
const NightBatch = lazyRetry(importNightBatch);

function Loading() {
  return (
    <div className="container-1200 py-10">
      <div className="skeleton h-7 w-48" />
      <div className="skeleton mt-3 h-4 w-72" />
      <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="card p-5">
            <div className="skeleton h-5 w-32" />
            <div className="skeleton mt-3 h-3 w-full" />
            <div className="skeleton mt-2 h-3 w-2/3" />
          </div>
        ))}
      </div>
    </div>
  );
}

function NotFound() {
  const { t } = useT();
  return (
    <div className="container-1200 flex flex-col items-center py-28 text-center">
      <div className="text-6xl font-bold tracking-tight text-brand">404</div>
      <h1 className="mt-3 text-xl font-semibold">{t("error.pageNotFound")}</h1>
      <p className="mt-2 max-w-sm text-sm text-fg-muted">{t("error.pageNotFoundDesc")}</p>
      <Link to="/" className="btn-primary mt-6">{t("error.goHome")}</Link>
    </div>
  );
}

export function App() {
  const { t } = useT();
  const { branding } = usePlatformConfig();

  useEffect(() => {
    prefetchOnIdle([importModelPlaza, importDocs, importApplyKeys, importUsage]);
  }, []);

  // document.title 不随语言切换会导致浏览器标签页/收藏夹标题与页面实际语言不一致
  useEffect(() => {
    document.title = branding.browser_title;
    const description = document.querySelector<HTMLMetaElement>('meta[name="description"]');
    if (description) description.content = `${branding.brand} · ${branding.platform_name}`;
  }, [branding.brand, branding.browser_title, branding.platform_name]);

  return (
    <Layout>
      <Toaster position="top-center" richColors closeButton />
      <Suspense fallback={<Loading />}>
        <Routes>
          {/* 落地页 */}
          <Route path="/" element={<Home />} />

          {/* 所有原"控制台"功能页:统一走顶层导航(Layout 顶部标题栏),
              未登录(缺工号/姓名)时由 RequireAuth 拦截并展示登录门。
              不再使用 DashboardLayout 左侧栏,所有页面与首页为并列关系。 */}
          <Route element={<RequireAuth />}>
            <Route path="/models/:id" element={<ModelDetail />} />
            <Route path="/models" element={<ModelPlaza />} />
            <Route path="/keys" element={<ApplyKeys />} />
            <Route path="/docs" element={<Docs />} />
            <Route path="/docs/chat" element={<Navigate to="/docs?section=chat-api" replace />} />
            <Route path="/docs/embeddings" element={<Navigate to="/docs?section=embeddings-rerank" replace />} />
            <Route path="/docs/vision" element={<Navigate to="/docs?section=vision" replace />} />
            <Route path="/docs/tools" element={<Navigate to="/docs?section=tool-use" replace />} />
            <Route path="/docs/completions" element={<Navigate to="/docs?section=completions" replace />} />
            <Route path="/docs/messages" element={<Navigate to="/docs?section=messages" replace />} />
            <Route path="/docs/responses" element={<Navigate to="/docs?section=responses" replace />} />
            <Route path="/docs/errors" element={<Navigate to="/docs?section=errors" replace />} />
            <Route path="/docs/rate-limits" element={<Navigate to="/docs?section=rate-limits" replace />} />
            <Route path="/docs/authentication" element={<Navigate to="/docs?section=authentication" replace />} />
            <Route path="/usage" element={<Usage />} />
            <Route path="/logs" element={<Logs />} />
            <Route path="/forum" element={<Forum />} />
            <Route path="/forum/:postId" element={<Forum />} />
            <Route path="/night-batch" element={<NightBatch />} />
          </Route>

          {/* 独立页 */}
          <Route path="/status" element={<PlatformStatus />} />
          <Route path="/admin/*" element={<Navigate to="/admin.html" replace />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </Suspense>
    </Layout>
  );
}
