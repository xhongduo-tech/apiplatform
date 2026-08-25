import { useEffect } from "react";
import { Toaster } from "sonner";
import { AdminPage } from "./components/admin-page";
import { useT } from "./i18n";
import { usePlatformConfig } from "./hooks/use-platform-config";

/** 管理后台独立 SPA（admin.html），与开放平台主站分离。 */
export function AdminApp() {
  const { t } = useT();
  const { branding } = usePlatformConfig();

  // document.title 不随语言切换会导致浏览器标签页标题与页面实际语言不一致
  useEffect(() => {
    document.title = `${branding.browser_title} · ${t("admin.title")}`;
    const description = document.querySelector<HTMLMetaElement>('meta[name="description"]');
    if (description) description.content = `${branding.brand} · ${t("admin.title")}`;
  }, [branding.brand, branding.browser_title, t]);

  return (
    <>
      <Toaster position="top-center" richColors closeButton />
      <AdminPage />
    </>
  );
}
