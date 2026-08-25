import { ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link, useLocation } from "react-router-dom";
import { Braces, ChevronDown, Globe, Menu, X } from "lucide-react";
import { ThemeToggle } from "./ThemeToggle";
import { NewTabLink } from "./NewTabLink";
import { ContactDialog } from "./ContactDialog";
import { SearchModal, useSearchHotkey } from "./search-modal";
import { UserAuthModal } from "./UserAuthModal";
import { EarlyAccessModal } from "./early-access-modal";
import { useAuth } from "../hooks/use-auth";
import { useContactDialog, ContactDialogProvider } from "../hooks/use-contact-dialog";
import { useEarlyAccess } from "../hooks/use-early-access";
import { useKeyApplications } from "../hooks/use-key-applications";
import { useT } from "../i18n";
import { usePlatformConfig } from "../hooks/use-platform-config";
import { nextMenuItemIndex, useModalFocus } from "../accessibility";

/* 需要统一放在顶部标题栏里的核心导航入口(按优先级排序) */
const NAV_ITEMS = [
  { tKey: "header.models" as const, to: "/models" },
  { tKey: "header.keys" as const, to: "/keys" },
  { tKey: "header.usage" as const, to: "/usage" },
  { tKey: "header.logs" as const, to: "/logs" },
];

/* 次级入口:折叠到"更多"里(问题反馈、夜间批量登记等低频功能) */
const MORE_ITEMS = [
  { tKey: "header.feedback" as const, to: "/forum" },
  { tKey: "header.nightBatch" as const, to: "/night-batch" },
];

const LANGUAGES = [
  { code: "zh-CN", tKey: "lang.zhCN" as const },
  { code: "zh-TW", tKey: "lang.zhTW" as const },
  { code: "en", tKey: "lang.en" as const },
] as const;

function LangToggle() {
  const { lang, setLang, t } = useT();
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (btnRef.current && !btnRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);

  const toggle = () => {
    if (!open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      setPos({ top: r.bottom + 4, right: window.innerWidth - r.right });
    }
    setOpen(!open);
  };

  const currentLabel = LANGUAGES.find((l) => l.code === lang)?.tKey
    ? t(LANGUAGES.find((l) => l.code === lang)!.tKey)
    : "简体中文";

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className="header-nav__icon-btn"
        onClick={toggle}
        aria-label={t("header.langSwitch")}
        title={currentLabel}
      >
        <Globe size={16} strokeWidth={2} />
      </button>
      {open && pos && createPortal(
        <div className="lang-toggle__dropdown" style={{ position: "fixed", top: pos.top, right: pos.right, zIndex: 9999 }}>
          {LANGUAGES.map((l) => (
            <button
              key={l.code}
              type="button"
              className={`lang-toggle__option${lang === l.code ? " lang-toggle__option--active" : ""}`}
              onClick={() => { setLang(l.code as "zh-CN" | "zh-TW" | "en"); setOpen(false); }}
            >
              {t(l.tKey)}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}

/** 未读小红点：审批有结果但用户还没看过。绝对定位挂在触发元素右上角。 */
function UnreadDot({ inset }: { inset?: boolean }) {
  return (
    <span
      aria-hidden="true"
      style={{
        position: "absolute",
        top: inset ? 8 : -1,
        right: inset ? 8 : -1,
        width: 7,
        height: 7,
        borderRadius: "50%",
        background: "var(--danger, #d94b3d)",
        boxShadow: "0 0 0 2px var(--card)",
      }}
    />
  );
}

/** 已登录时右上角的姓名菜单：抢先体验计划 / 退出登录。
 *  点击姓名不再直接退出——退出是破坏性操作，需要显式选择。
 *  抢先体验审批有未读结果时，姓名与菜单项各挂一个红点。 */
function AccountMenu({
  onOpenEarlyAccess, unread,
}: { onOpenEarlyAccess: () => void; unread: boolean }) {
  const { name, logout } = useAuth();
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (btnRef.current && !btnRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);

  const toggle = () => {
    if (!open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      setPos({ top: r.bottom + 6, right: window.innerWidth - r.right });
    }
    setOpen(!open);
  };

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className="header-tools__login header-tools__login--authed"
        onClick={toggle}
        aria-haspopup="menu"
        aria-expanded={open}
        style={{ position: "relative" }}
      >
        <span className="font-serif font-medium">{name}</span>
        <ChevronDown
          size={12}
          style={{
            marginLeft: 4,
            transform: open ? "rotate(180deg)" : "rotate(0deg)",
            transition: "transform 0.2s var(--ease-out)",
          }}
        />
        {unread && <UnreadDot />}
      </button>
      {open && pos && createPortal(
        <div
          className="lang-toggle__dropdown"
          role="menu"
          style={{ position: "fixed", top: pos.top, right: pos.right, zIndex: 9999, minWidth: 148 }}
        >
          <button
            type="button"
            role="menuitem"
            className="lang-toggle__option"
            style={{ position: "relative" }}
            onClick={() => { setOpen(false); onOpenEarlyAccess(); }}
          >
            {t("header.account.earlyAccess")}
            {unread && <UnreadDot inset />}
          </button>
          <button
            type="button"
            role="menuitem"
            className="lang-toggle__option"
            onClick={() => { setOpen(false); logout(); }}
          >
            {t("header.account.logout")}
          </button>
        </div>,
        document.body,
      )}
    </>
  );
}

function MoreDropdown() {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);

  const toggle = () => {
    if (!open && ref.current) {
      const r = ref.current.getBoundingClientRect();
      setPos({ top: r.bottom + 4, left: r.left });
    }
    setOpen(!open);
  };

  return (
    <>
      <button
        ref={ref}
        type="button"
        className={`header-nav__link${open ? " header-nav__link--active" : ""}`}
        onClick={toggle}
        aria-expanded={open}
      >
        {t("header.more")} <ChevronDown size={12} style={{ marginLeft: 2, transform: open ? "rotate(180deg)" : "rotate(0deg)", transition: "transform 0.2s var(--ease-out)" }} />
      </button>
      {open && pos && createPortal(
        <div className="more-dropdown" style={{ position: "fixed", top: pos.top, left: pos.left }}>
          {MORE_ITEMS.map((item) => (
            <Link key={item.to} to={item.to} className="more-dropdown__item">
              {t(item.tKey)}
            </Link>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}

function MobileNavigation({
  pathname,
  keyUnread,
  onMarkKeySeen,
  onContact,
}: {
  pathname: string;
  keyUnread: boolean;
  onMarkKeySeen: () => void;
  onContact: () => void;
}) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  useModalFocus({ open, containerRef: panelRef, onClose: () => setOpen(false) });

  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!open) return;
    const closeAtDesktopWidth = () => {
      if (window.innerWidth >= 640) setOpen(false);
    };
    window.addEventListener("resize", closeAtDesktopWidth);
    return () => window.removeEventListener("resize", closeAtDesktopWidth);
  }, [open]);

  const onMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(panelRef.current?.querySelectorAll<HTMLElement>("[role='menuitem']") ?? []);
    const currentIndex = items.findIndex((item) => item === document.activeElement);
    const nextIndex = nextMenuItemIndex(event.key, currentIndex, items.length);
    if (nextIndex == null) return;
    event.preventDefault();
    items[nextIndex]?.focus();
  };

  const close = () => setOpen(false);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="header-mobile-menu__button"
        aria-label={open ? t("header.menu.close") : t("header.menu.open")}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls="mobile-primary-navigation"
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        {open ? <X size={18} aria-hidden="true" /> : <Menu size={18} aria-hidden="true" />}
      </button>
      {open && createPortal(
        <>
          <div className="header-mobile-menu__backdrop" aria-hidden="true" onClick={close} />
          <div
            id="mobile-primary-navigation"
            ref={panelRef}
            className="header-mobile-menu__panel"
            role="menu"
            aria-label={t("header.nav.ariaLabel")}
            tabIndex={-1}
            onKeyDown={onMenuKeyDown}
          >
            {[...NAV_ITEMS, ...MORE_ITEMS].map((item) => {
              const active = isNavActive(pathname, item.to);
              const showKeyDot = item.to === "/keys" && keyUnread;
              return (
                <Link
                  key={item.to}
                  to={item.to}
                  role="menuitem"
                  aria-current={active ? "page" : undefined}
                  className={`header-mobile-menu__item${active ? " header-mobile-menu__item--active" : ""}`}
                  onClick={() => {
                    if (showKeyDot) onMarkKeySeen();
                    close();
                  }}
                >
                  <span>{t(item.tKey)}</span>
                  {showKeyDot && <UnreadDot inset />}
                </Link>
              );
            })}
            <Link to="/docs" role="menuitem" className="header-mobile-menu__item" onClick={close}>
              <span>{t("header.docs")}</span>
            </Link>
            <button
              type="button"
              role="menuitem"
              className="header-mobile-menu__item"
              onClick={() => { close(); onContact(); }}
            >
              {t("header.contact")}
            </button>
          </div>
        </>,
        document.body,
      )}
    </>
  );
}

/** 基于当前路径判断某个 nav 入口是否高亮(支持 /models/:id 等子路径) */
function isNavActive(pathname: string, to: string) {
  if (to === "/") return pathname === "/";
  return pathname === to || pathname.startsWith(`${to}/`);
}

/** 原先依赖 DashboardLayout 提供 `p-5 md:p-8` + 居中容器的页面,
 *  改为在顶层 Layout 中按路径注入一致的内边距,保证从左侧栏迁移到顶部导航后排版不变 */
const PADDED_PATHS = ["/models", "/keys", "/usage", "/logs", "/forum", "/night-batch"];
function isPaddedPath(pathname: string) {
  return PADDED_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export function Layout({ children }: { children: ReactNode }) {
  return (
    <ContactDialogProvider>
      <LayoutInner>{children}</LayoutInner>
    </ContactDialogProvider>
  );
}

function LayoutInner({ children }: { children: ReactNode }) {
  const loc = useLocation();
  const [searchOpen, setSearchOpen] = useSearchHotkey();
  const [authOpen, setAuthOpen] = useState(false);
  const { open: contactOpen, setOpen: setContactOpen } = useContactDialog();
  const [earlyAccessOpen, setEarlyAccessOpen] = useState(false);
  const { authed } = useAuth();
  const earlyAccess = useEarlyAccess();
  const keyApplications = useKeyApplications();
  const { t } = useT();
  const { branding } = usePlatformConfig();

  const isHome = loc.pathname === "/";
  const padded = isPaddedPath(loc.pathname);

  const [scrolled, setScrolled] = useState(!isHome);
  useEffect(() => {
    if (!isHome) { setScrolled(true); return; }
    const update = () => setScrolled(window.scrollY > 24);
    update();
    window.addEventListener("scroll", update, { passive: true });
    return () => window.removeEventListener("scroll", update);
  }, [isHome]);

  const headerClass = isHome
    ? (scrolled ? "header-scrolled" : "header-top")
    : "header-scrolled";

  return (
    <div className={`flex min-h-full flex-col${isHome ? " layout-home" : ""}`}>
      <header className={`sticky top-0 z-50 transition-[background,border-color] duration-300 ${headerClass}`}>
        <div className="header-shell">
          {/* Left: Brand */}
          <Link to="/" className="header-brand">
            <span className="header-brand__name" style={{ background: "#000", color: "#fff", padding: "4px 10px", borderRadius: 6, fontWeight: 700 }}>{branding.brand}</span>
            <span className="header-brand__badge">{branding.platform_name}</span>
          </Link>

          {/* Center: Nav — 模型广场/API Keys/接口文档/用量统计/调用日志/问题反馈 与首页并列 */}
          <nav className="header-nav header-nav--center" aria-label={t("header.nav.ariaLabel")}>
            {NAV_ITEMS.map((item) => {
              const active = isNavActive(loc.pathname, item.to);
              const showKeyDot = item.to === "/keys" && keyApplications.unread;
              return (
                <Link
                  key={item.to}
                  to={item.to}
                  onClick={showKeyDot ? keyApplications.markSeen : undefined}
                  aria-current={active ? "page" : undefined}
                  className={`header-nav__link${active ? " header-nav__link--active" : ""}`}
                  style={showKeyDot ? { position: "relative" } : undefined}
                >
                  {t(item.tKey)}
                  {showKeyDot && <UnreadDot />}
                </Link>
              );
            })}
            {MORE_ITEMS.length > 0 && <MoreDropdown />}
            <MobileNavigation
              pathname={loc.pathname}
              keyUnread={keyApplications.unread}
              onMarkKeySeen={keyApplications.markSeen}
              onContact={() => setContactOpen(true)}
            />
          </nav>

          {/* Right: Tools */}
          <div className="header-tools">
            <NewTabLink to="/docs" className="header-tools__api-btn" title={t("header.docs")}>
              <Braces size={16} strokeWidth={2} />
              <span className="header-tools__api-label">{t("header.docs")}</span>
            </NewTabLink>
            <span className="header-tools__sep">|</span>
            <ThemeToggle />
            <LangToggle />
            <button
              type="button"
              className="header-tools__contact"
              onClick={() => setContactOpen(true)}
            >
              {t("header.contact")}
            </button>
            {authed ? (
              <AccountMenu
                unread={earlyAccess.unread}
                onOpenEarlyAccess={() => { earlyAccess.markSeen(); setEarlyAccessOpen(true); }}
              />
            ) : (
              <button type="button" className="header-tools__login" onClick={() => setAuthOpen(true)}>
                {t("header.login")}
              </button>
            )}
          </div>
        </div>
      </header>

      <main className={`flex-1${isHome ? " main-home-enter" : ""}${padded ? " layout-padded" : ""}`}>
        {children}
        </main>

        {!isHome && (
        <footer style={{ padding: "16px 0", textAlign: "center" }}>
          <p style={{ margin: 0, fontSize: 12, color: "var(--fg-muted)" }}>
            {branding.footer_text}
          </p>
        </footer>
        )}

        <SearchModal open={searchOpen} onClose={() => setSearchOpen(false)} />
      <UserAuthModal open={authOpen} onClose={() => setAuthOpen(false)} />
      <EarlyAccessModal
        open={earlyAccessOpen}
        onClose={() => setEarlyAccessOpen(false)}
        state={earlyAccess.state}
        loading={earlyAccess.loading}
        onRefresh={earlyAccess.refresh}
        onSeen={earlyAccess.markSeen}
      />
      <ContactDialog open={contactOpen} onOpenChange={setContactOpen} />
    </div>
  );
}
