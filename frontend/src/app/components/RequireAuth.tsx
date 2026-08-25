import { Outlet } from "react-router-dom";
import { useAuth } from "../hooks/use-auth";
import { UserAuthModal } from "./UserAuthModal";

/**
 * 功能页登录门：未登录时拦截控制台所有功能页，展示整页登录界面（勾选同意使用规范/
 * 免责声明后提交平台账号登录）；登录后放行渲染目标页面。
 *
 * 首页进入功能页常以新标签打开，因此守卫放在路由层（而非首页点击事件），
 * 直接刷新 / 新标签直达功能页同样会被拦截。
 */
export function RequireAuth() {
  const { authed, ready } = useAuth();
  if (!ready) {
    return <div className="flex min-h-[50vh] items-center justify-center text-sm text-fg-muted">…</div>;
  }
  if (authed) return <Outlet />;
  // 作为登录门：不可关闭（onClose 无操作），登录成功后 authed 变化自动放行。
  return <UserAuthModal open closable={false} onClose={() => {}} />;
}
