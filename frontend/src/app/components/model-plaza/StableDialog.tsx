/**
 * StableDialog — STABLE / LTS 固定接入别名说明弹窗
 *
 * 从 ModelPlaza.tsx 抽出。展示 platform-sota / platform-flash 两个固定别名及其当前指向。
 */
import { Sparkles, Zap, Copy, Check } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogClose } from "../ui/dialog";
import { useT } from "../../i18n";

export interface StableDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** platform-sota 当前解析到的真实模型 id */
  sotaResolved: string;
  /** platform-flash 当前解析到的真实模型 id */
  flashResolved: string;
  /** 已复制的 id（用于显示对勾） */
  copiedId: string | null;
  /** 复制回调 */
  onCopy: (id: string) => void;
}

export function StableDialog({
  open, onOpenChange, sotaResolved, flashResolved, copiedId, onCopy,
}: StableDialogProps) {
  const { t } = useT();

  const items = [
    { alias: "platform-sota",  resolved: sotaResolved,  variant: "sota"  as const, desc: t("modelPlaza.stable.sotaDesc"),  Icon: Sparkles },
    { alias: "platform-flash", resolved: flashResolved, variant: "flash" as const, desc: t("modelPlaza.stable.flashDesc"), Icon: Zap },
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogClose onClick={() => onOpenChange(false)} ariaLabel={t("common.close")} />
        <DialogHeader>
          <DialogTitle>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
              <span
                style={{
                  fontSize: 10, fontWeight: 550, letterSpacing: "0.08em",
                  padding: "2px 8px", borderRadius: 5,
                  background: "var(--brand-soft)", color: "var(--brand)",
                }}
              >
                STABLE
              </span>
              {t("modelPlaza.stable.title")}
            </span>
          </DialogTitle>
          <DialogDescription>
            <div style={{ margin: "0 0 18px", fontSize: 13.5, lineHeight: 1.75, color: "var(--fg-muted)" }}>
              {t("modelPlaza.stable.desc")}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {items.map(({ alias, resolved, desc, Icon }) => {
                const copied = copiedId === alias;
                return (
                  <div
                    key={alias}
                    style={{
                      display: "flex", alignItems: "center", gap: 12,
                      padding: "12px 14px", borderRadius: 10,
                      border: "1px solid var(--border)", background: "var(--bg)",
                    }}
                  >
                    <div
                      style={{
                        width: 30, height: 30, borderRadius: 8, flexShrink: 0,
                        display: "flex", alignItems: "center", justifyContent: "center",
                        background: "var(--brand-soft)", color: "var(--brand)",
                      }}
                    >
                      <Icon size={15} strokeWidth={2} />
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <code style={{ fontFamily: "var(--font-mono)", fontSize: 13.5, fontWeight: 600, color: "var(--fg)" }}>
                          {alias}
                        </code>
                        <span
                          role="button" tabIndex={0}
                          onClick={() => onCopy(alias)}
                          onKeyDown={(e) => { if (e.key === "Enter") onCopy(alias); }}
                          aria-label={`复制 ${alias}`}
                          style={{
                            display: "inline-flex", alignItems: "center", justifyContent: "center",
                            padding: 3, borderRadius: 4, background: "transparent", border: "none",
                            color: "var(--fg-subtle)", cursor: "pointer",
                          }}
                        >
                          {copied ? <Check size={13} strokeWidth={2} /> : <Copy size={13} strokeWidth={1.8} />}
                        </span>
                      </div>
                      <div style={{ fontSize: 11.5, color: "var(--fg-muted)", marginTop: 3, lineHeight: 1.5 }}>
                        {desc}
                      </div>
                    </div>
                    <div style={{ flexShrink: 0, textAlign: "right" }}>
                      <div style={{ fontSize: 10, color: "var(--fg-subtle)", marginBottom: 2, letterSpacing: "0.04em" }}>
                        {t("modelPlaza.stable.pointsTo")}
                      </div>
                      <code style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--brand)" }}>
                        {resolved}
                      </code>
                    </div>
                  </div>
                );
              })}
            </div>
          </DialogDescription>
        </DialogHeader>
      </DialogContent>
    </Dialog>
  );
}
