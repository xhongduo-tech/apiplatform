import { useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import {
  MessageSquare,
  Zap,
  AlertTriangle,
  ArrowRight,
  X,
} from "lucide-react";
import { useT } from "../i18n";
import { usePlatformConfig } from "../hooks/use-platform-config";
import { useModalFocus } from "../accessibility";

interface ContactDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const accentMap = {
  brand: {
    iconBg: "rgba(var(--brand-rgb), 0.10)",
    iconColor: "var(--brand)",
    topBorder: "var(--brand)",
    tagBg: "var(--brand-solid)",
    tagColor: "#ffffff",
  },
  default: {
    iconBg: "var(--bg-soft)",
    iconColor: "var(--fg)",
    topBorder: "var(--border-strong)",
    tagBg: "transparent",
    tagColor: "transparent",
  },
  danger: {
    iconBg: "var(--danger-soft)",
    iconColor: "var(--danger)",
    topBorder: "var(--danger)",
    tagBg: "transparent",
    tagColor: "transparent",
  },
};

export function ContactDialog({ open, onOpenChange }: ContactDialogProps) {
  const { t } = useT();
  const { branding } = usePlatformConfig();
  const navigate = useNavigate();
  const dialogRef = useRef<HTMLDivElement>(null);

  const options = [
    {
      key: "feedback" as const,
      icon: MessageSquare,
      title: t("contact.feedback.title"),
      tag: t("contact.feedback.tag"),
      description: t("contact.feedback.desc"),
      meta: t("contact.feedback.meta"),
      action: t("contact.feedback.action"),
      accent: "brand" as const,
    },
    {
      key: "concurrency" as const,
      icon: Zap,
      title: t("contact.concurrency.title"),
      description: t("contact.concurrency.desc"),
      meta: `${branding.approval_department} · ${branding.approval_contact} · ${branding.approval_email}`,
      action: null,
      accent: "default" as const,
    },
    {
      key: "emergency" as const,
      icon: AlertTriangle,
      title: t("contact.emergency.title"),
      description: t("contact.emergency.desc"),
      meta: `${branding.support_department} · ${branding.support_contact} · ${branding.support_email}`,
      action: null,
      accent: "danger" as const,
    },
  ];

  const handleClose = useCallback(() => onOpenChange(false), [onOpenChange]);

  const handleGoFeedback = useCallback(() => {
    onOpenChange(false);
    navigate("/forum");
  }, [navigate, onOpenChange]);

  useModalFocus({ open, containerRef: dialogRef, onClose: handleClose });

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[9999] overflow-y-auto overscroll-contain"
      style={{ backgroundColor: "var(--overlay)" }}
    >
      <div
        className="flex min-h-full items-center justify-center p-4 sm:p-6"
        onClick={(e) => { if (e.target === e.currentTarget) handleClose(); }}
      >
      <div
        ref={dialogRef}
        className="animate-enter w-full max-w-3xl max-h-[calc(100vh-2rem)] rounded-2xl border relative overflow-x-hidden overflow-y-auto"
        style={{
          backgroundColor: "var(--card)",
          borderColor: "var(--border)",
          borderWidth: "var(--hairline)",
          boxShadow: "var(--shadow-hard)",
        }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="contact-title"
        aria-describedby="contact-description"
        tabIndex={-1}
      >
        <button
          type="button"
          className="absolute top-4 right-4 z-10 p-2 rounded-lg text-[var(--fg-subtle)] hover:bg-[var(--bg-soft)] transition-colors"
          aria-label={t("contact.close")}
          onClick={handleClose}
        >
          <X className="w-4 h-4" aria-hidden="true" />
        </button>

        <div className="p-6 sm:p-8">
          {/* Header */}
          <div className="mb-7">
            <h2
              id="contact-title"
              className="text-[22px] sm:text-[26px] tracking-tight"
              style={{
                fontFamily: "var(--font-serif)",
                fontWeight: 700,
                color: "var(--fg)",
              }}
            >
              {t("contact.title")}
            </h2>
            <p
              id="contact-description"
              className="mt-2 text-[14px] max-w-lg"
              style={{
                color: "var(--fg-muted)",
                fontFamily: "var(--font-sans)",
              }}
            >
              {t("contact.subtitle")}
            </p>
          </div>

          {/* Cards */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            {options.map((opt) => {
              const Icon = opt.icon;
              const accent = accentMap[opt.accent];

              return (
                <div
                  key={opt.key}
                  className="group relative rounded-xl border bg-[var(--card)] hover:bg-[var(--card-hover)] transition-colors flex flex-col"
                  style={{
                    borderColor: "var(--border)",
                    borderWidth: "var(--hairline)",
                  }}
                >
                  <div
                    className="absolute top-0 left-0 right-0 h-[3px] rounded-t-xl"
                    style={{ backgroundColor: accent.topBorder }}
                  />

                  <div className="p-5 flex flex-col flex-1">
                    <div
                      className="w-10 h-10 rounded-lg flex items-center justify-center mb-4"
                      style={{
                        backgroundColor: accent.iconBg,
                        color: accent.iconColor,
                      }}
                    >
                      <Icon className="w-5 h-5" />
                    </div>

                    <div className="flex items-center gap-2 mb-2">
                      <h3
                        className="font-serif text-[15px] font-medium"
                        style={{ color: "var(--fg)" }}
                      >
                        {opt.title}
                      </h3>
                      {opt.tag && (
                        <span
                          className="text-[11px] px-1.5 py-0.5 rounded font-medium leading-none"
                          style={{
                            backgroundColor: accent.tagBg,
                            color: accent.tagColor,
                            fontFamily: "var(--font-sans)",
                          }}
                        >
                          {opt.tag}
                        </span>
                      )}
                    </div>

                    <p
                      className="text-[13px] leading-relaxed flex-1"
                      style={{
                        color: "var(--fg-muted)",
                        fontFamily: "var(--font-sans)",
                      }}
                    >
                      {opt.description}
                    </p>

                    <div className="mt-4 pt-4" style={{ borderTop: "var(--hairline) solid var(--border)" }}>
                      {opt.action ? (
                        <button
                          type="button"
                          className="inline-flex items-center gap-1.5 text-[13px] font-medium transition-colors hover:opacity-90"
                          style={{
                            color: "var(--brand)",
                            fontFamily: "var(--font-sans)",
                          }}
                          onClick={handleGoFeedback}
                        >
                          {opt.action}
                          <ArrowRight className="w-3.5 h-3.5 transition-transform group-hover:translate-x-0.5" />
                        </button>
                      ) : (
                        <div>
                          <p
                            className="text-[11px] uppercase tracking-wider mb-1"
                            style={{
                              color: "var(--fg-subtle)",
                              fontFamily: "var(--font-sans)",
                            }}
                          >
                            {t("contact.contactPerson")}
                          </p>
                          <p
                            className="text-[13px] font-medium"
                            style={{
                              color: "var(--fg)",
                              fontFamily: "var(--font-sans)",
                            }}
                          >
                            {opt.meta}
                          </p>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Footer */}
          <div
            className="mt-6 text-center text-[12px]"
            style={{
              color: "var(--fg-subtle)",
              fontFamily: "var(--font-sans)",
            }}
          >
            {t("contact.footer", { group: branding.support_department })}
          </div>
        </div>
      </div>
      </div>
    </div>,
    document.body,
  );
}
