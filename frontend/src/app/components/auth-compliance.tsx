import { Fragment, type Ref } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { useT } from "../i18n";
import type { Lang } from "../i18n/index";

type Segment = { text: string; red?: boolean };

const RED_CLASS = "text-red-600 dark:text-red-400 font-semibold";

function HighlightSpan({ segments }: { segments: Segment[] }) {
  return (
    <>
      {segments.map((seg, i) =>
        seg.red ? (
          <span key={i} className={RED_CLASS}>{seg.text}</span>
        ) : (
          <Fragment key={i}>{seg.text}</Fragment>
        ),
      )}
    </>
  );
}

// ─── 简体中文 ───────────────────────────────────────────

const RULES_ZH_CN: Segment[][] = [
  [
    { text: "严禁", red: true },
    { text: "通过 API 上传、传输或处理任何" },
    { text: "涉密、机密文档及内部敏感信息", red: true },
  ],
  [
    { text: "API Key 属于个人凭证，" },
    { text: "严禁共享或转让", red: true },
    { text: "，若发现泄露请" },
    { text: "立即联系管理员撤销", red: true },
  ],
  [
    { text: "禁止", red: true },
    { text: "将平台接口用于任何" },
    { text: "违反适用法律法规或部署方使用规则", red: true },
    { text: "的用途" },
  ],
  [
    { text: "严禁调用", red: true },
    { text: " API 生成、传播" },
    { text: "虚假信息、违法内容或侵犯他人知识产权", red: true },
    { text: "的内容" },
  ],
  [
    { text: "平台资源由全员共享，请" },
    { text: "合理规划调用频率", red: true },
    { text: "，" },
    { text: "避免无意义的高频空跑", red: true },
  ],
  [
    { text: "所有 API 调用日志将留存用于" },
    { text: "合规审计", red: true },
    { text: "，调用行为须" },
    { text: "符合数据安全规范", red: true },
  ],
  [
    { text: "用户需" },
    { text: "妥善保管", red: true },
    { text: "平台账号及密码，因账号被盗用或借用导致的 API 滥用行为，" },
    { text: "由账号持有人承担相应责任", red: true },
  ],
  [
    { text: "如将通过平台 API 生成的内容对外公开发布，" },
    { text: "须按适用规则标注", red: true },
    { text: "\u201C由 AI 生成/辅助生成\u201D", red: true },
  ],
  [
    { text: "通过本平台 API 生成的内容，其知识产权归属" },
    { text: "按适用法律与部署方规则执行", red: true },
  ],
  [
    { text: "违反上述任一规范的用户，平台有权视情节严重程度采取" },
    { text: "暂停 API 权限", red: true },
    { text: "、" },
    { text: "永久封禁账号", red: true },
    { text: "等措施，并" },
    { text: "通知部署方管理员", red: true },
  ],
];

const DISCLAIMER_ZH_CN: Segment[] = [
  { text: "本平台由部署方自行运营，只应用于其授权的研发、业务或创新场景。" },
  { text: "输入数据的处理方式由部署方及其所配置的上游服务决定", red: true },
  { text: "。平台" },
  { text: "不对模型输出内容的准确性、完整性或适用性作出保证", red: true },
  { text: "；用户应对模型输出进行独立判断，并对其在业务中的使用" },
  { text: "承担相应责任", red: true },
  { text: "。平台" },
  { text: "不保证 7\u00D724 小时不间断服务", red: true },
  { text: "，因系统维护、升级或不可抗力导致的服务中断，平台" },
  { text: "不承担责任", red: true },
  { text: "。平台有权根据合规要求或资源状况调整服务内容，如需变更将提前通知。使用本平台即视为同意上述规范与声明。" },
];

// ─── 繁體中文 ───────────────────────────────────────────

const RULES_ZH_TW: Segment[][] = [
  [
    { text: "嚴禁", red: true },
    { text: "透過 API 上傳、傳輸或處理任何" },
    { text: "涉密、機密文件及內部敏感資訊", red: true },
  ],
  [
    { text: "API Key 屬於個人憑證，" },
    { text: "嚴禁共享或轉讓", red: true },
    { text: "，若發現洩露請" },
    { text: "立即聯繫管理員撤銷", red: true },
  ],
  [
    { text: "禁止", red: true },
    { text: "將平台介面用於任何" },
    { text: "違反適用法律法規或部署方使用規則", red: true },
    { text: "的用途" },
  ],
  [
    { text: "嚴禁呼叫", red: true },
    { text: " API 生成、傳播" },
    { text: "虛假資訊、違法內容或侵犯他人智慧財產權", red: true },
    { text: "的內容" },
  ],
  [
    { text: "平台資源由全員共享，請" },
    { text: "合理規劃呼叫頻率", red: true },
    { text: "，" },
    { text: "避免無意義的高頻空跑", red: true },
  ],
  [
    { text: "所有 API 呼叫日誌將留存用於" },
    { text: "合規稽核", red: true },
    { text: "，呼叫行為須" },
    { text: "符合資料安全規範", red: true },
  ],
  [
    { text: "使用者需" },
    { text: "妥善保管", red: true },
    { text: "平台帳號及密碼，因帳號被盜用或借用導致的 API 濫用行為，" },
    { text: "由帳號持有人承擔相應責任", red: true },
  ],
  [
    { text: "如將透過平台 API 生成的內容對外公開發布，" },
    { text: "須依適用規則標註", red: true },
    { text: "\u201C由 AI 生成/輔助生成\u201D", red: true },
  ],
  [
    { text: "透過本平台 API 生成的內容，其智慧財產權歸屬" },
    { text: "依適用法律與部署方規則執行", red: true },
  ],
  [
    { text: "違反上述任一規範的使用者，平台有權視情節嚴重程度採取" },
    { text: "暫停 API 權限", red: true },
    { text: "、" },
    { text: "永久封禁帳號", red: true },
    { text: "等措施，並" },
    { text: "通報所在部門及合規部門", red: true },
  ],
];

const DISCLAIMER_ZH_TW: Segment[] = [
  { text: "本平台由部署方自行營運，僅應用於其授權的研發、業務或創新場景。" },
  { text: "輸入資料的處理方式由部署方及其所設定的上游服務決定", red: true },
  { text: "。平台" },
  { text: "不對模型輸出內容的準確性、完整性或適用性作出保證", red: true },
  { text: "；使用者應對模型輸出進行獨立判斷，並對其在業務中的使用" },
  { text: "承擔相應責任", red: true },
  { text: "。平台" },
  { text: "不保證 7\u00D724 小時不間斷服務", red: true },
  { text: "，因系統維護、升級或不可抗力導致的服務中斷，平台" },
  { text: "不承擔責任", red: true },
  { text: "。平台有權根據合規要求或資源狀況調整服務內容，如需變更將提前通知。使用本平台即視為同意上述規範與聲明。" },
];

// ─── English ────────────────────────────────────────────

const RULES_EN: Segment[][] = [
  [
    { text: "It is strictly prohibited", red: true },
    { text: " to upload, transmit, or process any " },
    { text: "classified, confidential documents or internal sensitive information", red: true },
    { text: " through the API." },
  ],
  [
    { text: "API Keys are personal credentials. " },
    { text: "Sharing or transferring them is strictly prohibited", red: true },
    { text: ". If a leak is discovered, " },
    { text: "immediately contact the administrator to revoke it", red: true },
    { text: "." },
  ],
  [
    { text: "It is prohibited", red: true },
    { text: " to use the platform API for any purpose that " },
    { text: "violates applicable law or the operator's acceptable-use policy", red: true },
    { text: "." },
  ],
  [
    { text: "It is strictly prohibited", red: true },
    { text: " to use the API to generate or spread " },
    { text: "false information, illegal content, or content that infringes upon intellectual property rights", red: true },
    { text: "." },
  ],
  [
    { text: "Platform resources are shared by all. Please " },
    { text: "plan your call frequency reasonably", red: true },
    { text: " and " },
    { text: "avoid meaningless high-frequency calls", red: true },
    { text: "." },
  ],
  [
    { text: "All API call logs will be retained for " },
    { text: "compliance auditing", red: true },
    { text: ". Usage must " },
    { text: "comply with data security standards", red: true },
    { text: "." },
  ],
  [
    { text: "Users must " },
    { text: "properly safeguard", red: true },
    { text: " their platform account credentials. Any API abuse caused by account theft or sharing shall be " },
    { text: "the responsibility of the account holder", red: true },
    { text: "." },
  ],
  [
    { text: "If content generated through the platform API is publicly released, it " },
    { text: "must be labeled", red: true },
    { text: " \u201C" },
    { text: "AI-generated / AI-assisted", red: true },
    { text: "\u201D in accordance with applicable rules." },
  ],
  [
    { text: "Intellectual property rights for content generated through this platform's API shall " },
    { text: "be governed by applicable law and the operator's policies", red: true },
    { text: "." },
  ],
  [
    { text: "For users who violate any of the above rules, the platform reserves the right to take measures such as " },
    { text: "suspending API access", red: true },
    { text: " or " },
    { text: "permanently banning accounts", red: true },
    { text: " depending on severity, and will " },
    { text: "notify the platform operator", red: true },
    { text: "." },
  ],
];

const DISCLAIMER_EN: Segment[] = [
  { text: "This platform is self-hosted and should only be used for scenarios authorized by its operator. " },
  { text: "Input-data handling depends on the operator and the upstream services it configures", red: true },
  { text: ". The platform " },
  { text: "makes no guarantees regarding the accuracy, completeness, or suitability of model outputs", red: true },
  { text: "; users should independently evaluate model outputs and " },
  { text: "bear corresponding responsibility", red: true },
  { text: " for their use in business. The platform " },
  { text: "does not guarantee 24/7 uninterrupted service", red: true },
  { text: " and " },
  { text: "shall not be liable", red: true },
  { text: " for service interruptions caused by system maintenance, upgrades, or force majeure. The platform reserves the right to adjust service content based on compliance requirements or resource conditions, with prior notice for any changes. By using this platform, you agree to the above rules and disclaimers." },
];

// ─── Language lookup ─────────────────────────────────────

function getRules(lang: Lang): Segment[][] {
  if (lang === "zh-TW") return RULES_ZH_TW;
  if (lang === "en") return RULES_EN;
  return RULES_ZH_CN;
}

function getDisclaimer(lang: Lang): Segment[] {
  if (lang === "zh-TW") return DISCLAIMER_ZH_TW;
  if (lang === "en") return DISCLAIMER_EN;
  return DISCLAIMER_ZH_CN;
}

export type TermsSheet = "rules" | "disclaimer" | null;

const linkClass =
  "text-fg underline underline-offset-2 decoration-fg-subtle hover:decoration-fg transition-colors";

export function AuthAgreeRow({
  checked,
  onChange,
  disabled,
  attentionKey = 0,
  inputRef,
  onOpenRules,
  onOpenDisclaimer,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  attentionKey?: number;
  inputRef?: Ref<HTMLInputElement>;
  onOpenRules: () => void;
  onOpenDisclaimer: () => void;
}) {
  const { t } = useT();
  return (
    <label
      key={attentionKey || undefined}
      className={`flex items-start gap-2.5 px-1 cursor-pointer select-none rounded-md ${attentionKey > 0 ? "auth-agreement-attention" : ""}`}
      style={{ opacity: disabled ? 0.55 : 1 }}
    >
      <input
        ref={inputRef}
        type="checkbox"
        checked={checked}
        aria-invalid={attentionKey > 0 && !checked}
        onChange={(e) => onChange(e.target.checked)}
        disabled={disabled}
        className="mt-0.5 h-3.5 w-3.5 shrink-0 rounded border-fg-subtle accent-brand cursor-pointer"
      />
      <span className="text-[12px] text-fg-subtle leading-relaxed">
        {t("auth.agreeRow")}
        <button type="button" className={linkClass + " mx-0.5"} onClick={(e) => { e.preventDefault(); e.stopPropagation(); onOpenRules(); }}>
          {t("auth.usageRules")}
        </button>
        {t("auth.and")}
        <button type="button" className={linkClass + " mx-0.5"} onClick={(e) => { e.preventDefault(); e.stopPropagation(); onOpenDisclaimer(); }}>
          {t("auth.disclaimerTitle")}
        </button>
      </span>
    </label>
  );
}

export function AuthTermsSheet({
  sheet,
  onClose,
  onConfirm,
}: {
  sheet: TermsSheet;
  onClose: () => void;
  onConfirm?: () => void;
}) {
  const { t, lang } = useT();

  if (!sheet) return null;

  const isRules = sheet === "rules";
  const title = isRules ? t("auth.usageRules") : t("auth.disclaimerTitle");
  const rules = getRules(lang);
  const disclaimer = getDisclaimer(lang);

  return createPortal(
    <div
      className="fixed inset-0 z-[10000] flex items-end sm:items-center justify-center p-4 sm:p-6"
      onClick={onClose}
    >
      <div className="absolute inset-0 bg-ink/25 backdrop-blur-[2px]" aria-hidden="true" />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="auth-terms-title"
        className="relative w-full max-w-[420px] max-h-[min(520px,85vh)] flex flex-col rounded-2xl bg-card shadow-pop animate-enter"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-border shrink-0">
          <h2 id="auth-terms-title" className="m-0 font-serif text-[15px] font-medium text-fg">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-full text-fg-subtle hover:text-fg hover:bg-bg-soft transition-colors"
            aria-label={t("auth.close")}
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="overflow-y-auto px-5 py-4 flex-1">
          {isRules ? (
            <ol className="m-0 list-none space-y-3">
              {rules.map((segments, i) => (
                <li key={i} className="flex gap-2.5">
                  <span className="text-[12px] font-semibold text-fg-subtle tabular-nums shrink-0 w-4">{i + 1}</span>
                  <span className="text-[13px] text-fg-muted leading-relaxed">
                    <HighlightSpan segments={segments} />
                  </span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-[13px] text-fg-muted leading-[1.75] m-0">
              <HighlightSpan segments={disclaimer} />
            </p>
          )}
        </div>
        <div className="px-5 py-4 border-t border-border shrink-0">
          <button
            type="button"
            onClick={() => { onConfirm?.(); onClose(); }}
            className="w-full h-10 rounded-full bg-ink text-bg text-[13px] font-medium hover:bg-ink/80 transition-colors"
          >
            {t("auth.iUnderstand")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
