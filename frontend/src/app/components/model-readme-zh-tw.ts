/**
 * model-readme-zh-tw.ts
 *
 * 由 model-readme-zh.ts 通过 scripts/gen-model-readme-zh-tw.mjs 自动生成，
 * 简→繁字符级转换（OpenCC s2t），不做地区词汇替换。
 *
 * 不要手改此文件 —— 改 model-readme-zh.ts 后重新跑生成脚本同步。
 */
import type { ModelArticle } from "./model-readme-data";

export const ARTICLES_ZH_TW: Record<string, ModelArticle> = {
  "platform-sota": {
    "kicker": "Platform · 演示穩定別名",
    "title": "platform-sota",
    "subtitle": "由管理員配置目標模型的中性穩定別名；開源演示默認不連接真實上游。",
    "badges": [
      {
        "label": "類型",
        "value": "穩定別名"
      },
      {
        "label": "能力",
        "value": "管理員配置"
      },
      {
        "label": "數據",
        "value": "虛構演示"
      }
    ],
    "modelInfo": [
      {
        "label": "Model ID",
        "value": "platform-sota"
      },
      {
        "label": "Base URL",
        "value": "{{API_BASE_URL}}"
      },
      {
        "label": "API 格式",
        "value": "OpenAI 兼容"
      },
      {
        "label": "目標模型",
        "value": "由管理員配置"
      }
    ],
    "lead": "platform-sota 是用於演示穩定路由能力的虛構別名。管理員應在模型管理中將它指向已部署的高能力模型；倉庫不預置任何真實上游地址或憑證。",
    "highlights": [
      {
        "icon": "brain",
        "title": "穩定調用名稱",
        "body": "業務代碼使用固定 Model ID，底層目標可由管理員按需調整。"
      },
      {
        "icon": "tool",
        "title": "統一協議入口",
        "body": "配置上游後，可通過 OpenAI 兼容端點接入。"
      },
      {
        "icon": "context",
        "title": "部署方決定能力",
        "body": "上下文、速度與功能取決於管理員實際綁定的模型。"
      }
    ],
    "examples": [
      {
        "title": "Python SDK",
        "language": "python",
        "code": "from openai import OpenAI\n\nclient = OpenAI(\n    base_url=\"{{API_BASE_URL}}\",\n    api_key=\"{{API_KEY}}\",  # 替換爲你的 API Key\n)\n\nresp = client.chat.completions.create(\n    model=\"platform-sota\",\n    messages=[\n        {\"role\": \"system\", \"content\": \"You are a helpful assistant.\"},\n        {\"role\": \"user\",   \"content\": \"你好，請介紹一下你自己。\"},\n    ],\n)\nprint(resp.choices[0].message.content)"
      },
      {
        "title": "流式輸出",
        "language": "python",
        "code": "from openai import OpenAI\n\nclient = OpenAI(\n    base_url=\"{{API_BASE_URL}}\",\n    api_key=\"{{API_KEY}}\",\n)\n\nstream = client.chat.completions.create(\n    model=\"platform-sota\",\n    messages=[{\"role\": \"user\", \"content\": \"寫一首關於秋天的短詩。\"}],\n    stream=True,\n)\nfor chunk in stream:\n    if chunk.choices[0].delta.content:\n        print(chunk.choices[0].delta.content, end=\"\", flush=True)"
      },
      {
        "title": "工具調用",
        "language": "python",
        "code": "import json\nfrom openai import OpenAI\n\nclient = OpenAI(\n    base_url=\"{{API_BASE_URL}}\",\n    api_key=\"{{API_KEY}}\",\n)\n\ntools = [{\n    \"type\": \"function\",\n    \"function\": {\n        \"name\": \"get_weather\",\n        \"description\": \"按城市獲取當前天氣\",\n        \"parameters\": {\n            \"type\": \"object\",\n            \"properties\": {\"city\": {\"type\": \"string\"}},\n            \"required\": [\"city\"],\n        },\n    },\n}]\n\nresp = client.chat.completions.create(\n    model=\"platform-sota\",\n    messages=[{\"role\": \"user\", \"content\": \"北京今天熱嗎?\"}],\n    tools=tools,\n)\n\nmsg = resp.choices[0].message\nif msg.tool_calls:\n    for tc in msg.tool_calls:\n        print(f\"調用工具: {tc.function.name}\")\n        print(f\"參數: {tc.function.arguments}\")\nelse:\n    print(msg.content)"
      },
      {
        "title": "cURL",
        "language": "bash",
        "code": "curl {{API_BASE_URL}}/chat/completions \\\n  -H \"Authorization: Bearer $PLATFORM_API_KEY\" \\\n  -H \"Content-Type: application/json\" \\\n  -d '{\n    \"model\": \"platform-sota\",\n    \"messages\": [{\"role\":\"user\",\"content\":\"你好\"}]\n  }'"
      }
    ],
    "tips": [
      "先在管理後臺配置並驗證目標模型，再向用戶簽發可用密鑰。"
    ],
    "limitations": [
      "默認條目僅供界面演示，未配置上游時不能完成推理。"
    ]
  },
  "platform-flash": {
    "kicker": "Platform · 演示穩定別名",
    "title": "platform-flash",
    "subtitle": "由管理員配置目標模型的低延遲別名；開源演示默認不連接真實上游。",
    "badges": [
      {
        "label": "類型",
        "value": "穩定別名"
      },
      {
        "label": "側重",
        "value": "低延遲"
      },
      {
        "label": "數據",
        "value": "虛構演示"
      }
    ],
    "modelInfo": [
      {
        "label": "Model ID",
        "value": "platform-flash"
      },
      {
        "label": "Base URL",
        "value": "{{API_BASE_URL}}"
      },
      {
        "label": "API 格式",
        "value": "OpenAI 兼容"
      },
      {
        "label": "目標模型",
        "value": "由管理員配置"
      }
    ],
    "lead": "platform-flash 是用於演示低延遲路由能力的虛構別名。管理員應將它指向實際部署的快速模型，並在上線前完成連通性驗證。",
    "highlights": [
      {
        "icon": "speed",
        "title": "低延遲入口",
        "body": "可將別名綁定到部署方選擇的快速模型。"
      },
      {
        "icon": "tool",
        "title": "業務代碼穩定",
        "body": "調整目標模型時無需修改客戶端中的 Model ID。"
      },
      {
        "icon": "multi",
        "title": "統一管理",
        "body": "目標模型、端點與憑證均由管理員在後臺維護。"
      }
    ],
    "examples": [
      {
        "title": "Python SDK",
        "language": "python",
        "code": "from openai import OpenAI\n\nclient = OpenAI(\n    base_url=\"{{API_BASE_URL}}\",\n    api_key=\"{{API_KEY}}\",  # 替換爲你的 API Key\n)\n\nresp = client.chat.completions.create(\n    model=\"platform-flash\",\n    messages=[\n        {\"role\": \"system\", \"content\": \"You are a helpful assistant.\"},\n        {\"role\": \"user\",   \"content\": \"你好，請介紹一下你自己。\"},\n    ],\n)\nprint(resp.choices[0].message.content)"
      },
      {
        "title": "流式輸出",
        "language": "python",
        "code": "from openai import OpenAI\n\nclient = OpenAI(\n    base_url=\"{{API_BASE_URL}}\",\n    api_key=\"{{API_KEY}}\",\n)\n\nstream = client.chat.completions.create(\n    model=\"platform-flash\",\n    messages=[{\"role\": \"user\", \"content\": \"寫一首關於秋天的短詩。\"}],\n    stream=True,\n)\nfor chunk in stream:\n    if chunk.choices[0].delta.content:\n        print(chunk.choices[0].delta.content, end=\"\", flush=True)"
      },
      {
        "title": "工具調用",
        "language": "python",
        "code": "import json\nfrom openai import OpenAI\n\nclient = OpenAI(\n    base_url=\"{{API_BASE_URL}}\",\n    api_key=\"{{API_KEY}}\",\n)\n\ntools = [{\n    \"type\": \"function\",\n    \"function\": {\n        \"name\": \"get_weather\",\n        \"description\": \"按城市獲取當前天氣\",\n        \"parameters\": {\n            \"type\": \"object\",\n            \"properties\": {\"city\": {\"type\": \"string\"}},\n            \"required\": [\"city\"],\n        },\n    },\n}]\n\nresp = client.chat.completions.create(\n    model=\"platform-flash\",\n    messages=[{\"role\": \"user\", \"content\": \"北京今天熱嗎?\"}],\n    tools=tools,\n)\n\nmsg = resp.choices[0].message\nif msg.tool_calls:\n    for tc in msg.tool_calls:\n        print(f\"調用工具: {tc.function.name}\")\n        print(f\"參數: {tc.function.arguments}\")\nelse:\n    print(msg.content)"
      },
      {
        "title": "cURL",
        "language": "bash",
        "code": "curl {{API_BASE_URL}}/chat/completions \\\n  -H \"Authorization: Bearer $PLATFORM_API_KEY\" \\\n  -H \"Content-Type: application/json\" \\\n  -d '{\n    \"model\": \"platform-flash\",\n    \"messages\": [{\"role\":\"user\",\"content\":\"你好\"}]\n  }'"
      }
    ],
    "tips": [
      "按實際業務壓測結果選擇目標模型，不要依賴演示參數。"
    ],
    "limitations": [
      "默認條目僅供界面演示，未配置上游時不能完成推理。"
    ]
  }
};
