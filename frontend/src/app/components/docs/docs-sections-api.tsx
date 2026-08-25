import { useT } from "../../i18n";
import { CodeTabs, Note, ParamTable, ResponseFields, StreamingHint, P, MethodPill, DocsH2, DocsH3 } from "./docs-shared";
import { Html } from "./i18n-html";
import { CodeBlock } from "../code-block";
import { SCENARIO_CODE, SCENARIO_FILE, tabLang, BASE_URL, RESPONSE_CHAT, RESPONSE_STREAM, RESPONSE_EMBEDDING, RESPONSE_RERANK, RESPONSE_OCR, RESPONSE_COMPLETIONS, RESPONSE_MESSAGES, RESPONSE_RESPONSES } from "./scenario-data";
import { ResponseBlock } from "./response-block";
import { useDocsLanguage } from "./docs-language-context";

/**
 * Capabilities —— 都是 `POST /v1/chat/completions` 之上的能力，
 * 归入「Capabilities」组，与真正独立的端点区分开。
 */
export function DocsApiCapabilities() {
  const { t } = useT();

  return (
    <>
      <section id="thinking-mode" className="docs-section">
        <p className="docs-section__eyebrow">{t("docsPage.thinkingMode.eyebrow")}</p>
        <DocsH2>{t("docsPage.thinkingMode.title")}</DocsH2>
        <P htmlKey="docsPage.thinkingMode.desc" />
        <MethodPill method="POST" path="/v1/chat/completions" />
        <P htmlKey="docsPage.thinkingMode.intro" />
        <Note tone="tip" title={t("docsPage.thinkingMode.param.title")}>
          <Html as="p" html={t("docsPage.thinkingMode.param.body")} />
        </Note>
        <CodeTabs codeMap={SCENARIO_CODE.thinking} fileMap={SCENARIO_FILE.thinking} />
      </section>

      <section id="vision" className="docs-section">
        <p className="docs-section__eyebrow">Vision</p>
        <DocsH2>{t("docsPage.vision.title")}</DocsH2>
        <P htmlKey="docsPage.vision.desc" />
        <DocsH3 id="vision-image">{t("docsPage.vision.image.title")}</DocsH3>
        <P htmlKey="docsPage.vision.image.body" />
        <MethodPill method="POST" path="/v1/chat/completions" />
        <h4 className="docs-h4">{t("docsPage.chatRequest.title")}</h4>
        <ParamTable
          rows={[
            { name: "model", type: "string", required: true, desc: t("docsPage.vision.image.param.model") },
            { name: "messages", type: "array", required: true, desc: t("docsPage.vision.image.param.messages") },
            { name: "max_tokens", type: "integer", desc: t("docsPage.vision.image.param.maxTokens") },
          ]}
        />
        <h4 className="docs-h4">{t("docsPage.toolUse.example.title")}</h4>
        <CodeTabs codeMap={SCENARIO_CODE.vision} fileMap={SCENARIO_FILE.vision} />
        <DocsH3 id="vision-ocr">{t("docsPage.vision.ocr.title")}</DocsH3>
        <MethodPill method="POST" path="/v1/ocr" />
        <P htmlKey="docsPage.vision.ocr.body" />
        <h4 className="docs-h4">{t("docsPage.chatRequest.title")}</h4>
        <ParamTable
          rows={[
            { name: "model", type: "string", required: true, desc: t("docsPage.vision.ocr.param.model") },
            { name: "image", type: "string", required: true, desc: t("docsPage.vision.ocr.param.image") },
          ]}
        />
        <h4 className="docs-h4">{t("docsPage.toolUse.example.title")}</h4>
        <CodeTabs codeMap={SCENARIO_CODE.ocr} fileMap={SCENARIO_FILE.ocr} />
        <ResponseBlock label="Response" json={RESPONSE_OCR} />
      </section>

      <section id="tool-use" className="docs-section">
        <p className="docs-section__eyebrow">{t("docsPage.toolUse.eyebrow")}</p>
        <DocsH2>{t("docsPage.toolUse.title")}</DocsH2>
        <P htmlKey="docsPage.toolUse.desc" />
        <ol className="docs-steps docs-steps--compact">
          <li><p className="docs-steps__body">{t("docsPage.toolUse.flow.body")}</p></li>
        </ol>
        <h4 className="docs-h4">{t("docsPage.chatRequest.title")}</h4>
        <ParamTable
          rows={[
            { name: "model", type: "string", required: true, desc: t("docsPage.toolUse.param.model") },
            { name: "messages", type: "array", required: true, desc: t("docsPage.toolUse.param.messages") },
            { name: "tools", type: "array", required: true, desc: t("docsPage.toolUse.param.tools") },
            { name: "tool_choice", type: "string | object", desc: t("docsPage.toolUse.param.toolChoice"), def: "auto" },
          ]}
        />
        <h4 className="docs-h4">{t("docsPage.toolUse.example.title")}</h4>
        <CodeTabs codeMap={SCENARIO_CODE.tool} fileMap={SCENARIO_FILE.tool} />
      </section>
    </>
  );
}

/**
 * API reference —— 真正独立的端点：chat/completions、embeddings、rerank、
 * completions、responses、messages。
 */
export function DocsApiReference() {
  const { t } = useT();
  const { activeTab } = useDocsLanguage();

  return (
    <>
      <section id="chat-api" className="docs-section">
        <p className="docs-section__eyebrow">Chat Completions</p>
        <DocsH2>{t("docsPage.chatApi.title")}</DocsH2>
        <P htmlKey="docsPage.chatApi.desc" />
        <MethodPill method="POST" path="/v1/chat/completions" />

        <DocsH3 id="chat-request">{t("docsPage.chatRequest.title")}</DocsH3>
        <ParamTable
          rows={[
            { name: "model", type: "string", required: true, desc: t("docsPage.chatRequest.model") },
            { name: "messages", type: "array", required: true, desc: t("docsPage.chatRequest.messages") },
            { name: "stream", type: "boolean", desc: t("docsPage.chatRequest.stream"), def: "false" },
            { name: "temperature", type: "number", desc: t("docsPage.chatRequest.temperature"), def: "1.0" },
            { name: "top_p", type: "number", desc: t("docsPage.chatRequest.topP"), def: "1.0" },
            { name: "max_tokens", type: "integer", desc: t("docsPage.chatRequest.maxTokens") },
            { name: "n", type: "integer", desc: t("docsPage.chatRequest.n"), def: "1" },
            { name: "stop", type: "string | string[]", desc: t("docsPage.chatRequest.stop") },
            { name: "presence_penalty", type: "number", desc: t("docsPage.chatRequest.presencePenalty"), def: "0" },
            { name: "frequency_penalty", type: "number", desc: t("docsPage.chatRequest.frequencyPenalty"), def: "0" },
            { name: "seed", type: "integer", desc: t("docsPage.chatRequest.seed") },
            { name: "tools", type: "array", desc: t("docsPage.chatRequest.tools") },
            { name: "response_format", type: "object", desc: t("docsPage.chatRequest.responseFormat") },
          ]}
        />

        <h3 className="docs-h3">{t("docsPage.toolUse.example.title")}</h3>
        <CodeTabs codeMap={SCENARIO_CODE.chat} fileMap={SCENARIO_FILE.chat} />
        <ResponseBlock label="Response" json={RESPONSE_CHAT} />
        <ResponseFields
          rows={[
            { name: "id", type: "string", desc: t("docsPage.chatResponse.id") },
            { name: "object", type: "string", desc: t("docsPage.chatResponse.object") },
            { name: "created", type: "integer", desc: t("docsPage.chatResponse.created") },
            { name: "model", type: "string", desc: t("docsPage.chatResponse.model") },
            { name: "choices", type: "array", desc: t("docsPage.chatResponse.choices") },
            { name: "choices[].index", type: "integer", desc: t("docsPage.chatResponse.index") },
            { name: "choices[].message", type: "object", desc: t("docsPage.chatResponse.message") },
            { name: "choices[].finish_reason", type: "string", desc: t("docsPage.chatResponse.finishReason") },
            { name: "usage", type: "object", desc: t("docsPage.chatResponse.usage") },
            { name: "usage.prompt_tokens", type: "integer", desc: t("docsPage.chatResponse.promptTokens") },
            { name: "usage.completion_tokens", type: "integer", desc: t("docsPage.chatResponse.completionTokens") },
            { name: "usage.total_tokens", type: "integer", desc: t("docsPage.chatResponse.totalTokens") },
          ]}
        />

        <DocsH3 id="chat-streaming">{t("docsPage.chatApi.streaming.title")}</DocsH3>
        <P htmlKey="docsPage.chatApi.streaming.body" />
        <details className="docs-tabs">
          <summary className="docs-tabs__bar docs-tabs__summary">
            <span className="docs-tabs__summary-text">{t("docsPage.toolUse.example.title")}</span>
          </summary>
          <CodeBlock variant="dark" code={SCENARIO_CODE.stream[activeTab]} lang={tabLang[activeTab]} label={SCENARIO_FILE.stream[activeTab]} />
        </details>
        <ResponseBlock label="Stream response" json={RESPONSE_STREAM} />

        <DocsH3 id="chat-json">{t("docsPage.chatApi.json.title")}</DocsH3>
        <P htmlKey="docsPage.chatApi.json.body" />
        <details className="docs-tabs">
          <summary className="docs-tabs__bar docs-tabs__summary">
            <span className="docs-tabs__summary-text">{t("docsPage.toolUse.example.title")}</span>
          </summary>
          <CodeBlock variant="dark" code={SCENARIO_CODE.json[activeTab]} lang={tabLang[activeTab]} label={SCENARIO_FILE.json[activeTab]} />
        </details>
      </section>

      <section id="embeddings-rerank" className="docs-section">
        <p className="docs-section__eyebrow">Embeddings & Rerank</p>
        <DocsH2>{t("docsPage.embeddingsRerank.title")}</DocsH2>
        <P htmlKey="docsPage.embeddingsRerank.desc" />
        <DocsH3 id="embeddings-vectors">{t("docsPage.embeddingsRerank.embedding.title")}</DocsH3>
        <MethodPill method="POST" path="/v1/embeddings" />
        <P htmlKey="docsPage.embeddingsRerank.embedding.body" />
        <h4 className="docs-h4">{t("docsPage.chatRequest.title")}</h4>
        <ParamTable
          rows={[
            { name: "model", type: "string", required: true, desc: t("docsPage.embeddingsRerank.embedding.param.model") },
            { name: "input", type: "string | string[]", required: true, desc: t("docsPage.embeddingsRerank.embedding.param.input") },
          ]}
        />
        <h4 className="docs-h4">{t("docsPage.toolUse.example.title")}</h4>
        <CodeTabs codeMap={SCENARIO_CODE.embedding} fileMap={SCENARIO_FILE.embedding} />
        <ResponseBlock label="Response" json={RESPONSE_EMBEDDING} />
        <ResponseFields
          rows={[
            { name: "object", type: "string", desc: t("docsPage.embeddingsResponse.object") },
            { name: "data", type: "array", desc: t("docsPage.embeddingsResponse.data") },
            { name: "data[].embedding", type: "number[]", desc: t("docsPage.embeddingsResponse.embedding") },
            { name: "data[].index", type: "integer", desc: t("docsPage.embeddingsResponse.index") },
            { name: "usage", type: "object", desc: t("docsPage.embeddingsResponse.usage") },
          ]}
        />
        <DocsH3 id="rerank">{t("docsPage.embeddingsRerank.rerank.title")}</DocsH3>
        <MethodPill method="POST" path="/v1/rerank" />
        <P htmlKey="docsPage.embeddingsRerank.rerank.body" />
        <h4 className="docs-h4">{t("docsPage.chatRequest.title")}</h4>
        <ParamTable
          rows={[
            { name: "model", type: "string", required: true, desc: t("docsPage.embeddingsRerank.rerank.param.model") },
            { name: "query", type: "string", required: true, desc: t("docsPage.embeddingsRerank.rerank.param.query") },
            { name: "documents", type: "string[]", required: true, desc: t("docsPage.embeddingsRerank.rerank.param.documents") },
            { name: "top_n", type: "integer", desc: t("docsPage.embeddingsRerank.rerank.param.topN") },
          ]}
        />
        <h4 className="docs-h4">{t("docsPage.toolUse.example.title")}</h4>
        <CodeTabs codeMap={SCENARIO_CODE.reranker} fileMap={SCENARIO_FILE.reranker} />
        <ResponseBlock label="Response" json={RESPONSE_RERANK} />
        <ResponseFields
          rows={[
            { name: "results", type: "array", desc: t("docsPage.rerankResponse.results") },
            { name: "results[].index", type: "integer", desc: t("docsPage.rerankResponse.index") },
            { name: "results[].relevance_score", type: "number", desc: t("docsPage.rerankResponse.relevanceScore") },
            { name: "usage", type: "object", desc: t("docsPage.embeddingsResponse.usage") },
          ]}
        />
      </section>

      <section id="completions" className="docs-section">
        <p className="docs-section__eyebrow">Completions</p>
        <DocsH2>{t("docsPage.completions.title")}</DocsH2>
        <MethodPill method="POST" path="/v1/completions" />
        <P htmlKey="docsPage.completions.body" />
        <StreamingHint />
        <h4 className="docs-h4">{t("docsPage.chatRequest.title")}</h4>
        <ParamTable
          rows={[
            { name: "model", type: "string", required: true, desc: t("docsPage.completions.param.model") },
            { name: "prompt", type: "string", required: true, desc: t("docsPage.completions.param.prompt") },
            { name: "max_tokens", type: "integer", desc: t("docsPage.completions.param.maxTokens") },
            { name: "temperature", type: "number", desc: t("docsPage.completions.param.temperature"), def: "1.0" },
            { name: "stop", type: "string | string[]", desc: t("docsPage.completions.param.stop") },
            { name: "stream", type: "boolean", desc: t("docsPage.completions.param.stream"), def: "false" },
          ]}
        />
        <h4 className="docs-h4">{t("docsPage.toolUse.example.title")}</h4>
        <CodeTabs codeMap={SCENARIO_CODE.fim} fileMap={SCENARIO_FILE.fim} />
        <ResponseBlock label="Response" json={RESPONSE_COMPLETIONS} />
      </section>

      <section id="responses" className="docs-section">
        <p className="docs-section__eyebrow">Responses API</p>
        <DocsH2>{t("docsPage.responses.title")}</DocsH2>
        <MethodPill method="POST" path="/v1/responses" />
        <P htmlKey="docsPage.responses.body" />
        <StreamingHint />
        <Note tone="note"><Html as="p" html={t("docsPage.responses.metering.body")} /></Note>
        <h3 className="docs-h3">{t("docsPage.chatRequest.title")}</h3>
        <ParamTable
          rows={[
            { name: "model", type: "string", required: true, desc: t("docsPage.responses.param.model") },
            { name: "input", type: "string | array", required: true, desc: t("docsPage.responses.param.input") },
            { name: "instructions", type: "string", desc: t("docsPage.responses.param.instructions") },
            { name: "tools", type: "array", desc: t("docsPage.responses.param.tools") },
            { name: "temperature", type: "number", desc: t("docsPage.responses.param.temperature"), def: "1.0" },
            { name: "stream", type: "boolean", desc: t("docsPage.responses.param.stream"), def: "false" },
          ]}
        />
        <h3 className="docs-h3">{t("docsPage.toolUse.example.title")}</h3>
        <CodeTabs codeMap={SCENARIO_CODE.codex} fileMap={SCENARIO_FILE.codex} />
        <ResponseBlock label="Response" json={RESPONSE_RESPONSES} />
      </section>

      <section id="messages" className="docs-section">
        <p className="docs-section__eyebrow">Anthropic Messages</p>
        <DocsH2>{t("docsPage.messages.title")}</DocsH2>
        <MethodPill method="POST" path="/v1/messages" />
        <P htmlKey="docsPage.messages.body" />
        <StreamingHint />
        <h3 className="docs-h3">{t("docsPage.chatRequest.title")}</h3>
        <ParamTable
          rows={[
            { name: "model", type: "string", required: true, desc: t("docsPage.messages.param.model") },
            { name: "max_tokens", type: "integer", required: true, desc: t("docsPage.messages.param.maxTokens") },
            { name: "messages", type: "array", required: true, desc: t("docsPage.messages.param.messages") },
            { name: "system", type: "string | array", desc: t("docsPage.messages.param.system") },
            { name: "temperature", type: "number", desc: t("docsPage.messages.param.temperature"), def: "1.0" },
            { name: "stream", type: "boolean", desc: t("docsPage.messages.param.stream"), def: "false" },
          ]}
        />
        <h3 className="docs-h3">{t("docsPage.toolUse.example.title")}</h3>
        <CodeTabs codeMap={SCENARIO_CODE.cc} fileMap={SCENARIO_FILE.cc} />
        <ResponseBlock label="Response" json={RESPONSE_MESSAGES} />
      </section>

      <section id="count-tokens" className="docs-section">
        <p className="docs-section__eyebrow">{t("docsPage.countTokens.eyebrow")}</p>
        <DocsH2>{t("docsPage.countTokens.title")}</DocsH2>
        <MethodPill method="POST" path="/v1/messages/count_tokens" />
        <P htmlKey="docsPage.countTokens.body" />
        <h4 className="docs-h4">{t("docsPage.chatRequest.title")}</h4>
        <ParamTable
          rows={[
            { name: "model", type: "string", required: true, desc: t("docsPage.countTokens.param.model") },
            { name: "messages", type: "array", required: true, desc: t("docsPage.countTokens.param.messages") },
          ]}
        />
        <h4 className="docs-h4">{t("docsPage.toolUse.example.title")}</h4>
        <CodeBlock
          variant="dark"
          lang="bash"
          label="cURL"
          code={`curl -X POST ${BASE_URL}/v1/messages/count_tokens \\
  -H "x-api-key: $PLATFORM_API_KEY" \\
  -H "anthropic-version: 2023-06-01" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"platform-flash","messages":[{"role":"user","content":"Hello"}]}'`}
        />
        <ResponseBlock label="Response" json={`{\n  "input_tokens": 28\n}`} />
        <ResponseFields
          rows={[
            { name: "input_tokens", type: "integer", desc: t("docsPage.countTokens.field.inputTokens") },
          ]}
        />
      </section>
    </>
  );
}
