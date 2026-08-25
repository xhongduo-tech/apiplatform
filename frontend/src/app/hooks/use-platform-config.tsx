import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { api, type PlatformConfig } from "../api/gateway";

export interface PlatformBranding {
  brand: string;
  platform_name: string;
  browser_title: string;
  title: string;
  slogan: string;
  organization_name: string;
  footer_text: string;
  support_department: string;
  support_contact: string;
  support_email: string;
  approval_department: string;
  approval_contact: string;
  approval_email: string;
}

/** 后端不可达时的中性开源兜底，不包含原部署方的品牌或人员信息。 */
export const DEFAULT_PLATFORM_BRANDING: PlatformBranding = {
  brand: "Open API Platform",
  platform_name: "开放平台",
  browser_title: "Open API Platform",
  title: "使用大模型 API\n开启你的开发之旅",
  slogan: "连接模型能力，加速应用创新",
  organization_name: "示例组织",
  footer_text: "© 2026 示例组织",
  support_department: "平台运营部",
  support_contact: "平台管理员",
  support_email: "support@example.com",
  approval_department: "平台运营部",
  approval_contact: "管理员",
  approval_email: "approval@example.com",
};

interface PlatformConfigContextValue {
  config: PlatformConfig | null;
  branding: PlatformBranding;
  refresh: () => Promise<void>;
}

const PlatformConfigContext = createContext<PlatformConfigContextValue | null>(null);

export function PlatformConfigProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<PlatformConfig | null>(null);

  const refresh = useCallback(async () => {
    try {
      setConfig(await api.config());
    } catch {
      // 公开配置失败不应该阻断整个应用，组件继续使用中性兜底。
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const branding = useMemo<PlatformBranding>(() => ({
    brand: config?.brand || DEFAULT_PLATFORM_BRANDING.brand,
    platform_name: config?.platform_name || DEFAULT_PLATFORM_BRANDING.platform_name,
    browser_title: config?.browser_title || DEFAULT_PLATFORM_BRANDING.browser_title,
    title: config?.title || DEFAULT_PLATFORM_BRANDING.title,
    slogan: config?.slogan || DEFAULT_PLATFORM_BRANDING.slogan,
    organization_name: config?.organization_name || DEFAULT_PLATFORM_BRANDING.organization_name,
    footer_text: config?.footer_text || DEFAULT_PLATFORM_BRANDING.footer_text,
    support_department: config?.support_department || DEFAULT_PLATFORM_BRANDING.support_department,
    support_contact: config?.support_contact || DEFAULT_PLATFORM_BRANDING.support_contact,
    support_email: config?.support_email || DEFAULT_PLATFORM_BRANDING.support_email,
    approval_department: config?.approval_department || DEFAULT_PLATFORM_BRANDING.approval_department,
    approval_contact: config?.approval_contact || DEFAULT_PLATFORM_BRANDING.approval_contact,
    approval_email: config?.approval_email || DEFAULT_PLATFORM_BRANDING.approval_email,
  }), [config]);

  const value = useMemo(() => ({ config, branding, refresh }), [config, branding, refresh]);
  return <PlatformConfigContext.Provider value={value}>{children}</PlatformConfigContext.Provider>;
}

export function usePlatformConfig(): PlatformConfigContextValue {
  const value = useContext(PlatformConfigContext);
  if (!value) throw new Error("usePlatformConfig must be used within PlatformConfigProvider");
  return value;
}
