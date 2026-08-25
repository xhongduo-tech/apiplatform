/** 开源演示目录的简体中文模型说明。 */
import type { ModelArticle } from "./model-readme-data";
import { getFactoriesForLang } from "./model-readme-snippets";

const { chat, stream, toolCall, curl } = getFactoriesForLang("zh-CN");
const BASE_URL = "{{API_BASE_URL}}";

export const ARTICLES_ZH: Record<string, ModelArticle> = {
  "platform-sota": {
    kicker: "Platform · 演示稳定别名",
    title: "platform-sota",
    subtitle: "由管理员配置目标模型的中性稳定别名；开源演示默认不连接真实上游。",
    badges: [
      { label: "类型", value: "稳定别名" },
      { label: "能力", value: "管理员配置" },
      { label: "数据", value: "虚构演示" },
    ],
    modelInfo: [
      { label: "Model ID", value: "platform-sota" },
      { label: "Base URL", value: BASE_URL },
      { label: "API 格式", value: "OpenAI 兼容" },
      { label: "目标模型", value: "由管理员配置" },
    ],
    lead: "platform-sota 是用于演示稳定路由能力的虚构别名。管理员应在模型管理中将它指向已部署的高能力模型；仓库不预置任何真实上游地址或凭证。",
    highlights: [
      { icon: "brain", title: "稳定调用名称", body: "业务代码使用固定 Model ID，底层目标可由管理员按需调整。" },
      { icon: "tool", title: "统一协议入口", body: "配置上游后，可通过 OpenAI 兼容端点接入。" },
      { icon: "context", title: "部署方决定能力", body: "上下文、速度与功能取决于管理员实际绑定的模型。" },
    ],
    examples: [
      chat("platform-sota"),
      stream("platform-sota"),
      toolCall("platform-sota"),
      curl("platform-sota"),
    ],
    tips: ["先在管理后台配置并验证目标模型，再向用户签发可用密钥。"],
    limitations: ["默认条目仅供界面演示，未配置上游时不能完成推理。"],
  },
  "platform-flash": {
    kicker: "Platform · 演示稳定别名",
    title: "platform-flash",
    subtitle: "由管理员配置目标模型的低延迟别名；开源演示默认不连接真实上游。",
    badges: [
      { label: "类型", value: "稳定别名" },
      { label: "侧重", value: "低延迟" },
      { label: "数据", value: "虚构演示" },
    ],
    modelInfo: [
      { label: "Model ID", value: "platform-flash" },
      { label: "Base URL", value: BASE_URL },
      { label: "API 格式", value: "OpenAI 兼容" },
      { label: "目标模型", value: "由管理员配置" },
    ],
    lead: "platform-flash 是用于演示低延迟路由能力的虚构别名。管理员应将它指向实际部署的快速模型，并在上线前完成连通性验证。",
    highlights: [
      { icon: "speed", title: "低延迟入口", body: "可将别名绑定到部署方选择的快速模型。" },
      { icon: "tool", title: "业务代码稳定", body: "调整目标模型时无需修改客户端中的 Model ID。" },
      { icon: "multi", title: "统一管理", body: "目标模型、端点与凭证均由管理员在后台维护。" },
    ],
    examples: [
      chat("platform-flash"),
      stream("platform-flash"),
      toolCall("platform-flash"),
      curl("platform-flash"),
    ],
    tips: ["按实际业务压测结果选择目标模型，不要依赖演示参数。"],
    limitations: ["默认条目仅供界面演示，未配置上游时不能完成推理。"],
  },
};
