import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { toast } from "sonner";
import {
  api,
  AUTH_EXPIRED_EVENT,
  COOKIE_SESSION_TOKEN,
  type UserSessionResponse,
} from "../api/gateway";
import { useT } from "../i18n";

/** 浏览器会话只保存在 HttpOnly cookie；JavaScript 状态中不持久化 JWT。 */
export interface UserSession {
  token: string;
  authId: string;
  name: string;
  department: string;
}

interface AuthContextValue {
  user: UserSession | null;
  /** 首次 cookie 会话探测完成；路由守卫据此避免刷新时闪出登录框。 */
  ready: boolean;
  authed: boolean;
  token: string;
  authId: string;
  name: string;
  department: string;
  login: (session: UserSessionResponse) => void;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function browserSession(session: UserSessionResponse): UserSession {
  return {
    // 哨兵只告诉网关“由 cookie 鉴权”，不包含任何凭据。
    token: COOKIE_SESSION_TOKEN,
    authId: session.authId,
    name: session.name || "",
    department: session.department || "",
  };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const { t } = useT();
  const [user, setUser] = useState<UserSession | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let active = true;
    // 清掉旧版本曾持久化到 Web Storage 的 JWT。
    try {
      localStorage.removeItem("platform_user");
    } catch {
      /* storage may be unavailable */
    }
    api.userSession()
      .then((session) => { if (active) setUser(browserSession(session)); })
      .catch(() => { if (active) setUser(null); })
      .finally(() => { if (active) setReady(true); });
    return () => { active = false; };
  }, []);

  const login = useCallback((session: UserSessionResponse) => {
    setUser(browserSession(session));
    setReady(true);
  }, []);

  const logout = useCallback(() => {
    setUser(null);
    void api.userLogout().catch(() => {});
  }, []);

  useEffect(() => {
    const onExpired = () => {
      setUser((current) => {
        if (current) toast.error(t("auth.sessionExpired"));
        return null;
      });
      void api.userLogout().catch(() => {});
    };
    window.addEventListener(AUTH_EXPIRED_EVENT, onExpired);
    return () => window.removeEventListener(AUTH_EXPIRED_EVENT, onExpired);
  }, [t]);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      ready,
      authed: Boolean(user),
      token: user?.token || "",
      authId: user?.authId || "",
      name: user?.name || "",
      department: user?.department || "",
      login,
      logout,
    }),
    [user, ready, login, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth 必须在 <AuthProvider> 内使用");
  return ctx;
}
