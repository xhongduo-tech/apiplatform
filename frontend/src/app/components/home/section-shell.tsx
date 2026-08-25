import type { ReactNode } from "react";

/* 首页统一小节骨架:eyebrow(大写陶土橙)+ 衬线标题 + 说明 + 内容
   与 platform.claude.com/docs 的 PLATFORM / WORKFLOW / MODELS 小节同构 */
export function HomeSection({
  id,
  eyebrow,
  title,
  desc,
  children,
}: {
  id?: string;
  eyebrow: string;
  title: string;
  desc?: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="apiplatform-reveal mx-auto w-full max-w-[1200px] px-6 md:px-8 lg:px-10 py-10 md:py-16">
      <p className="section-label">{eyebrow}</p>
      {/* 参考站小节 h2 实测 28px/500,桌面端不再放大 */}
      <h2 className="mt-3 font-serif text-[28px] font-medium leading-snug">{title}</h2>
      {/* 小节导语与 hero 副标题同规格:衬线 18px/430 + 专用导语暖灰 */}
      {desc && <p className="mt-3 font-serif text-[17px] font-[430] leading-relaxed text-fg-lead md:text-[18px]">{desc}</p>}
      <div className="mt-10">{children}</div>
    </section>
  );
}
