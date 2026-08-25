import { useState } from "react";
import { ThumbsUp, ThumbsDown, Send, MessageSquarePlus } from "lucide-react";
import { Link } from "react-router-dom";

import { api } from "../../api/gateway";
import { useAuth } from "../../hooks/use-auth";
import { useT } from "../../i18n";
import { DOCS_ISSUE_HREF } from "./docs-constants";

export function DocsFeedback({ section }: { section?: string } = {}) {
  const { t, lang } = useT();
  const { user } = useAuth();
  const [vote, setVote] = useState<"up" | "down" | null>(null);
  const [text, setText] = useState("");
  const [submitted, setSubmitted] = useState(false);

  const handleVote = (v: "up" | "down") => {
    setVote(v);
    setSubmitted(false);
  };

  const handleSubmit = () => {
    if (!vote) return;
    // 先给出已提交的反馈，不让用户等网络往返；反馈本身不是关键路径，
    // 失败也不该弹错打断阅读——后端有限流与校验，丢一条无妨。
    setSubmitted(true);
    void api
      .docFeedback(
        { vote, section, comment: text.trim() || undefined, lang },
        user?.token,
      )
      .catch(() => { /* 反馈失败静默：不打断文档阅读 */ });
  };

  return (
    <div className="docs-feedback">
      <p className="docs-feedback__question">{t("docsPage.feedback.question")}</p>
      <div className="docs-feedback__actions">
        <button
          className={`docs-feedback__btn ${vote === "up" ? "docs-feedback__btn--active" : ""}`}
          onClick={() => handleVote("up")}
        >
          <ThumbsUp size={14} />
          <span>{t("docsPage.feedback.yes")}</span>
        </button>
        <button
          className={`docs-feedback__btn ${vote === "down" ? "docs-feedback__btn--active" : ""}`}
          onClick={() => handleVote("down")}
        >
          <ThumbsDown size={14} />
          <span>{t("docsPage.feedback.no")}</span>
        </button>
      </div>

      {vote && !submitted && (
        <>
          <textarea
            className="docs-feedback__textarea"
            placeholder={t("docsPage.feedback.placeholder")}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <button className="docs-feedback__submit" onClick={handleSubmit}>
            <Send size={12} />
            <span>{t("docsPage.feedback.submit")}</span>
          </button>
        </>
      )}

      {submitted && (
        <p className="docs-feedback__thanks">{t("docsPage.feedback.thanks")}</p>
      )}

      <div className="docs-feedback__footer">
        <p className="docs-feedback__note">{t("docsPage.feedback.localNote")}</p>
        <Link to={DOCS_ISSUE_HREF} className="docs-feedback__report">
          <MessageSquarePlus size={13} />
          <span>{t("docsPage.feedback.reportIssue")}</span>
        </Link>
      </div>
    </div>
  );
}
