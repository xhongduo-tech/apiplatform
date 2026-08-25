/**
 * model-readme-snippets.ts
 *
 * 代码片段工厂和本地化字符串资源。
 * 从 model-readme-data.ts 分离出来以打破 model-readme-data ↔ model-readme-zh/en 之间的循环依赖。
 */

export interface CodeSnippet {
  title: string;
  language: "python" | "bash" | "javascript";
  code: string;
}

const BASE_URL = "{{API_BASE_URL}}";

interface CodeStrings {
  apiKeyPlaceholder: string;
  helloSys: string;
  helloUser: string;
  autumnPoem: string;
  toolDefDesc: string;
  toolCallCity: string;
  toolCallMsg: string;
  toolCallPrintFn: string;
  toolCallPrintArgs: string;
  jsonSysPrompt: string;
  jsonUserMsg: string;
  curlHello: string;
  embeddingSingle: string;
  embeddingBatch1: string;
  embeddingBatch2: string;
  rerankQuery: string;
  rerankDoc1: string;
  rerankDoc2: string;
  visionQuestion: string;
  rerankDoc3: string;
  embeddingPyComment: string;
  ocrApiKeyComment: string;
  ocrLinePrint: string;
  snippets: {
    pythonSdk: string;
    streaming: string;
    toolCall: string;
    jsonOutput: string;
    curl: string;
    visionImage: string;
    embedding: string;
    rerank: string;
    ocr: string;
  };
}

const CODE_STRINGS_ZH: CodeStrings = {
  apiKeyPlaceholder: "{{API_KEY}}",
  helloSys: "You are a helpful assistant.",
  helloUser: "你好，请介绍一下你自己。",
  autumnPoem: "写一首关于秋天的短诗。",
  toolDefDesc: "按城市获取当前天气",
  toolCallCity: "北京今天热吗?",
  toolCallMsg: "调用工具",
  toolCallPrintFn: "调用工具: {name}",
  toolCallPrintArgs: "参数: {args}",
  jsonSysPrompt: "请始终以 JSON 格式输出结果。",
  jsonUserMsg: "提取以下文本中的用户信息：张三，30岁，北京",
  curlHello: "你好",
  embeddingSingle: "深度学习是机器学习的一个分支",
  embeddingBatch1: "深度学习是机器学习的一个分支",
  embeddingBatch2: "大语言模型改变了NLP领域",
  rerankQuery: "深度学习的应用场景有哪些？",
  rerankDoc1: "深度学习广泛应用于图像识别、语音识别和自然语言处理等领域",
  rerankDoc2: "今天天气晴朗，适合户外运动",
  rerankDoc3: "卷积神经网络在计算机视觉任务上取得了突破性进展",
  visionQuestion: "这张图表表达了什么趋势?",
  embeddingPyComment: "# 替换为你的 API Key",
  ocrApiKeyComment: "# 替换为你的 API Key",
  ocrLinePrint: "位置",
  snippets: {
    pythonSdk: "Python SDK",
    streaming: "流式输出",
    toolCall: "工具调用",
    jsonOutput: "JSON 输出",
    curl: "cURL",
    visionImage: "图像理解",
    embedding: "文本向量化",
    rerank: "结果重排序",
    ocr: "图像文字识别",
  },
};

const CODE_STRINGS_EN: CodeStrings = {
  apiKeyPlaceholder: "{{API_KEY}}",
  helloSys: "You are a helpful assistant.",
  helloUser: "Hello, please introduce yourself.",
  autumnPoem: "Write a short poem about autumn.",
  toolDefDesc: "Get current weather by city",
  toolCallCity: "Is it hot in Beijing today?",
  toolCallMsg: "Tool call",
  toolCallPrintFn: "Called tool: {name}",
  toolCallPrintArgs: "Arguments: {args}",
  jsonSysPrompt: "Always output results in JSON format.",
  jsonUserMsg: "Extract user info from the following text: John, 30 years old, New York",
  curlHello: "Hello",
  embeddingSingle: "Deep learning is a branch of machine learning",
  embeddingBatch1: "Deep learning is a branch of machine learning",
  embeddingBatch2: "Large language models have transformed the field of NLP",
  rerankQuery: "What are the application scenarios of deep learning?",
  rerankDoc1: "Deep learning is widely used in image recognition, speech recognition, and natural language processing",
  rerankDoc2: "The weather is sunny today, suitable for outdoor sports",
  rerankDoc3: "Convolutional neural networks have achieved breakthrough progress in computer vision tasks",
  visionQuestion: "What trend does this chart show?",
  embeddingPyComment: "# Replace with your API Key",
  ocrApiKeyComment: "# Replace with your API Key",
  ocrLinePrint: "BBox",
  snippets: {
    pythonSdk: "Python SDK",
    streaming: "Streaming",
    toolCall: "Tool Calling",
    jsonOutput: "JSON Output",
    curl: "cURL",
    visionImage: "Vision",
    embedding: "Text Embeddings",
    rerank: "Reranking",
    ocr: "OCR",
  },
};

function chatSnippet(model: string, cs: CodeStrings): CodeSnippet {
  return {
    title: cs.snippets.pythonSdk,
    language: "python",
    code: `from openai import OpenAI

client = OpenAI(
    base_url="${BASE_URL}",
    api_key="${cs.apiKeyPlaceholder}",  ${cs.embeddingPyComment.replace("# ", "# ")}
)

resp = client.chat.completions.create(
    model="${model}",
    messages=[
        {"role": "system", "content": "${cs.helloSys}"},
        {"role": "user",   "content": "${cs.helloUser}"},
    ],
)
print(resp.choices[0].message.content)`,
  };
}

function streamSnippet(model: string, cs: CodeStrings): CodeSnippet {
  return {
    title: cs.snippets.streaming,
    language: "python",
    code: `from openai import OpenAI

client = OpenAI(
    base_url="${BASE_URL}",
    api_key="${cs.apiKeyPlaceholder}",
)

stream = client.chat.completions.create(
    model="${model}",
    messages=[{"role": "user", "content": "${cs.autumnPoem}"}],
    stream=True,
)
for chunk in stream:
    if chunk.choices[0].delta.content:
        print(chunk.choices[0].delta.content, end="", flush=True)`,
  };
}

function toolCallSnippet(model: string, cs: CodeStrings): CodeSnippet {
  return {
    title: cs.snippets.toolCall,
    language: "python",
    code: `import json
from openai import OpenAI

client = OpenAI(
    base_url="${BASE_URL}",
    api_key="${cs.apiKeyPlaceholder}",
)

tools = [{
    "type": "function",
    "function": {
        "name": "get_weather",
        "description": "${cs.toolDefDesc}",
        "parameters": {
            "type": "object",
            "properties": {"city": {"type": "string"}},
            "required": ["city"],
        },
    },
}]

resp = client.chat.completions.create(
    model="${model}",
    messages=[{"role": "user", "content": "${cs.toolCallCity}"}],
    tools=tools,
)

msg = resp.choices[0].message
if msg.tool_calls:
    for tc in msg.tool_calls:
        print(f"${cs.toolCallPrintFn.replace("{name}", "{tc.function.name}")}")
        print(f"${cs.toolCallPrintArgs.replace("{args}", "{tc.function.arguments}")}")
else:
    print(msg.content)`,
  };
}

function jsonModeSnippet(model: string, cs: CodeStrings): CodeSnippet {
  return {
    title: cs.snippets.jsonOutput,
    language: "python",
    code: `import json
from openai import OpenAI

client = OpenAI(
    base_url="${BASE_URL}",
    api_key="${cs.apiKeyPlaceholder}",
)

resp = client.chat.completions.create(
    model="${model}",
    messages=[
        {"role": "system", "content": "${cs.jsonSysPrompt}"},
        {"role": "user", "content": "${cs.jsonUserMsg}"},
    ],
    response_format={"type": "json_object"},
)

data = json.loads(resp.choices[0].message.content)
print(json.dumps(data, ensure_ascii=False, indent=2))`,
  };
}

function curlSnippet(model: string, cs: CodeStrings): CodeSnippet {
  return {
    title: cs.snippets.curl,
    language: "bash",
    code: `curl ${BASE_URL}/chat/completions \\
  -H "Authorization: Bearer $PLATFORM_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${model}",
    "messages": [{"role":"user","content":"${cs.curlHello}"}]
  }'`,
  };
}

function embeddingCurlSnippet(model: string, cs: CodeStrings): CodeSnippet {
  return {
    title: cs.snippets.curl,
    language: "bash",
    code: `# Single
curl -X POST ${BASE_URL}/embeddings \\
  -H "Authorization: Bearer $PLATFORM_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"${model}","input":"${cs.embeddingSingle}","encoding_format":"float"}'

# Batch
curl -X POST ${BASE_URL}/embeddings \\
  -H "Authorization: Bearer $PLATFORM_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${model}",
    "input": ["${cs.embeddingBatch1}","${cs.embeddingBatch2}"],
    "encoding_format": "float"
  }'`,
  };
}

function rerankCurlSnippet(model: string, cs: CodeStrings): CodeSnippet {
  return {
    title: cs.snippets.curl,
    language: "bash",
    code: `curl -X POST ${BASE_URL}/rerank \\
  -H "Authorization: Bearer $PLATFORM_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${model}",
    "query": "${cs.rerankQuery}",
    "documents": [
      "${cs.rerankDoc1}",
      "${cs.rerankDoc2}"
    ]
  }'`,
  };
}

function visionCallSnippet(model: string, cs: CodeStrings): CodeSnippet {
  return {
    title: cs.snippets.visionImage,
    language: "python",
    code: `import base64
from openai import OpenAI

client = OpenAI(
    base_url="${BASE_URL}",
    api_key="${cs.apiKeyPlaceholder}",
)

with open("chart.png", "rb") as f:
    img_b64 = base64.b64encode(f.read()).decode()

resp = client.chat.completions.create(
    model="${model}",
    messages=[{
        "role": "user",
        "content": [
            {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{img_b64}"}},
            {"type": "text", "text": "${cs.visionQuestion}"},
        ],
    }],
)
print(resp.choices[0].message.content)`,
  };
}

function embeddingSnippet(model: string, cs: CodeStrings): CodeSnippet {
  return {
    title: cs.snippets.embedding,
    language: "python",
    code: `from openai import OpenAI

client = OpenAI(
    base_url="${BASE_URL}",
    api_key="${cs.apiKeyPlaceholder}",  ${cs.embeddingPyComment}
)

# Single text
response = client.embeddings.create(
    model="${model}",
    input="${cs.embeddingSingle}",
    encoding_format="float",
)
vector = response.data[0].embedding
print(f"Dimensions: {len(vector)}, first 5: {vector[:5]}")

# Batch texts
texts = [
    "${cs.embeddingBatch1}",
    "${cs.embeddingBatch2}",
    "The Transformer architecture was proposed in 2017",
]
response = client.embeddings.create(
    model="${model}", input=texts, encoding_format="float",
)
vectors = [d.embedding for d in response.data]
print(f"Batch vector count: {len(vectors)}")`,
  };
}

function rerankSnippet(model: string, cs: CodeStrings): CodeSnippet {
  return {
    title: cs.snippets.rerank,
    language: "python",
    code: `import httpx

API_KEY = "${cs.apiKeyPlaceholder}"  ${cs.embeddingPyComment}

query = "${cs.rerankQuery}"
documents = [
    "${cs.rerankDoc1}",
    "${cs.rerankDoc2}",
    "${cs.rerankDoc3}",
]

resp = httpx.post(
    "${BASE_URL}/rerank",
    headers={"Authorization": f"Bearer {API_KEY}", "Content-Type": "application/json"},
    json={"model": "${model}", "query": query, "documents": documents},
    timeout=60.0,
)
resp.raise_for_status()
data = resp.json()
for item in data.get("results", data.get("data", [])):
    idx = item.get("index", item.get("document", {}).get("index"))
    score = item.get("relevance_score", item.get("score"))
    print(f"[{score}] {documents[idx] if idx is not None else item}")`,
  };
}

function ocrSnippet(model: string, cs: CodeStrings): CodeSnippet {
  return {
    title: cs.snippets.ocr,
    language: "python",
    code: `import base64
import requests

API_KEY = "${cs.apiKeyPlaceholder}"  ${cs.ocrApiKeyComment}

with open("invoice.png", "rb") as f:
    img_b64 = base64.b64encode(f.read()).decode()

r = requests.post(
    "${BASE_URL}/ocr",
    headers={"Authorization": f"Bearer {API_KEY}"},
    json={
        "model": "${model}",
        "image": f"data:image/png;base64,{img_b64}",
    },
)

result = r.json()
for line in result.get("lines", []):
    print(f"{line['text']}  (${cs.ocrLinePrint}: {line['bbox']})")`,
  };
}

function pythonSnippet(code: string, title = "Python"): CodeSnippet {
  return { title, language: "python", code };
}

export type SnippetFactories = {
  chat: (model: string) => CodeSnippet;
  stream: (model: string) => CodeSnippet;
  toolCall: (model: string) => CodeSnippet;
  jsonMode: (model: string) => CodeSnippet;
  curl: (model: string) => CodeSnippet;
  embeddingCurl: (model: string) => CodeSnippet;
  rerankCurl: (model: string) => CodeSnippet;
  visionCall: (model: string) => CodeSnippet;
  embedding: (model: string) => CodeSnippet;
  rerank: (model: string) => CodeSnippet;
  ocr: (model: string) => CodeSnippet;
  python: (code: string, title?: string) => CodeSnippet;
};

export function getFactoriesForLang(lang: string): SnippetFactories {
  const cs: CodeStrings = lang === "en" ? CODE_STRINGS_EN : CODE_STRINGS_ZH;
  return {
    chat: (m) => chatSnippet(m, cs),
    stream: (m) => streamSnippet(m, cs),
    toolCall: (m) => toolCallSnippet(m, cs),
    jsonMode: (m) => jsonModeSnippet(m, cs),
    curl: (m) => curlSnippet(m, cs),
    embeddingCurl: (m) => embeddingCurlSnippet(m, cs),
    rerankCurl: (m) => rerankCurlSnippet(m, cs),
    visionCall: (m) => visionCallSnippet(m, cs),
    embedding: (m) => embeddingSnippet(m, cs),
    rerank: (m) => rerankSnippet(m, cs),
    ocr: (m) => ocrSnippet(m, cs),
    python: (code, title?) => pythonSnippet(code, title),
  };
}
