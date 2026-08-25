import type { ComponentType } from "react";
import {
  ImageIcon, Layers, Code2, Bot,
  Wrench, MessageSquare,
  Zap, ArrowUpDown,
  Terminal, Cpu,
  Brain, Repeat, Braces, Boxes, ScanLine, List,
} from "lucide-react";
import { publicApiOrigin } from "../../api/public-api-origin";
import type { TranslationKey } from "../../i18n";

export const BASE_URL = publicApiOrigin();

// ═════════════════════════════════════════════════════════════════════════════
// Code examples (runnable snippets; user-facing strings stay in Chinese)
// ═════════════════════════════════════════════════════════════════════════════
export const PYTHON = `from openai import OpenAI

client = OpenAI(
    base_url="${BASE_URL}/v1",
    api_key="YOUR_API_KEY",
)

response = client.chat.completions.create(
    model="platform-flash",
    messages=[
        {"role": "system", "content": "你是一个有帮助的助手。"},
        {"role": "user",   "content": "请解释什么是大语言模型？"}
    ],
    temperature=0.7,
    max_tokens=1024,
)

print(response.choices[0].message.content)`;

export const CURL = `curl -X POST ${BASE_URL}/v1/chat/completions \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "platform-flash",
    "messages": [
      {"role": "system", "content": "你是一个有帮助的助手。"},
      {"role": "user",   "content": "请解释什么是大语言模型？"}
    ],
    "temperature": 0.7,
    "max_tokens": 1024
  }'`;

export const NODEJS = `import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: '${BASE_URL}/v1',
  apiKey:  'YOUR_API_KEY',
});

const response = await client.chat.completions.create({
  model: 'platform-flash',
  messages: [
    { role: 'system', content: '你是一个有帮助的助手。' },
    { role: 'user',   content: '请解释什么是大语言模型？' },
  ],
  temperature: 0.7,
  max_tokens: 1024,
});

console.log(response.choices[0].message.content);`;

const STREAM_PYTHON = `from openai import OpenAI

client = OpenAI(
    base_url="${BASE_URL}/v1",
    api_key="YOUR_API_KEY",
)

stream = client.chat.completions.create(
    model="platform-flash",
    messages=[{"role": "user", "content": "用 100 字介绍深度学习"}],
    stream=True,
)

for chunk in stream:
    delta = chunk.choices[0].delta
    if delta.content:
        print(delta.content, end="", flush=True)`;

const STREAM_CURL = `curl -X POST ${BASE_URL}/v1/chat/completions \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -H "Accept: text/event-stream" \\
  -d '{
    "model": "platform-flash",
    "messages": [{"role": "user", "content": "用 100 字介绍深度学习"}],
    "stream": true
  }'

# Server-Sent Events format:
# data: {"choices":[{"delta":{"content":"..."},...}]}
# data: [DONE]`;

const STREAM_NODEJS = `import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: '${BASE_URL}/v1',
  apiKey:  'YOUR_API_KEY',
});

const stream = await client.chat.completions.create({
  model: 'platform-flash',
  messages: [{ role: 'user', content: '用 100 字介绍深度学习' }],
  stream: true,
});

for await (const chunk of stream) {
  const delta = chunk.choices[0]?.delta?.content;
  if (delta) process.stdout.write(delta);
}`;

const TOOL_PYTHON = `from openai import OpenAI

client = OpenAI(
    base_url="${BASE_URL}/v1",
    api_key="YOUR_API_KEY",
)

tools = [{
    "type": "function",
    "function": {
        "name": "get_weather",
        "description": "获取指定城市的实时天气信息",
        "parameters": {
            "type": "object",
            "properties": {
                "city": {"type": "string", "description": "城市名称，如：北京"},
                "unit": {"type": "string", "enum": ["celsius", "fahrenheit"]}
            },
            "required": ["city"]
        }
    }
}]

response = client.chat.completions.create(
    model="platform-flash",
    messages=[{"role": "user", "content": "北京今天天气如何？"}],
    tools=tools,
    tool_choice="auto",
)

tool_call = response.choices[0].message.tool_calls[0]
print(f"函数名: {tool_call.function.name}")
print(f"参数:   {tool_call.function.arguments}")`;

const TOOL_CURL = `curl -X POST ${BASE_URL}/v1/chat/completions \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "platform-flash",
    "messages": [{"role": "user", "content": "北京今天天气如何？"}],
    "tools": [{
      "type": "function",
      "function": {
        "name": "get_weather",
        "description": "获取指定城市的实时天气信息",
        "parameters": {
          "type": "object",
          "properties": {
            "city": {"type": "string"},
            "unit": {"type": "string", "enum": ["celsius", "fahrenheit"]}
          },
          "required": ["city"]
        }
      }
    }],
    "tool_choice": "auto"
  }'`;

const TOOL_NODEJS = `import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: '${BASE_URL}/v1',
  apiKey:  'YOUR_API_KEY',
});

const response = await client.chat.completions.create({
  model: 'platform-flash',
  messages: [{ role: 'user', content: '北京今天天气如何？' }],
  tools: [{
    type: 'function',
    function: {
      name: 'get_weather',
      description: '获取指定城市的实时天气信息',
      parameters: {
        type: 'object',
        properties: {
          city: { type: 'string' },
          unit: { type: 'string', enum: ['celsius', 'fahrenheit'] },
        },
        required: ['city'],
      },
    },
  }],
  tool_choice: 'auto',
});

const toolCall = response.choices[0].message.tool_calls[0];
console.log('函数名:', toolCall.function.name);
console.log('参数:  ', toolCall.function.arguments);`;

const IMAGE_PYTHON = `import base64
from openai import OpenAI

client = OpenAI(
    base_url="${BASE_URL}/v1",
    api_key="YOUR_API_KEY",
)

with open("image.png", "rb") as f:
    img_b64 = base64.b64encode(f.read()).decode()

response = client.chat.completions.create(
    model="demo-vision-model",
    messages=[{
        "role": "user",
        "content": [
            {"type": "text", "text": "请描述这张图片的内容"},
            {"type": "image_url", "image_url": {
                "url": f"data:image/png;base64,{img_b64}"
            }}
        ]
    }],
    max_tokens=1024,
)

print(response.choices[0].message.content)`;

const IMAGE_CURL = `IMG_B64=$(base64 -i image.png | tr -d '\\n')

curl -X POST ${BASE_URL}/v1/chat/completions \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d "{
    \\"model\\": \\"demo-vision-model\\",
    \\"messages\\": [{
      \\"role\\": \\"user\\",
      \\"content\\": [
        {\\"type\\": \\"text\\", \\"text\\": \\"请描述这张图片的内容\\"},
        {\\"type\\": \\"image_url\\", \\"image_url\\": {
          \\"url\\": \\"data:image/png;base64,\${IMG_B64}\\"
        }}
      ]
    }],
    \\"max_tokens\\": 1024
  }"`;

const IMAGE_NODEJS = `import fs from 'fs';
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: '${BASE_URL}/v1',
  apiKey:  'YOUR_API_KEY',
});

const imgB64 = fs.readFileSync('image.png').toString('base64');

const response = await client.chat.completions.create({
  model: 'demo-vision-model',
  messages: [{
    role: 'user',
    content: [
      { type: 'text', text: '请描述这张图片的内容' },
      { type: 'image_url', image_url: {
        url: \`data:image/png;base64,\${imgB64}\`,
      }},
    ],
  }],
  max_tokens: 1024,
});

console.log(response.choices[0].message.content);`;

const EMBEDDING_PYTHON = `from openai import OpenAI

client = OpenAI(base_url="${BASE_URL}/v1", api_key="YOUR_API_KEY")

# 单条
response = client.embeddings.create(
    model="demo-embedding-model",
    input="深度学习是机器学习的一个分支",
    encoding_format="float",
)
vector = response.data[0].embedding
print(f"维度: {len(vector)}, 前5维: {vector[:5]}")

# 批量
texts = [
    "深度学习是机器学习的一个分支",
    "大语言模型改变了NLP领域",
    "Transformer架构于2017年提出",
]
response = client.embeddings.create(
    model="demo-embedding-model", input=texts, encoding_format="float"
)
vectors = [d.embedding for d in response.data]
print(f"批量向量数: {len(vectors)}")`;

const EMBEDDING_CURL = `# 单条
curl -X POST ${BASE_URL}/v1/embeddings \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"demo-embedding-model","input":"深度学习是机器学习的一个分支","encoding_format":"float"}'

# 批量
curl -X POST ${BASE_URL}/v1/embeddings \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "demo-embedding-model",
    "input": ["深度学习是机器学习的一个分支","大语言模型改变了NLP领域"],
    "encoding_format": "float"
  }'`;

const EMBEDDING_NODEJS = `import OpenAI from 'openai';

const client = new OpenAI({ baseURL: '${BASE_URL}/v1', apiKey: 'YOUR_API_KEY' });

// Single input
const single = await client.embeddings.create({
  model: 'demo-embedding-model',
  input: '深度学习是机器学习的一个分支',
  encoding_format: 'float',
});
console.log('维度:', single.data[0].embedding.length);

// Batch input
const batch = await client.embeddings.create({
  model: 'demo-embedding-model',
  input: ['深度学习是机器学习的一个分支', '大语言模型改变了NLP领域'],
  encoding_format: 'float',
});
console.log('批量向量数:', batch.data.length);`;

const RERANKER_PYTHON = `import httpx

API_KEY = "YOUR_API_KEY"
query = "深度学习的应用场景有哪些？"
documents = [
    "深度学习广泛应用于图像识别、语音识别和自然语言处理等领域",
    "今天天气晴朗，适合户外运动",
    "卷积神经网络在计算机视觉任务上取得了突破性进展",
]

resp = httpx.post(
    "${BASE_URL}/v1/rerank",
    headers={"Authorization": f"Bearer {API_KEY}", "Content-Type": "application/json"},
    json={"model": "demo-reranker-model", "query": query, "documents": documents},
    timeout=60.0,
)
resp.raise_for_status()
data = resp.json()
for item in data.get("results", data.get("data", [])):
    idx = item.get("index", item.get("document", {}).get("index"))
    score = item.get("relevance_score", item.get("score"))
    print(f"[{score}] {documents[idx] if idx is not None else item}")`;

const RERANKER_CURL = `curl -X POST ${BASE_URL}/v1/rerank \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "demo-reranker-model",
    "query": "深度学习的应用场景有哪些？",
    "documents": [
      "深度学习广泛应用于图像识别、语音识别和自然语言处理等领域",
      "今天天气晴朗，适合户外运动"
    ]
  }'`;

const RERANKER_NODEJS = `const resp = await fetch('${BASE_URL}/v1/rerank', {
  method: 'POST',
  headers: {
    Authorization: 'Bearer YOUR_API_KEY',
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    model: 'demo-reranker-model',
    query: '深度学习的应用场景有哪些？',
    documents: [
      '深度学习广泛应用于图像识别、语音识别和自然语言处理等领域',
      '今天天气晴朗，适合户外运动',
    ],
  }),
});
const data = await resp.json();
console.log(data);`;

const OCR_PYTHON = `import base64
import httpx

with open("invoice.png", "rb") as f:
    img_b64 = base64.b64encode(f.read()).decode()

resp = httpx.post(
    "${BASE_URL}/v1/ocr",
    headers={"Authorization": "Bearer YOUR_API_KEY", "Content-Type": "application/json"},
    json={
        "model": "demo-ocr-model",
        "image": f"data:image/png;base64,{img_b64}",
    },
    timeout=120.0,
)
resp.raise_for_status()
print(resp.json())`;

const OCR_CURL = `IMG_B64=$(base64 -i invoice.png | tr -d '\\n')

curl -X POST ${BASE_URL}/v1/ocr \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d "{
    \\"model\\": \\"demo-ocr-model\\",
    \\"image\\": \\"data:image/png;base64,\${IMG_B64}\\"
  }"

# 平台统一暴露 POST /v1/ocr；管理员在上游 OCR 服务接入中配置 base_url 时，
# 网关默认转发至上游 /recognize（可在模型接入中覆盖 upstream_path）。`;

const OCR_NODEJS = `import fs from 'fs';

const imgB64 = fs.readFileSync('invoice.png').toString('base64');
const resp = await fetch('${BASE_URL}/v1/ocr', {
  method: 'POST',
  headers: {
    Authorization: 'Bearer YOUR_API_KEY',
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    model: 'demo-ocr-model',
    image: \`data:image/png;base64,\${imgB64}\`,
  }),
});
console.log(await resp.json());`;

const FIM_PYTHON = `from openai import OpenAI

client = OpenAI(base_url="${BASE_URL}/v1", api_key="YOUR_API_KEY")

# 使用 /v1/completions（不是 /v1/chat/completions）
# 将光标前的代码作为 prompt，模型续写后续内容
response = client.completions.create(
    model="platform-flash",
    prompt="def fibonacci(n: int) -> int:\\n    if n <= 1:\\n        return n\\n    ",
    max_tokens=128,
    temperature=0.2,
    stop=["\\n\\n"],
)
print(response.choices[0].text)

# 流式
stream = client.completions.create(
    model="platform-flash",
    prompt="import numpy as np\\n\\ndef cosine_similarity(a, b):\\n    ",
    max_tokens=128,
    temperature=0.1,
    stream=True,
)
for chunk in stream:
    if chunk.choices[0].text:
        print(chunk.choices[0].text, end="", flush=True)`;

const FIM_CURL = `curl -X POST ${BASE_URL}/v1/completions \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "platform-flash",
    "prompt": "def fibonacci(n: int) -> int:\\n    if n <= 1:\\n        return n\\n    ",
    "max_tokens": 128,
    "temperature": 0.2,
    "stop": ["\\n\\n"]
  }'`;

const FIM_NODEJS = `import OpenAI from 'openai';

const client = new OpenAI({ baseURL: '${BASE_URL}/v1', apiKey: 'YOUR_API_KEY' });

const response = await client.completions.create({
  model:       'platform-flash',
  prompt:      'def fibonacci(n: int) -> int:\\n    if n <= 1:\\n        return n\\n    ',
  max_tokens:  128,
  temperature: 0.2,
  stop:        ['\\n\\n'],
});
console.log(response.choices[0].text);`;

const CC_PYTHON = `# pip install anthropic
import anthropic

client = anthropic.Anthropic(
    base_url="${BASE_URL}",   # SDK 自动拼接 /v1
    api_key="YOUR_API_KEY",   # 亦可通过 x-api-key 请求头传递同一密钥
)

# 非流式
message = client.messages.create(
    model="platform-sota",
    max_tokens=1024,
    system="你是一个有帮助的助手。",
    messages=[{"role": "user", "content": "请解释什么是大语言模型？"}],
)
print(message.content[0].text)

# 流式
with client.messages.stream(
    model="platform-sota",
    max_tokens=1024,
    messages=[{"role": "user", "content": "请解释什么是大语言模型？"}],
) as stream:
    for text in stream.text_stream:
        print(text, end="", flush=True)`;

const CC_CURL = `# 非流式（Authorization: Bearer 与 x-api-key 均可）
curl -X POST ${BASE_URL}/v1/messages \\
  -H "x-api-key: YOUR_API_KEY" \\
  -H "anthropic-version: 2023-06-01" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "platform-sota",
    "max_tokens": 1024,
    "system": "你是一个有帮助的助手。",
    "messages": [{"role": "user", "content": "请解释什么是大语言模型？"}]
  }'

# 流式
curl -X POST ${BASE_URL}/v1/messages \\
  -H "x-api-key: YOUR_API_KEY" \\
  -H "anthropic-version: 2023-06-01" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "platform-sota",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "请解释什么是大语言模型？"}],
    "stream": true
  }'`;

const CC_NODEJS = `// npm install @anthropic-ai/sdk
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({
  baseURL: '${BASE_URL}',   // SDK appends /v1 automatically
  apiKey:  'YOUR_API_KEY',
});

// Non-streaming
const message = await client.messages.create({
  model: 'platform-sota', max_tokens: 1024,
  system: '你是一个有帮助的助手。',
  messages: [{ role: 'user', content: '请解释什么是大语言模型？' }],
});
console.log(message.content[0].text);

// Streaming
const stream = client.messages.stream({
  model: 'platform-sota', max_tokens: 1024,
  messages: [{ role: 'user', content: '请解释什么是大语言模型？' }],
});
stream.on('text', (text) => process.stdout.write(text));
await stream.finalMessage();`;

const CODEX_PYTHON = `# pip install openai
from openai import OpenAI

client = OpenAI(
    base_url="${BASE_URL}/v1",
    api_key="YOUR_API_KEY",
)

# ── 基础用法 ─────────────────────────────────────────────────────────────────
response = client.responses.create(
    model="platform-sota",
    input="用 Python 写一个快速排序函数",
    instructions="你是一个代码编写助手",
)
print(response.output[0].content[0].text)

# ── 携带工具（Codex CLI 核心用法）────────────────────────────────────────────
tools = [{
    "type": "function",
    "name": "bash",
    "description": "在 shell 中执行命令",
    "parameters": {
        "type": "object",
        "properties": {
            "command": {"type": "string", "description": "要执行的命令"}
        },
        "required": ["command"]
    }
}]

response = client.responses.create(
    model="platform-sota",
    instructions="你是一个可以执行命令的代码助手。",
    input="列出当前目录下的所有 Python 文件",
    tools=tools,
)

for item in response.output:
    if item.type == "function_call":
        print(f"工具调用: {item.name}({item.arguments})")
    elif item.type == "message":
        for c in item.content:
            print(c.text)`;

const CODEX_CURL = `# ── 配置 Codex CLI 使用本平台 ─────────────────────────────────────────────
# 将以下内容写入 ~/.codex/config.toml：
# model = "platform-sota"
# model_provider = "platform"
#
# [model_providers.platform]
# name = "My API Platform"
# base_url = "${BASE_URL}/v1"
# env_key = "PLATFORM_API_KEY"
# wire_api = "responses"
# request_max_retries = 4
# stream_max_retries = 10
# stream_idle_timeout_ms = 300000

export PLATFORM_API_KEY="YOUR_API_KEY"
# codex "列出当前目录的 Python 文件并重构其中一个函数"

# ── 直接调用 /v1/responses（无工具）────────────────────────────────────────
curl -X POST ${BASE_URL}/v1/responses \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "platform-flash",
    "input": "用 Python 写一个快速排序函数",
    "instructions": "你是一个代码编写助手"
  }'

# ── 携带工具（Codex 模式）──────────────────────────────────────────────────
curl -X POST ${BASE_URL}/v1/responses \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "platform-flash",
    "instructions": "你是一个可以执行命令的代码助手。",
    "input": "列出当前目录下的所有 Python 文件",
    "tools": [{
      "type": "function",
      "name": "bash",
      "description": "执行 shell 命令",
      "parameters": {
        "type": "object",
        "properties": {"command": {"type": "string"}},
        "required": ["command"]
      }
    }]
  }'`;

const CODEX_NODEJS = `import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: '${BASE_URL}/v1',
  apiKey:  'YOUR_API_KEY',
});

const response = await client.responses.create({
  model: 'platform-flash',
  input: '用 Python 写一个快速排序函数',
  instructions: '你是一个代码编写助手',
  tools: [{
    type: 'function',
    name: 'bash',
    description: '执行 shell 命令',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string', description: '要执行的命令' } },
      required: ['command'],
    },
  }],
});

for (const item of response.output) {
  if (item.type === 'function_call') {
    console.log('工具调用:', item.name, item.arguments);
  } else if (item.type === 'message') {
    console.log(item.content[0].text);
  }
}`;

const CC_TOOL_PYTHON = `# pip install anthropic
import anthropic

client = anthropic.Anthropic(
    base_url="${BASE_URL}",   # SDK 自动拼接 /v1/messages
    api_key="YOUR_API_KEY",
)

# ── 配置 CC CLI 使用本平台 ─────────────────────────────────────────
# export ANTHROPIC_BASE_URL="${BASE_URL}"
# export ANTHROPIC_AUTH_TOKEN="YOUR_API_KEY"
# export ANTHROPIC_DEFAULT_OPUS_MODEL="platform-sota"
# export ANTHROPIC_DEFAULT_SONNET_MODEL="platform-sota"
# export ANTHROPIC_DEFAULT_HAIKU_MODEL="platform-flash"
# npx @anthropic-ai/claude-code "帮我优化当前目录的代码"

# ── CC 内置工具（bash / text_editor）───────────────────────────────
tools = [
    {"type": "bash_20241022",        "name": "bash"},
    {"type": "text_editor_20241022", "name": "str_replace_editor"},
]

message = client.messages.create(
    model="platform-sota",
    max_tokens=4096,
    tools=tools,
    messages=[{
        "role": "user",
        "content": "列出当前目录下的 Python 文件"
    }],
)

for block in message.content:
    if block.type == "tool_use":
        print(f"[工具调用] {block.name}")
        print(f"参数: {block.input}")
    elif block.type == "text":
        print(block.text)

# stop_reason == "tool_use" 时需将工具结果通过 tool_result 回传
if message.stop_reason == "tool_use":
    tool_block = next(b for b in message.content if b.type == "tool_use")
    # 执行工具 ... 然后将结果回传
    follow_up = client.messages.create(
        model="platform-sota",
        max_tokens=4096,
        tools=tools,
        messages=[
            {"role": "user",      "content": "列出当前目录下的 Python 文件"},
            {"role": "assistant", "content": message.content},
            {"role": "user",      "content": [{
                "type": "tool_result",
                "tool_use_id": tool_block.id,
                "content": "main.py\\nutils.py\\ntest_main.py",
            }]},
        ],
    )
    print(follow_up.content[0].text)`;

const CC_TOOL_CURL = `# ── 配置 CC CLI 使用本平台 ──────────────────────────────────────
export ANTHROPIC_BASE_URL="${BASE_URL}"
export ANTHROPIC_AUTH_TOKEN="YOUR_API_KEY"
# Claude Code 使用内置的 opus/sonnet/haiku 别名；映射到平台真实模型，避免 404。
export ANTHROPIC_DEFAULT_OPUS_MODEL="platform-sota"
export ANTHROPIC_DEFAULT_SONNET_MODEL="platform-sota"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="platform-flash"
# npx @anthropic-ai/claude-code "帮我优化当前目录的代码"

# ── 直接调用（带内置工具）─────────────────────────────────────────────────
curl -X POST ${BASE_URL}/v1/messages \\
  -H "x-api-key: YOUR_API_KEY" \\
  -H "anthropic-version: 2023-06-01" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "platform-flash",
    "max_tokens": 4096,
    "tools": [
      {"type": "bash_20241022",        "name": "bash"},
      {"type": "text_editor_20241022", "name": "str_replace_editor"}
    ],
    "messages": [{
      "role": "user",
      "content": "列出当前目录下的 Python 文件"
    }]
  }'

# 若 stop_reason == "tool_use"，则回传工具执行结果：
# -d '{..., "messages": [..., {"role": "user", "content": [
#   {"type": "tool_result", "tool_use_id": "...", "content": "main.py\\nutils.py"}
# ]}]}'`;

const CC_TOOL_NODEJS = `// npm install @anthropic-ai/sdk
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({
  baseURL: '${BASE_URL}',
  apiKey:  'YOUR_API_KEY',
});

const message = await client.messages.create({
  model: 'platform-flash',
  max_tokens: 4096,
  tools: [
    { type: 'bash_20241022',        name: 'bash' },
    { type: 'text_editor_20241022', name: 'str_replace_editor' },
  ],
  messages: [{
    role: 'user',
    content: '列出当前目录下的 Python 文件',
  }],
});

for (const block of message.content) {
  if (block.type === 'tool_use') {
    console.log('[工具调用]', block.name, block.input);
  } else if (block.type === 'text') {
    console.log(block.text);
  }
}

// Send the tool result back when stop_reason === 'tool_use'
if (message.stop_reason === 'tool_use') {
  const toolBlock = message.content.find(b => b.type === 'tool_use');
  const followUp = await client.messages.create({
    model: 'platform-flash',
    max_tokens: 4096,
    tools: message.request?.tools ?? [],
    messages: [
      { role: 'user',      content: '列出当前目录下的 Python 文件' },
      { role: 'assistant', content: message.content },
      { role: 'user',      content: [{
        type: 'tool_result',
        tool_use_id: toolBlock!.id,
        content: 'main.ts\\nutils.ts\\nindex.ts',
      }]},
    ],
  });
  console.log(followUp.content[0].text);
}`;

const THINKING_PYTHON = `from openai import OpenAI

client = OpenAI(base_url="${BASE_URL}/v1", api_key="YOUR_API_KEY")

# 推理模型先输出思维链（reasoning_content），再输出最终答案（content）
response = client.chat.completions.create(
    model="demo-reasoning-model",
    messages=[{"role": "user", "content": "9.11 和 9.8 哪个更大？"}],
)

msg = response.choices[0].message
print("思维链：", msg.reasoning_content)   # 推理过程，仅供展示
print("最终答案：", msg.content)            # 真正的回答

# 推理类模型可显式开关思考模式：
# extra_body={"chat_template_kwargs": {"enable_thinking": True}}`;

const THINKING_CURL = `curl -X POST ${BASE_URL}/v1/chat/completions \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "demo-reasoning-model",
    "messages": [{"role": "user", "content": "9.11 和 9.8 哪个更大？"}]
  }'

# 响应字段：
#   choices[0].message.reasoning_content  → 思维链（推理过程）
#   choices[0].message.content            → 最终答案
# 注意：进行多轮对话时，不要把上一轮的 reasoning_content 放回 messages。`;

const THINKING_NODEJS = `import OpenAI from 'openai';

const client = new OpenAI({ baseURL: '${BASE_URL}/v1', apiKey: 'YOUR_API_KEY' });

const res = await client.chat.completions.create({
  model: 'demo-reasoning-model',
  messages: [{ role: 'user', content: '9.11 和 9.8 哪个更大？' }],
});

const msg = res.choices[0].message;
console.log('思维链：', msg.reasoning_content);  // 推理过程
console.log('最终答案：', msg.content);           // 最终回答`;

const MULTITURN_PYTHON = `from openai import OpenAI

client = OpenAI(base_url="${BASE_URL}/v1", api_key="YOUR_API_KEY")

# API 本身无状态：多轮对话需要自行把完整历史一并传入
messages = [{"role": "user", "content": "我叫小明。"}]
r1 = client.chat.completions.create(model="platform-flash", messages=messages)
messages.append(r1.choices[0].message)              # 把助手回复追加进历史

messages.append({"role": "user", "content": "我叫什么名字？"})
r2 = client.chat.completions.create(model="platform-flash", messages=messages)
print(r2.choices[0].message.content)                # → 你叫小明`;

const MULTITURN_CURL = `# 第二轮请求需携带前面所有轮次的 messages（API 不保存上下文）
curl -X POST ${BASE_URL}/v1/chat/completions \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "platform-flash",
    "messages": [
      {"role": "user",      "content": "我叫小明。"},
      {"role": "assistant", "content": "你好小明，很高兴认识你！"},
      {"role": "user",      "content": "我叫什么名字？"}
    ]
  }'`;

const MULTITURN_NODEJS = `import OpenAI from 'openai';

const client = new OpenAI({ baseURL: '${BASE_URL}/v1', apiKey: 'YOUR_API_KEY' });

// Maintain a messages history and append assistant replies each turn
const messages = [{ role: 'user', content: '我叫小明。' }];
const r1 = await client.chat.completions.create({ model: 'platform-flash', messages });
messages.push(r1.choices[0].message);

messages.push({ role: 'user', content: '我叫什么名字？' });
const r2 = await client.chat.completions.create({ model: 'platform-flash', messages });
console.log(r2.choices[0].message.content);          // → 你叫小明`;

const JSON_PYTHON = `from openai import OpenAI
import json

client = OpenAI(base_url="${BASE_URL}/v1", api_key="YOUR_API_KEY")

response = client.chat.completions.create(
    model="platform-flash",
    messages=[
        {"role": "system", "content": "请以 JSON 输出，字段：country、capital。"},
        {"role": "user",   "content": "中国的首都是哪里？"},
    ],
    response_format={"type": "json_object"},   # 强制返回合法 JSON
)
data = json.loads(response.choices[0].message.content)
print(data)                                    # → {'country': '中国', 'capital': '北京'}`;

const JSON_CURL = `curl -X POST ${BASE_URL}/v1/chat/completions \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "platform-flash",
    "messages": [
      {"role": "system", "content": "请以 JSON 输出，字段：country、capital。"},
      {"role": "user",   "content": "中国的首都是哪里？"}
    ],
    "response_format": {"type": "json_object"}
  }'

# 提示：system 提示中需说明 JSON 结构，且至少出现一次 "json" 字样。`;

const JSON_NODEJS = `import OpenAI from 'openai';

const client = new OpenAI({ baseURL: '${BASE_URL}/v1', apiKey: 'YOUR_API_KEY' });

const res = await client.chat.completions.create({
  model: 'platform-flash',
  messages: [
    { role: 'system', content: '请以 JSON 输出，字段：country、capital。' },
    { role: 'user',   content: '中国的首都是哪里？' },
  ],
  response_format: { type: 'json_object' },
});
console.log(JSON.parse(res.choices[0].message.content));`;

const KILO_CURL = `# ── 在 Kilo Code 中接入本平台 ──────────────────────────────────────────────
# 在 VS Code 安装 Kilo Code 扩展后，打开其设置面板，按如下填写：
#   API Provider:  OpenAI Compatible
#   Base URL:      ${BASE_URL}/v1
#   API Key:       YOUR_API_KEY
#   Model:         platform-flash
#
# 配置完成即可在编辑器内对话改代码。Kilo Code 底层走 OpenAI 兼容的
# /v1/chat/completions（带 tools），与下面请求等价：

curl -X POST ${BASE_URL}/v1/chat/completions \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "platform-flash",
    "messages": [{"role": "user", "content": "重构这段函数并加上类型注解"}],
    "tools": [{"type": "function", "function": {
      "name": "write_file", "description": "写入文件",
      "parameters": {"type": "object", "properties": {
        "path": {"type": "string"}, "content": {"type": "string"}},
        "required": ["path", "content"]}}}],
    "tool_choice": "auto"
  }'`;

const KILO_PYTHON = `# Kilo Code 是 VS Code 扩展，在设置中选择 "OpenAI Compatible" 提供商，
# 填入 Base URL / API Key / Model 即可。其底层等价于如下 OpenAI 调用：
from openai import OpenAI

client = OpenAI(base_url="${BASE_URL}/v1", api_key="YOUR_API_KEY")

response = client.chat.completions.create(
    model="platform-flash",
    messages=[{"role": "user", "content": "重构这段函数并加上类型注解"}],
    tools=[{
        "type": "function",
        "function": {
            "name": "write_file",
            "description": "写入文件",
            "parameters": {"type": "object", "properties": {
                "path": {"type": "string"}, "content": {"type": "string"}},
                "required": ["path", "content"]},
        },
    }],
    tool_choice="auto",
)
print(response.choices[0].message.tool_calls or response.choices[0].message.content)`;

const KILO_NODEJS = `// Kilo Code 是 VS Code 扩展：设置中选 "OpenAI Compatible"，填入
// Base URL / API Key / Model 即可。底层等价于如下 OpenAI 调用：
import OpenAI from 'openai';

const client = new OpenAI({ baseURL: '${BASE_URL}/v1', apiKey: 'YOUR_API_KEY' });

const res = await client.chat.completions.create({
  model: 'platform-flash',
  messages: [{ role: 'user', content: '重构这段函数并加上类型注解' }],
  tools: [{
    type: 'function',
    function: {
      name: 'write_file',
      description: '写入文件',
      parameters: { type: 'object', properties: {
        path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content'] },
    },
  }],
  tool_choice: 'auto',
});
console.log(res.choices[0].message.tool_calls ?? res.choices[0].message.content);`;

const LIST_MODELS_PYTHON = `from openai import OpenAI

client = OpenAI(base_url="${BASE_URL}/v1", api_key="YOUR_API_KEY")

# 获取当前可调用的模型列表
models = client.models.list()
for m in models.data:
    print(f"{m.id}  {m.object}")`;

const LIST_MODELS_CURL = `curl -s ${BASE_URL}/v1/models \
  -H "Authorization: Bearer YOUR_API_KEY"`;

const LIST_MODELS_NODEJS = `import OpenAI from 'openai';

const client = new OpenAI({ baseURL: '${BASE_URL}/v1', apiKey: 'YOUR_API_KEY' });

const models = await client.models.list();
for (const m of models.data) {
  console.log(m.id);
}`;

const RETRY_PYTHON = `import time
import httpx

API_URL = "${BASE_URL}/v1/chat/completions"
headers = {"Authorization": "Bearer YOUR_API_KEY"}

for attempt in range(5):
    resp = httpx.post(API_URL, headers=headers, json={"model": "platform-flash", "messages": [{"role": "user", "content": "Hi"}]}, timeout=60)
    if resp.status_code == 200:
        print(resp.json())
        break
    if resp.status_code in (429, 503):
        wait = int(resp.headers.get("Retry-After", 2 ** attempt))
        print(f"受限，等待 {wait}s 后重试...")
        time.sleep(wait)
    else:
        resp.raise_for_status()`;

const RETRY_CURL = `# 当收到 429 / 503 时，读取 Retry-After 头并按指数退避重试
for i in 0 1 2 3 4; do
  resp=$(curl -s -w "\\nHTTP_CODE:%{http_code}" -X POST ${BASE_URL}/v1/chat/completions \\
    -H "Authorization: Bearer YOUR_API_KEY" \\
    -H "Content-Type: application/json" \\
    -d '{"model":"platform-flash","messages":[{"role":"user","content":"Hi"}]}')
  code=$(echo "$resp" | grep 'HTTP_CODE:' | cut -d: -f2)
  if [ "$code" = "200" ]; then echo "$resp"; break; fi
  wait=$(echo "$resp" | grep -i 'Retry-After:' | awk '{print $2}' | tr -d '\\r')
  wait=\${wait:-$((2 ** i))}
  echo "受限 ($code)，等待 \${wait}s 后重试..."
  sleep "$wait"
done`;

const RETRY_NODEJS = `import fetch from 'node-fetch';

const API_URL = '${BASE_URL}/v1/chat/completions';
const headers = { Authorization: 'Bearer YOUR_API_KEY', 'Content-Type': 'application/json' };

for (let attempt = 0; attempt < 5; attempt++) {
  const resp = await fetch(API_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model: 'platform-flash', messages: [{ role: 'user', content: 'Hi' }] }),
  });
  if (resp.ok) {
    console.log(await resp.json());
    break;
  }
  if (resp.status === 429 || resp.status === 503) {
    const wait = Number(resp.headers.get('Retry-After') || 2 ** attempt);
    console.log(\`Rate limited (\${resp.status}), waiting \${wait}s...\`);
    await new Promise((r) => setTimeout(r, wait * 1000));
  } else {
    throw new Error(\`HTTP \${resp.status}\`);
  }
}`;

// ── Tab metadata ──────────────────────────────────────────────────────────────
export const tabs = [
  { key: "curl",   label: "cURL",    lang: "bash"       },
  { key: "python", label: "Python",  lang: "python"     },
  { key: "nodejs", label: "Node.js", lang: "javascript" },
] as const;
export type TabKey = "python" | "curl" | "nodejs";
export const tabLang: Record<TabKey, "python" | "bash" | "javascript"> = {
  python: "python", curl: "bash", nodejs: "javascript",
};

const tabCode:         Record<TabKey, string> = { python: PYTHON,              curl: CURL,               nodejs: NODEJS              };
const tabFile:         Record<TabKey, string> = { python: "example.py",        curl: "example.sh",       nodejs: "example.mjs"       };
const streamCode:      Record<TabKey, string> = { python: STREAM_PYTHON,       curl: STREAM_CURL,        nodejs: STREAM_NODEJS       };
const streamFile:      Record<TabKey, string> = { python: "stream.py",         curl: "stream.sh",        nodejs: "stream.mjs"        };
const toolCode:        Record<TabKey, string> = { python: TOOL_PYTHON,         curl: TOOL_CURL,          nodejs: TOOL_NODEJS         };
const toolFile:        Record<TabKey, string> = { python: "tool_call.py",      curl: "tool_call.sh",     nodejs: "tool_call.mjs"     };
const imageCode:       Record<TabKey, string> = { python: IMAGE_PYTHON,        curl: IMAGE_CURL,         nodejs: IMAGE_NODEJS        };
const imageFile:       Record<TabKey, string> = { python: "vision.py",         curl: "vision.sh",        nodejs: "vision.mjs"        };
const embeddingCode:   Record<TabKey, string> = { python: EMBEDDING_PYTHON,    curl: EMBEDDING_CURL,     nodejs: EMBEDDING_NODEJS    };
const embeddingFile:   Record<TabKey, string> = { python: "embedding.py",      curl: "embedding.sh",     nodejs: "embedding.mjs"     };
const rerankerCode:    Record<TabKey, string> = { python: RERANKER_PYTHON,     curl: RERANKER_CURL,      nodejs: RERANKER_NODEJS     };
const rerankerFile:    Record<TabKey, string> = { python: "reranker.py",       curl: "reranker.sh",      nodejs: "reranker.mjs"      };
const ocrCode:         Record<TabKey, string> = { python: OCR_PYTHON,          curl: OCR_CURL,           nodejs: OCR_NODEJS          };
const ocrFile:         Record<TabKey, string> = { python: "ocr.py",            curl: "ocr.sh",           nodejs: "ocr.mjs"           };
const fimCode:         Record<TabKey, string> = { python: FIM_PYTHON,          curl: FIM_CURL,           nodejs: FIM_NODEJS          };
const fimFile:         Record<TabKey, string> = { python: "fim.py",            curl: "fim.sh",           nodejs: "fim.mjs"           };
const ccCode:          Record<TabKey, string> = { python: CC_PYTHON,           curl: CC_CURL,            nodejs: CC_NODEJS           };
const ccFile:          Record<TabKey, string> = { python: "cc_messages.py",    curl: "cc_messages.sh",   nodejs: "cc_messages.mjs"   };
const codexCode:       Record<TabKey, string> = { python: CODEX_PYTHON,        curl: CODEX_CURL,         nodejs: CODEX_NODEJS        };
const codexFile:       Record<TabKey, string> = { python: "codex.py",          curl: "codex.sh",         nodejs: "codex.mjs"         };
const ccToolCode:  Record<TabKey, string> = { python: CC_TOOL_PYTHON,  curl: CC_TOOL_CURL,   nodejs: CC_TOOL_NODEJS  };
const ccToolFile:  Record<TabKey, string> = { python: "cc_tool.py",    curl: "cc_tool.sh",   nodejs: "cc_tool.mjs"   };
const thinkingCode:    Record<TabKey, string> = { python: THINKING_PYTHON,     curl: THINKING_CURL,      nodejs: THINKING_NODEJS     };
const thinkingFile:    Record<TabKey, string> = { python: "thinking.py",       curl: "thinking.sh",      nodejs: "thinking.mjs"      };
const multiturnCode:   Record<TabKey, string> = { python: MULTITURN_PYTHON,    curl: MULTITURN_CURL,     nodejs: MULTITURN_NODEJS    };
const multiturnFile:   Record<TabKey, string> = { python: "multi_turn.py",     curl: "multi_turn.sh",    nodejs: "multi_turn.mjs"    };
const jsonCode:        Record<TabKey, string> = { python: JSON_PYTHON,         curl: JSON_CURL,          nodejs: JSON_NODEJS         };
const jsonFile:        Record<TabKey, string> = { python: "json_output.py",    curl: "json_output.sh",   nodejs: "json_output.mjs"   };
const kiloCode:        Record<TabKey, string> = { python: KILO_PYTHON,         curl: KILO_CURL,          nodejs: KILO_NODEJS         };
const kiloFile:        Record<TabKey, string> = { python: "kilo_code.py",      curl: "kilo_code.sh",     nodejs: "kilo_code.mjs"      };
const listModelsCode:  Record<TabKey, string> = { python: LIST_MODELS_PYTHON,  curl: LIST_MODELS_CURL,  nodejs: LIST_MODELS_NODEJS  };
const listModelsFile:  Record<TabKey, string> = { python: "list_models.py",    curl: "list_models.sh",   nodejs: "list_models.mjs"   };
export const retryCode:       Record<TabKey, string> = { python: RETRY_PYTHON,        curl: RETRY_CURL,        nodejs: RETRY_NODEJS        };
export const retryFile:       Record<TabKey, string> = { python: "retry.py",          curl: "retry.sh",         nodejs: "retry.mjs"          };

// ── Intent Scenarios ──────────────────────────────────────────────────────────
export type ScenarioKey =
  | "chat" | "stream" | "tool" | "vision" | "embedding" | "reranker" | "ocr" | "fim"
  | "thinking" | "multiturn" | "json" | "list_models"
  | "cc" | "codex" | "cc_tool" | "kilo";

type ScenarioGroup = "api" | "agent";

export interface Scenario {
  key: ScenarioKey;
  group: ScenarioGroup;
  Icon: ComponentType<{ className?: string }>;
  ic: string; iconBg: string; selBg: string; selBorder: string;
  titleKey: TranslationKey; descKey: TranslationKey; tagKey: TranslationKey; api: string;
}

/** 场景标题/描述/标签均为 docsPage.scenarios.<key>.* i18n key（见 i18n/*.ts） */
export const SCENARIOS: Scenario[] = [
  { key: "chat",        group: "api",   Icon: MessageSquare, ic: "text-orange-500", iconBg: "var(--bg-soft)", selBg: "bg-orange-500/10",  selBorder: "border-orange-400",  titleKey: "docsPage.scenarios.chat.title",       descKey: "docsPage.scenarios.chat.desc",       tagKey: "docsPage.scenarios.chat.tag",       api: "POST /v1/chat/completions" },
  { key: "stream",      group: "api",   Icon: Zap,           ic: "text-yellow-500", iconBg: "var(--bg-soft)", selBg: "bg-yellow-500/10",  selBorder: "border-yellow-400",  titleKey: "docsPage.scenarios.stream.title",     descKey: "docsPage.scenarios.stream.desc",     tagKey: "docsPage.scenarios.stream.tag",     api: "POST /v1/chat/completions" },
  { key: "thinking",    group: "api",   Icon: Brain,         ic: "text-fuchsia-500",iconBg: "var(--bg-soft)", selBg: "bg-fuchsia-500/10", selBorder: "border-fuchsia-400", titleKey: "docsPage.scenarios.thinking.title",   descKey: "docsPage.scenarios.thinking.desc",   tagKey: "docsPage.scenarios.thinking.tag",   api: "POST /v1/chat/completions" },
  { key: "multiturn",   group: "api",   Icon: Repeat,        ic: "text-rose-500",   iconBg: "var(--bg-soft)", selBg: "bg-rose-500/10",    selBorder: "border-rose-400",    titleKey: "docsPage.scenarios.multiturn.title",  descKey: "docsPage.scenarios.multiturn.desc",  tagKey: "docsPage.scenarios.multiturn.tag",  api: "POST /v1/chat/completions" },
  { key: "tool",        group: "api",   Icon: Wrench,        ic: "text-blue-500",   iconBg: "var(--bg-soft)", selBg: "bg-blue-500/10",    selBorder: "border-blue-400",    titleKey: "docsPage.scenarios.tool.title",       descKey: "docsPage.scenarios.tool.desc",       tagKey: "docsPage.scenarios.tool.tag",       api: "POST /v1/chat/completions" },
  { key: "json",        group: "api",   Icon: Braces,        ic: "text-green-600",  iconBg: "var(--bg-soft)", selBg: "bg-ok/100/10",   selBorder: "border-green-400",   titleKey: "docsPage.scenarios.json.title",       descKey: "docsPage.scenarios.json.desc",       tagKey: "docsPage.scenarios.json.tag",       api: "POST /v1/chat/completions" },
  { key: "vision",      group: "api",   Icon: ImageIcon,     ic: "text-amber-500",  iconBg: "var(--bg-soft)", selBg: "bg-warn/100/10",   selBorder: "border-amber-400",   titleKey: "docsPage.scenarios.vision.title",     descKey: "docsPage.scenarios.vision.desc",     tagKey: "docsPage.scenarios.vision.tag",     api: "POST /v1/chat/completions" },
  { key: "embedding",   group: "api",   Icon: Layers,        ic: "text-emerald-500",iconBg: "var(--bg-soft)", selBg: "bg-emerald-500/10", selBorder: "border-emerald-400", titleKey: "docsPage.scenarios.embedding.title",  descKey: "docsPage.scenarios.embedding.desc",  tagKey: "docsPage.scenarios.embedding.tag",  api: "POST /v1/embeddings" },
  { key: "reranker",    group: "api",   Icon: ArrowUpDown,   ic: "text-teal-500",   iconBg: "var(--bg-soft)", selBg: "bg-teal-500/10",    selBorder: "border-teal-400",    titleKey: "docsPage.scenarios.reranker.title",   descKey: "docsPage.scenarios.reranker.desc",   tagKey: "docsPage.scenarios.reranker.tag",   api: "POST /v1/rerank" },
  { key: "ocr",         group: "api",   Icon: ScanLine,      ic: "text-sky-600",    iconBg: "var(--bg-soft)", selBg: "bg-sky-500/10",     selBorder: "border-sky-400",     titleKey: "docsPage.scenarios.ocr.title",        descKey: "docsPage.scenarios.ocr.desc",        tagKey: "docsPage.scenarios.ocr.tag",        api: "POST /v1/ocr" },
  { key: "fim",         group: "api",   Icon: Code2,         ic: "text-purple-500", iconBg: "var(--bg-soft)", selBg: "bg-purple-500/10",  selBorder: "border-purple-400",  titleKey: "docsPage.scenarios.fim.title",        descKey: "docsPage.scenarios.fim.desc",        tagKey: "docsPage.scenarios.fim.tag",        api: "POST /v1/completions" },
  { key: "list_models", group: "api",   Icon: List,          ic: "text-slate-500",  iconBg: "var(--bg-soft)", selBg: "bg-slate-500/10",   selBorder: "border-slate-400",   titleKey: "docsPage.scenarios.listModels.title", descKey: "docsPage.scenarios.listModels.desc", tagKey: "docsPage.scenarios.listModels.tag", api: "GET /v1/models" },
  { key: "cc",          group: "api",   Icon: Bot,           ic: "text-violet-500", iconBg: "var(--bg-soft)", selBg: "bg-violet-500/10",  selBorder: "border-violet-400",  titleKey: "docsPage.scenarios.cc.title",         descKey: "docsPage.scenarios.cc.desc",         tagKey: "docsPage.scenarios.cc.tag",         api: "POST /v1/messages" },
  { key: "codex",       group: "agent", Icon: Terminal,      ic: "text-sky-500",    iconBg: "var(--bg-soft)", selBg: "bg-sky-500/10",     selBorder: "border-sky-400",     titleKey: "docsPage.scenarios.codex.title",      descKey: "docsPage.scenarios.codex.desc",      tagKey: "docsPage.scenarios.codex.tag",      api: "POST /v1/responses" },
  { key: "cc_tool",     group: "agent", Icon: Cpu,           ic: "text-indigo-500", iconBg: "var(--bg-soft)", selBg: "bg-indigo-500/10",  selBorder: "border-indigo-400",  titleKey: "docsPage.scenarios.ccTool.title",     descKey: "docsPage.scenarios.ccTool.desc",     tagKey: "docsPage.scenarios.ccTool.tag",     api: "POST /v1/messages" },
  { key: "kilo",        group: "agent", Icon: Boxes,         ic: "text-cyan-600",   iconBg: "var(--bg-soft)", selBg: "bg-cyan-500/10",    selBorder: "border-cyan-400",    titleKey: "docsPage.scenarios.kilo.title",       descKey: "docsPage.scenarios.kilo.desc",       tagKey: "docsPage.scenarios.kilo.tag",       api: "OpenAI Compatible" },
];

export const SCENARIO_CODE: Record<ScenarioKey, Record<TabKey, string>> = {
  chat: tabCode, stream: streamCode, tool: toolCode,
  vision: imageCode, embedding: embeddingCode, reranker: rerankerCode, ocr: ocrCode,
  fim: fimCode, thinking: thinkingCode, multiturn: multiturnCode,
  json: jsonCode, cc: ccCode, list_models: listModelsCode,
  codex: codexCode, cc_tool: ccToolCode, kilo: kiloCode,
};
export const SCENARIO_FILE: Record<ScenarioKey, Record<TabKey, string>> = {
  chat: tabFile, stream: streamFile, tool: toolFile,
  vision: imageFile, embedding: embeddingFile, reranker: rerankerFile, ocr: ocrFile,
  fim: fimFile, thinking: thinkingFile, multiturn: multiturnFile,
  json: jsonFile, cc: ccFile, list_models: listModelsFile,
  codex: codexFile, cc_tool: ccToolFile, kilo: kiloFile,
};

/** 场景高亮说明为 docsPage.scenarios.<key>.highlight（label 已 i18n，snippet 为字面代码不翻译） */
export const SCENARIO_HIGHLIGHT: Partial<Record<ScenarioKey, { labelKey: TranslationKey; snippet: string }>> = {
  stream:    { labelKey: "docsPage.scenarios.stream.highlight",    snippet: `stream=True` },
  tool:      { labelKey: "docsPage.scenarios.tool.highlight",      snippet: `tools=[{...}], tool_choice="auto"` },
  thinking:  { labelKey: "docsPage.scenarios.thinking.highlight",  snippet: `msg.reasoning_content` },
  vision:    { labelKey: "docsPage.scenarios.vision.highlight",    snippet: `{"type": "image_url", "image_url": {"url": "data:..."}}` },
  embedding: { labelKey: "docsPage.scenarios.embedding.highlight", snippet: `client.embeddings.create(model="demo-embedding-model", input=...)` },
  reranker:  { labelKey: "docsPage.scenarios.reranker.highlight",  snippet: `POST /v1/rerank` },
  ocr:       { labelKey: "docsPage.scenarios.ocr.highlight",       snippet: `POST /v1/ocr` },
  fim:       { labelKey: "docsPage.scenarios.fim.highlight",       snippet: `client.completions.create(model="...", prompt="...")` },
  json:      { labelKey: "docsPage.scenarios.json.highlight",      snippet: `response_format={"type": "json_object"}` },
  multiturn: { labelKey: "docsPage.scenarios.multiturn.highlight", snippet: `messages.append(response.choices[0].message)` },
  cc:        { labelKey: "docsPage.scenarios.cc.highlight",        snippet: `client.messages.create(model="platform-sota", ...)` },
  list_models: { labelKey: "docsPage.scenarios.listModels.highlight", snippet: `GET /v1/models` },
};

export const AGENT_LOGOS: Partial<Record<ScenarioKey, string>> = {
  codex: "/img/logos/codex-color.png",
  cc_tool: "/img/logos/claude-color.png",
  kilo: "/img/logos/vscode.png",
};

export const MONO = { fontFamily: "var(--font-mono)" };

// ── Response examples ────────────────────────────────────────────────────────
export const RESPONSE_CHAT = `{
  "id": "chatcmpl-abc123",
  "object": "chat.completion",
  "created": 1718000000,
  "model": "platform-flash",
  "choices": [{
    "index": 0,
    "message": {
      "role": "assistant",
      "content": "大语言模型是一种基于Transformer架构..."
    },
    "finish_reason": "stop"
  }],
  "usage": {
    "prompt_tokens": 28,
    "completion_tokens": 156,
    "total_tokens": 184
  }
}`;

export const RESPONSE_STREAM = `// SSE event stream (text/event-stream)
data: {"id":"chatcmpl-stream","object":"chat.completion.chunk","created":1718000000,"model":"platform-flash","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}

data: {"id":"chatcmpl-stream","object":"chat.completion.chunk","created":1718000000,"model":"platform-flash","choices":[{"index":0,"delta":{"content":"大"},"finish_reason":null}]}

data: {"id":"chatcmpl-stream","object":"chat.completion.chunk","created":1718000000,"model":"platform-flash","choices":[{"index":0,"delta":{"content":"语言"},"finish_reason":null}]}

// ... more delta chunks ...

data: {"id":"chatcmpl-stream","object":"chat.completion.chunk","created":1718000000,"model":"platform-flash","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":28,"completion_tokens":156,"total_tokens":184}}

data: [DONE]`;

export const RESPONSE_EMBEDDING = `{
  "object": "list",
  "data": [{
    "object": "embedding",
    "index": 0,
    "embedding": [0.0123, -0.0456, 0.0789, ...] // 1024 维浮点数向量
  }],
  "model": "demo-embedding-model",
  "usage": {
    "prompt_tokens": 10,
    "total_tokens": 10
  }
}`;

export const RESPONSE_RERANK = `{
  "id": "rerank-abc123",
  "model": "demo-reranker-model",
  "results": [
    { "index": 0, "relevance_score": 0.92 },
    { "index": 2, "relevance_score": 0.87 },
    { "index": 1, "relevance_score": 0.12 }
  ]
}`;

export const RESPONSE_OCR = `{
  "results": [{
    "text": "发票代码：1234567890\\n发票号码：09876543\\n开票日期：2024年01月15日",
    "confidence": 0.98,
    "boxes": [
      { "text": "发票代码", "position": [120, 45, 220, 65], "confidence": 0.99 }
    ]
  }]
}`;

export const RESPONSE_COMPLETIONS = `{
  "id": "cmpl-abc123",
  "object": "text_completion",
  "created": 1718000000,
  "model": "platform-flash",
  "choices": [{
    "text": "    return fibonacci(n - 1) + fibonacci(n - 2)\\n\\ndef main():\\n    print(fibonacci(10))",
    "index": 0,
    "finish_reason": "stop"
  }],
  "usage": {
    "prompt_tokens": 15,
    "completion_tokens": 42,
    "total_tokens": 57
  }
}`;

export const RESPONSE_MESSAGES = `{
  "id": "msg_abc123",
  "type": "message",
  "role": "assistant",
  "model": "platform-sota",
  "content": [{
    "type": "text",
    "text": "大语言模型（LLM）是一种基于深度学习的..."
  }],
  "stop_reason": "end_turn",
  "stop_sequence": null,
  "usage": {
    "input_tokens": 42,
    "output_tokens": 156
  }
}`;

export const RESPONSE_RESPONSES = `{
  "id": "resp_abc123",
  "object": "response",
  "created_at": 1718000000,
  "model": "platform-sota",
  "output": [{
    "type": "message",
    "id": "msg_xyz789",
    "content": [{
      "type": "output_text",
      "text": "def quicksort(arr):\\n    if len(arr) <= 1:\\n        return arr\\n    pivot = arr[len(arr) // 2]..."
    }]
  }],
  "usage": {
    "input_tokens": 24,
    "output_tokens": 98,
    "total_tokens": 122
  }
}`;
