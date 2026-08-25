/** English model notes for the synthetic open-source catalog. */
import type { ModelArticle } from "./model-readme-data";
import { getFactoriesForLang } from "./model-readme-snippets";

const { chat, stream, toolCall, curl } = getFactoriesForLang("en");
const BASE_URL = "{{API_BASE_URL}}";

export const ARTICLES_EN: Record<string, ModelArticle> = {
  "platform-sota": {
    kicker: "Platform · Demo Stable Alias",
    title: "platform-sota",
    subtitle: "A neutral stable alias whose target is configured by an administrator; the open-source demo has no real upstream.",
    badges: [
      { label: "Type", value: "Stable Alias" },
      { label: "Capability", value: "Admin Configured" },
      { label: "Data", value: "Fictional Demo" },
    ],
    modelInfo: [
      { label: "Model ID", value: "platform-sota" },
      { label: "Base URL", value: BASE_URL },
      { label: "API Format", value: "OpenAI Compatible" },
      { label: "Target Model", value: "Configured by administrator" },
    ],
    lead: "platform-sota is a fictional alias that demonstrates stable routing. An administrator should point it to a deployed high-capability model; this repository ships no real upstream URL or credential.",
    highlights: [
      { icon: "brain", title: "Stable Call Name", body: "Clients keep one model ID while administrators can change the target." },
      { icon: "tool", title: "Unified Protocol", body: "Once configured, the target is available through the OpenAI-compatible endpoint." },
      { icon: "context", title: "Deployment-Defined Capability", body: "Context, speed, and features depend on the model selected by the administrator." },
    ],
    examples: [
      chat("platform-sota"),
      stream("platform-sota"),
      toolCall("platform-sota"),
      curl("platform-sota"),
    ],
    tips: ["Configure and verify the target model before issuing usable API keys."],
    limitations: ["This default entry is UI demo data and cannot infer until an upstream is configured."],
  },
  "platform-flash": {
    kicker: "Platform · Demo Stable Alias",
    title: "platform-flash",
    subtitle: "A low-latency alias whose target is configured by an administrator; the open-source demo has no real upstream.",
    badges: [
      { label: "Type", value: "Stable Alias" },
      { label: "Focus", value: "Low Latency" },
      { label: "Data", value: "Fictional Demo" },
    ],
    modelInfo: [
      { label: "Model ID", value: "platform-flash" },
      { label: "Base URL", value: BASE_URL },
      { label: "API Format", value: "OpenAI Compatible" },
      { label: "Target Model", value: "Configured by administrator" },
    ],
    lead: "platform-flash is a fictional alias demonstrating low-latency routing. Point it to a deployed fast model and run connectivity checks before production use.",
    highlights: [
      { icon: "speed", title: "Low-Latency Entry", body: "Bind the alias to the fast model selected by the deployment owner." },
      { icon: "tool", title: "Stable Client Code", body: "Changing the target does not require changing the client model ID." },
      { icon: "multi", title: "Central Management", body: "Administrators manage the target, endpoint, and credential in the console." },
    ],
    examples: [
      chat("platform-flash"),
      stream("platform-flash"),
      toolCall("platform-flash"),
      curl("platform-flash"),
    ],
    tips: ["Choose the target from your own benchmark results, not the demo metadata."],
    limitations: ["This default entry is UI demo data and cannot infer until an upstream is configured."],
  },
};
