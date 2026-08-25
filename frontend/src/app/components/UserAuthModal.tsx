import { useState, useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import { X, Eye, EyeOff } from "lucide-react";
import { api } from "../api/gateway";
import { useAuth } from "../hooks/use-auth";
import { useT } from "../i18n";
import { AuthAgreeRow, AuthTermsSheet, type TermsSheet } from "./auth-compliance";
import { usePlatformConfig } from "../hooks/use-platform-config";

interface Props {
  open: boolean;
  onClose: () => void;
  closable?: boolean;
}

type Tab = "login" | "register" | "forget";

export function UserAuthModal({ open, onClose, closable = true }: Props) {
  const { login } = useAuth();
  const { t } = useT();
  const { branding } = usePlatformConfig();
  const [tab, setTab] = useState<Tab>("login");
  const [loading, setLoading] = useState(false);
  const [showPwd, setShowPwd] = useState(false);
  const [showRegPwd, setShowRegPwd] = useState(false);
  const [showConfirmPwd, setShowConfirmPwd] = useState(false);
  const [showNewPwd, setShowNewPwd] = useState(false);
  const [showNewPwdConfirm, setShowNewPwdConfirm] = useState(false);

  const [registrationEnabled, setRegistrationEnabled] = useState(false);
  const [recoveryEnabled, setRecoveryEnabled] = useState(false);

  const [loginAuthId, setLoginAuthId] = useState("");
  const [loginPassword, setLoginPassword] = useState("");

  const [regAuthId, setRegAuthId] = useState("");
  const [regName, setRegName] = useState("");
  const [regDepartment, setRegDepartment] = useState("");
  const [regPassword, setRegPassword] = useState("");
  const [regConfirm, setRegConfirm] = useState("");

  const [forgetAuthId, setForgetAuthId] = useState("");
  const [forgetApiKey, setForgetApiKey] = useState("");
  const [forgetDone, setForgetDone] = useState(false);
  const [forgetNewPwd, setForgetNewPwd] = useState("");
  const [forgetNewPwdConfirm, setForgetNewPwdConfirm] = useState("");
  const [forgetResetDone, setForgetResetDone] = useState(false);
  const [agreedToTerms, setAgreedToTerms] = useState(false);
  const [agreementPromptSeq, setAgreementPromptSeq] = useState(0);
  const agreementCheckboxRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const termsSheetRef = useRef<TermsSheet>(null);
  const titleId = useId();
  const [termsSheet, setTermsSheet] = useState<TermsSheet>(null);

  useEffect(() => { termsSheetRef.current = termsSheet; }, [termsSheet]);

  useEffect(() => {
    api
      .config()
      .then((c) => {
        setRegistrationEnabled(c.registration_enabled);
        setRecoveryEnabled(c.password_recovery_enabled);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (open) {
      setTab("login");
      setLoginAuthId("");
      setLoginPassword("");
      setRegAuthId("");
      setRegName("");
      setRegDepartment("");
      setRegPassword("");
      setRegConfirm("");
      setForgetAuthId("");
      setForgetApiKey("");
      setForgetDone(false);
      setForgetNewPwd("");
      setForgetNewPwdConfirm("");
      setForgetResetDone(false);
      setAgreedToTerms(false);
      setAgreementPromptSeq(0);
      setTermsSheet(null);
      setShowPwd(false);
      setShowRegPwd(false);
      setShowConfirmPwd(false);
      setShowNewPwd(false);
      setShowNewPwdConfirm(false);
      setLoading(false);
    }
  }, [open]);

  useEffect(() => {
    if (!registrationEnabled && tab === "register") setTab("login");
    if (!recoveryEnabled && tab === "forget") setTab("login");
  }, [registrationEnabled, recoveryEnabled, tab]);

  useEffect(() => {
    if (!open) return;
    previousFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const focusFirst = window.setTimeout(() => {
      const first = dialogRef.current?.querySelector<HTMLElement>("[data-auth-initial]")
        || dialogRef.current?.querySelector<HTMLElement>(
          "input:not([disabled]), button:not([disabled]), [href], [tabindex]:not([tabindex='-1'])",
        );
      first?.focus();
    }, 0);
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (termsSheetRef.current) setTermsSheet(null);
        else if (closable) onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
        "input:not([disabled]), button:not([disabled]), [href], [tabindex]:not([tabindex='-1'])",
      ) || []).filter((node) => node.offsetParent !== null);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", handler);
    return () => {
      window.clearTimeout(focusFirst);
      window.removeEventListener("keydown", handler);
      previousFocusRef.current?.focus();
    };
  }, [open, onClose, closable]);

  useEffect(() => {
    if (open) document.body.style.overflow = "hidden";
    else document.body.style.overflow = "";
    return () => { document.body.style.overflow = ""; };
  }, [open]);

  function setAgreement(checked: boolean) {
    setAgreedToTerms(checked);
    if (checked) setAgreementPromptSeq(0);
  }

  function requireAgreement() {
    if (agreedToTerms) return true;
    toast.error(t("auth.validate.agreeTerms"));
    // 递增序号会重新挂载提示行，使连续点击也能重新播放一次震动动画。
    setAgreementPromptSeq((seq) => seq + 1);
    window.setTimeout(() => agreementCheckboxRef.current?.focus(), 0);
    return false;
  }

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    if (!requireAgreement()) return;
    if (!loginAuthId.trim() || !loginPassword.trim()) {
      toast.error(t("auth.validate.fillRequired"));
      return;
    }
    setLoading(true);
    try {
      const data = await api.userLogin(loginAuthId.trim(), loginPassword);
      login(data);
      toast.success(t("auth.welcomeBack").replace("{name}", data.name));
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("auth.validate.loginFailed"));
    } finally {
      setLoading(false);
    }
  }

  async function handleRegister(e: React.FormEvent) {
    e.preventDefault();
    if (!requireAgreement()) return;
    if (!regAuthId.trim() || !regName.trim() || !regDepartment.trim() || !regPassword.trim()) {
      toast.error(t("auth.validate.fillAll"));
      return;
    }
    if (regPassword !== regConfirm) {
      toast.error(t("auth.validate.passwordMismatch"));
      return;
    }
    if (regPassword.length < 12) {
      toast.error(t("auth.validate.passwordTooShort"));
      return;
    }
    setLoading(true);
    try {
      const data = await api.userRegister({
        authId: regAuthId.trim(),
        name: regName.trim(),
        department: regDepartment.trim(),
        password: regPassword,
      });
      login(data);
      toast.success(t("auth.welcomeRegister").replace("{name}", data.name));
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("auth.validate.registerFailed"));
    } finally {
      setLoading(false);
    }
  }

  async function handleForgetPassword(e: React.FormEvent) {
    e.preventDefault();
    if (!forgetAuthId.trim() || !forgetApiKey.trim()) {
      toast.error(t("auth.validate.fillAll"));
      return;
    }
    setLoading(true);
    try {
      await api.userRecover(forgetAuthId.trim(), forgetApiKey.trim());
      setForgetDone(true);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("auth.verifyFailed"));
    } finally {
      setLoading(false);
    }
  }

  async function handleResetPassword(e: React.FormEvent) {
    e.preventDefault();
    if (forgetNewPwd.length < 12) { toast.error(t("auth.validate.passwordTooShort")); return; }
    if (forgetNewPwd !== forgetNewPwdConfirm) { toast.error(t("auth.validate.passwordMismatch")); return; }
    setLoading(true);
    try {
      await api.userResetPassword(forgetAuthId.trim(), forgetApiKey.trim(), forgetNewPwd);
      setForgetResetDone(true);
      toast.success(t("auth.resetSuccess"));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("auth.validate.resetFailed"));
    } finally {
      setLoading(false);
    }
  }

  if (!open) return null;

  const brandName = branding.brand;
  const brandTag = branding.platform_name;

  const inputBase =
    "w-full h-12 px-4 rounded-full bg-card text-[14px] text-fg placeholder:text-fg-subtle border border-[var(--border-strong)] outline-none transition-colors apiplatform-focus-glow";
  const inputDisabled = loading ? " opacity-60" : "";
  const submitBase =
    "w-full h-11 rounded-full bg-ink text-bg text-[14px] font-medium hover:bg-ink/80 transition-colors disabled:opacity-50 apiplatform-btn";
  const linkBase = "text-[13px] text-fg-muted hover:text-fg transition-colors";

  // 协议未勾选时仍允许点击，由提交处理器给出明确提示；仅请求进行中才禁用。
  const submitDisabled = loading;
  const modal = (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      className="fixed inset-0 z-[9999] flex max-h-screen flex-col items-center overflow-y-auto bg-card"
      onClick={(e) => { if (closable && e.target === e.currentTarget) onClose(); }}
    >
      {closable && (
        <button
          type="button"
          onClick={onClose}
          className="absolute top-5 right-5 p-2 rounded-full text-fg-subtle hover:text-fg hover:bg-bg-soft transition-colors z-10 apiplatform-hover-scale apiplatform-btn"
          aria-label={t("auth.close")}
        >
          <X className="w-5 h-5" />
        </button>
      )}

      <div className="flex min-h-full w-full max-w-[400px] flex-col items-center justify-center overflow-y-auto px-6 py-10 animate-enter" style={{ fontFamily: "var(--font-sans)" }}>
        <div className="flex items-center gap-3 mb-10">
          <span style={{ background: "var(--ink)", color: "var(--bg)", padding: "6px 14px", borderRadius: 8, fontWeight: 700, fontSize: "24px", fontFamily: "var(--font-serif)", letterSpacing: "-0.01em" }}>
            {brandName}
          </span>
          <span style={{ color: "var(--fg)", fontWeight: 600, fontSize: "18px", fontFamily: "var(--font-serif)" }}>
            {brandTag}
          </span>
        </div>
        <h1 id={titleId} className="sr-only">
          {tab === "login" ? t("auth.login") : tab === "register" ? t("auth.register") : t("auth.forgotPassword")}
        </h1>
        {renderAuthForm()}
      </div>

      <AuthTermsSheet
        sheet={termsSheet}
        onClose={() => setTermsSheet(null)}
        onConfirm={() => setAgreement(true)}
      />
    </div>
  );

  return createPortal(modal, document.body);

  function renderAuthForm() {
    return (
      <>
        {tab === "login" && (
          <form onSubmit={handleLogin} className="w-full space-y-4">
            <input
              data-auth-initial
              className={inputBase + inputDisabled}
              aria-label={t("auth.placeholder.username")}
              placeholder={t("auth.placeholder.username")}
              value={loginAuthId}
              onChange={(e) => setLoginAuthId(e.target.value)}
              autoComplete="username"
              maxLength={128}
              required
              disabled={loading}
            />
            <div className="relative">
              <input
                className={inputBase + inputDisabled}
                aria-label={t("auth.placeholder.password")}
                type={showPwd ? "text" : "password"}
                placeholder={t("auth.placeholder.password")}
                value={loginPassword}
                onChange={(e) => setLoginPassword(e.target.value)}
                autoComplete="current-password"
                maxLength={128}
                required
                disabled={loading}
              />
              <button
                type="button"
                onClick={() => setShowPwd((v) => !v)}
                aria-label={showPwd ? t("auth.hidePassword") : t("auth.showPassword")}
                aria-pressed={showPwd}
                className="absolute right-3.5 top-1/2 -translate-y-1/2 p-1 text-fg-subtle hover:text-fg apiplatform-hover-scale"
              >
                {showPwd ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>

            {!registrationEnabled && (
              <div className="text-[12px] text-fg-subtle leading-relaxed px-1">
                {t("auth.controlledAccess")}
              </div>
            )}

            <div className="flex items-center justify-between px-1 pt-1">
              {recoveryEnabled ? (
                <button type="button" onClick={() => setTab("forget")} className={linkBase}>
                  {t("auth.forgotPassword")}
                </button>
              ) : (
                <span />
              )}
              {registrationEnabled ? (
                <button type="button" onClick={() => setTab("register")} className={linkBase}>
                  {t("auth.register")}
                </button>
              ) : (
                <span />
              )}
            </div>

            <AuthAgreeRow
              checked={agreedToTerms}
              onChange={setAgreement}
              disabled={loading}
              attentionKey={agreementPromptSeq}
              inputRef={agreementCheckboxRef}
              onOpenRules={() => setTermsSheet("rules")}
              onOpenDisclaimer={() => setTermsSheet("disclaimer")}
            />

            <button type="submit" disabled={submitDisabled} className={submitBase}>
              {loading ? t("auth.loggingIn") : t("auth.login")}
            </button>

          </form>
        )}

        {tab === "register" && (
          <form onSubmit={handleRegister} className="w-full space-y-4">
            <input
              className={inputBase + inputDisabled}
              aria-label={t("auth.placeholder.username")}
              placeholder={t("auth.placeholder.username")}
              value={regAuthId}
              onChange={(e) => setRegAuthId(e.target.value)}
              disabled={loading}
              maxLength={128}
              required
            />
            <input
              className={inputBase + inputDisabled}
              aria-label={t("auth.placeholder.realName")}
              placeholder={t("auth.placeholder.realName")}
              value={regName}
              onChange={(e) => setRegName(e.target.value)}
              disabled={loading}
              maxLength={200}
              required
            />
            <input
              className={inputBase + inputDisabled}
              aria-label={t("auth.placeholder.department")}
              placeholder={t("auth.placeholder.department")}
              value={regDepartment}
              onChange={(e) => setRegDepartment(e.target.value)}
              disabled={loading}
              maxLength={200}
              required
            />
            <div className="relative">
              <input
                className={inputBase + inputDisabled}
                aria-label={t("auth.placeholder.passwordMin")}
                type={showRegPwd ? "text" : "password"}
                placeholder={t("auth.placeholder.passwordMin")}
                value={regPassword}
                onChange={(e) => setRegPassword(e.target.value)}
                autoComplete="new-password"
                minLength={12}
                maxLength={128}
                required
                disabled={loading}
              />
              <button
                type="button"
                onClick={() => setShowRegPwd((v) => !v)}
                aria-label={showRegPwd ? t("auth.hidePassword") : t("auth.showPassword")}
                aria-pressed={showRegPwd}
                className="absolute right-3.5 top-1/2 -translate-y-1/2 p-1 text-fg-subtle hover:text-fg apiplatform-hover-scale"
              >
                {showRegPwd ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
            <div className="relative">
              <input
                className={inputBase + inputDisabled}
                aria-label={t("auth.placeholder.confirmPassword")}
                type={showConfirmPwd ? "text" : "password"}
                placeholder={t("auth.placeholder.confirmPassword")}
                value={regConfirm}
                onChange={(e) => setRegConfirm(e.target.value)}
                autoComplete="new-password"
                minLength={12}
                maxLength={128}
                required
                disabled={loading}
              />
              <button
                type="button"
                onClick={() => setShowConfirmPwd((v) => !v)}
                aria-label={showConfirmPwd ? t("auth.hidePassword") : t("auth.showPassword")}
                aria-pressed={showConfirmPwd}
                className="absolute right-3.5 top-1/2 -translate-y-1/2 p-1 text-fg-subtle hover:text-fg apiplatform-hover-scale"
              >
                {showConfirmPwd ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>

            <div className="flex items-center justify-between px-1 pt-1">
              <button type="button" onClick={() => setTab("login")} className={linkBase}>
                {t("auth.goToLogin")}
              </button>
            </div>

            <AuthAgreeRow
              checked={agreedToTerms}
              onChange={setAgreement}
              disabled={loading}
              attentionKey={agreementPromptSeq}
              inputRef={agreementCheckboxRef}
              onOpenRules={() => setTermsSheet("rules")}
              onOpenDisclaimer={() => setTermsSheet("disclaimer")}
            />

            <button type="submit" disabled={submitDisabled} className={submitBase}>
              {loading ? t("auth.registering") : t("auth.register")}
            </button>
          </form>
        )}

        {tab === "forget" && (
          forgetResetDone ? (
            <div className="w-full text-center space-y-5 py-6">
              <div className="w-12 h-12 rounded-full bg-ok/10 flex items-center justify-center mx-auto">
                <svg className="w-6 h-6 text-ok" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <div>
                <p className="text-[16px] text-fg" style={{ fontWeight: 600 }}>{t("auth.resetSuccess")}</p>
                <p className="text-[13px] text-fg-muted mt-1">{t("auth.resetSuccessMsg")}</p>
              </div>
              <button
                onClick={() => { setForgetResetDone(false); setForgetDone(false); setTab("login"); }}
                className={submitBase}
              >
                {t("auth.goToLoginBtn")}
              </button>
            </div>
          ) : forgetDone ? (
            <form onSubmit={handleResetPassword} className="w-full space-y-4">
              <p className="text-[13px] text-fg-muted text-center pb-1">{t("auth.verifySuccess")}</p>
              <div className="relative">
                <input
                  className={inputBase + inputDisabled}
                  aria-label={t("auth.placeholder.newPassword")}
                  type={showNewPwd ? "text" : "password"}
                  placeholder={t("auth.placeholder.newPassword")}
                  value={forgetNewPwd}
                  onChange={(e) => setForgetNewPwd(e.target.value)}
                  autoComplete="new-password"
                  minLength={12}
                  maxLength={128}
                  required
                  disabled={loading}
                />
                <button
                  type="button"
                  onClick={() => setShowNewPwd((v) => !v)}
                  aria-label={showNewPwd ? t("auth.hidePassword") : t("auth.showPassword")}
                  aria-pressed={showNewPwd}
                  className="absolute right-3.5 top-1/2 -translate-y-1/2 p-1 text-fg-subtle hover:text-fg apiplatform-hover-scale"
                >
                  {showNewPwd ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
              <div className="relative">
                <input
                  className={inputBase + inputDisabled}
                  aria-label={t("auth.placeholder.confirmNewPassword")}
                  type={showNewPwdConfirm ? "text" : "password"}
                  placeholder={t("auth.placeholder.confirmNewPassword")}
                  value={forgetNewPwdConfirm}
                  onChange={(e) => setForgetNewPwdConfirm(e.target.value)}
                  autoComplete="new-password"
                  minLength={12}
                  maxLength={128}
                  required
                  disabled={loading}
                />
                <button
                  type="button"
                  onClick={() => setShowNewPwdConfirm((v) => !v)}
                  aria-label={showNewPwdConfirm ? t("auth.hidePassword") : t("auth.showPassword")}
                  aria-pressed={showNewPwdConfirm}
                  className="absolute right-3.5 top-1/2 -translate-y-1/2 p-1 text-fg-subtle hover:text-fg apiplatform-hover-scale"
                >
                  {showNewPwdConfirm ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>

              <div className="flex items-center justify-between px-1 pt-1">
                <button type="button" onClick={() => { setForgetDone(false); setTab("login"); }} className={linkBase}>
                  {t("auth.backToLogin")}
                </button>
              </div>

              <button type="submit" disabled={loading} className={submitBase}>
                {loading ? t("auth.resetting") : t("auth.confirmReset")}
              </button>
            </form>
          ) : (
            <form onSubmit={handleForgetPassword} className="w-full space-y-4">
              <input
                className={inputBase + inputDisabled}
                aria-label={t("auth.placeholder.username")}
                placeholder={t("auth.placeholder.username")}
                value={forgetAuthId}
                onChange={(e) => setForgetAuthId(e.target.value)}
                disabled={loading}
                maxLength={128}
                required
              />
              <input
                className={inputBase + inputDisabled}
                aria-label={t("auth.placeholder.apiKey")}
                type="password"
                placeholder={t("auth.placeholder.apiKey")}
                value={forgetApiKey}
                onChange={(e) => setForgetApiKey(e.target.value)}
                disabled={loading}
                maxLength={512}
                autoComplete="off"
                required
              />

              <div className="flex items-center justify-between px-1 pt-1">
                <button type="button" onClick={() => setTab("login")} className={linkBase}>
                  {t("auth.backToLogin")}
                </button>
              </div>

              <button type="submit" disabled={loading} className={submitBase}>
                {loading ? t("auth.verifying") : t("auth.findPassword")}
              </button>
            </form>
          )
        )}
      </>
    );
  }
}
