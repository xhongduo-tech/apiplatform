import { useState, useEffect } from "react";
import { api, type PlatformConfig } from "../../api/gateway";
import { HeroSection } from "./hero-section";
import { ChooseSection } from "./choose-section";
import { WorkflowSection } from "./workflow-section";
import { ModelFamilySection } from "./model-family-section";
import { PlatformInfraSection } from "./platform-section";

import { GetStartedSection } from "./get-started-section";
import { HomeFooter } from "./home-footer";

/* ── 滚动入场:IntersectionObserver 驱动 apiplatform-reveal → apiplatform-revealed ───── */
function useScrollReveal() {
  useEffect(() => {
    const revealAll = () =>
      document.querySelectorAll(".apiplatform-reveal:not(.apiplatform-revealed)").forEach((el) =>
        el.classList.add("apiplatform-revealed"),
      );
    // 旧内核无 IntersectionObserver:直接全部可见(CSS 侧另有
    // no-intersection-observer 兜底),绝不能让 useEffect 抛错整页崩溃
    if (typeof IntersectionObserver === "undefined") {
      revealAll();
      return;
    }
    let io: IntersectionObserver | null = null;
    try {
      io = new IntersectionObserver(
        (entries) => {
          entries.forEach((e) => {
            if (e.isIntersecting) {
              (e.target as HTMLElement).classList.add("apiplatform-revealed");
              io?.unobserve(e.target);
            }
          });
        },
        { threshold: 0.08, rootMargin: "0px 0px -56px 0px" },
      );
      document.querySelectorAll(".apiplatform-reveal:not(.apiplatform-revealed)").forEach((el) =>
        io!.observe(el),
      );
    } catch {
      revealAll();  // IO 构造异常(个别旧内核)→ 直接全显,绝不留白
    }
    // 安全兜底:无论 IO 是否触发,2.4s 后强制显示所有残留 reveal 元素
    const t = window.setTimeout(revealAll, 2400);
    return () => {
      io?.disconnect();
      window.clearTimeout(t);
    };
  }, []);
}

/* 首页:
   hero(搜索 + 代码卡)/ 接入方式 / 从想法到生产 / 模型家族 / 平台底座 */
export function Home() {
  const [cfg, setCfg] = useState<PlatformConfig | null>(null);
  useEffect(() => {
    api.config().then(setCfg).catch(() => {});
  }, []);

  useScrollReveal();

  const ps = cfg?.platform_stats;

  return (
    <div>
      <HeroSection cfg={cfg} />
      <ChooseSection />
      <WorkflowSection />
      <ModelFamilySection />
      <PlatformInfraSection
        totalCalls={ps?.total_calls ?? 0}
        totalTokens={ps?.total_tokens ?? 0}
        activeKeys={ps?.active_keys ?? 0}
      />

      <GetStartedSection />
      <HomeFooter />
    </div>
  );
}
