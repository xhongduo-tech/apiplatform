"""问题反馈社区 — 完全虚构的高频 FAQ 演示数据。

空库引导：让新用户进入答疑社区时能看到共性问题的处理范例，
减少重复提问。人物、项目、浏览量与互动量均为模拟值，不对应真实用户。
固定 id 幂等；v1 种子已存在时会增量补全回复与互动。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone

from sqlalchemy.orm import Session

from app.models import ForumPostORM, ForumReactionORM, ForumReplyORM

# 固定 id，便于幂等判定与运维排查
_SEED_MARKER_POST_ID = "seed-forum-001"

_ANON = "匿名用户"
_ADMIN_ID = "platform-admin"
_ADMIN_NAME = "平台管理员"


@dataclass(frozen=True)
class _SeedReply:
    id: str
    author_auth_id: str
    author_name: str
    is_admin: bool
    content: str
    hours_after_post: float


@dataclass(frozen=True)
class _SeedPost:
    id: str
    anon_slot: int
    days_ago: int
    view_count: int
    like_count: int
    follow_count: int
    title: str
    content: str
    replies: list[_SeedReply] = field(default_factory=list)


def _admin_reply(reply_id: str, hours: float, content: str) -> _SeedReply:
    return _SeedReply(reply_id, _ADMIN_ID, _ADMIN_NAME, True, content, hours)


def _anon_reply(reply_id: str, slot: int, hours: float, content: str) -> _SeedReply:
    return _SeedReply(reply_id, f"seed-forum-anon-{slot:02d}", _ANON, False, content, hours)


_FAQ_POSTS: list[_SeedPost] = [
    _SeedPost(
        id="seed-forum-001",
        anon_slot=1,
        days_ago=28,
        view_count=486,
        like_count=23,
        follow_count=8,
        title="API Key 怎么申请？审批要多久？",
        content=(
            "刚接触平台，想调模型但不知道 Key 从哪来。是不是注册就有？"
            "一般要等多久才能用？"
        ),
        replies=[
            _admin_reply(
                "seed-forum-reply-001",
                2.0,
                (
                    "平台 Key 需要单独申请，注册/登录账号本身不会自动下发调用凭证。\n\n"
                    "**申请路径**：登录后进入「API Keys」→「申请密钥」，填写项目名称、"
                    "业务场景和用途说明后提交。管理员审批通过后，系统会为你签发以 `sk-platform-` "
                    "开头的密钥。\n\n"
                    "**审批时效**：由部署方自行制定，请以控制台中的审批说明为准。"
                    "可在「API Keys」页查看申请状态。通过后密钥明文**仅展示一次**，"
                    "请立即复制保存。\n\n"
                    "更多细节见文档「API Keys」章节。"
                ),
            ),
            _anon_reply(
                "seed-forum-reply-001-02",
                1,
                5.5,
                "明白了，已经提交申请。审批结果会有通知吗？",
            ),
            _admin_reply(
                "seed-forum-reply-001-03",
                6.0,
                (
                    "会的。审批通过后 Key 会出现在「API Keys」列表，"
                    "驳回时也会显示管理员备注，可按说明修改后重新提交。"
                    "期间可在同一页面刷新查看状态，无需重复发帖。"
                ),
            ),
            _anon_reply(
                "seed-forum-reply-001-04",
                11,
                26.0,
                "按这个流程走，当天下午就批下来了，密钥记得第一时间保存。",
            ),
        ],
    ),
    _SeedPost(
        id="seed-forum-002",
        anon_slot=2,
        days_ago=25,
        view_count=521,
        like_count=31,
        follow_count=12,
        title="OpenAI SDK 里 base_url 和 api_key 怎么填？",
        content=(
            "Python 里用 `openai` 包，文档说改 base_url，但不确定填什么地址、"
            "要不要加 `/v1`，model 参数又填哪个？"
        ),
        replies=[
            _admin_reply(
                "seed-forum-reply-002",
                1.5,
                (
                    "平台兼容 OpenAI SDK，只需改两处环境变量或客户端构造参数：\n\n"
                    "```python\n"
                    "from openai import OpenAI\n\n"
                    "client = OpenAI(\n"
                    "    base_url=\"<控制台模型详情页复制的 Base URL>\",\n"
                    "    api_key=\"sk-platform-xxxxxxxx\",  # 你的平台密钥\n"
                    ")\n"
                    "resp = client.chat.completions.create(\n"
                    "    model=\"platform-flash\",  # 模型详情页的 Model ID\n"
                    "    messages=[{\"role\": \"user\", \"content\": \"你好\"}],\n"
                    ")\n"
                    "```\n\n"
                    "**要点**：\n"
                    "- `base_url` 从「模型广场 → 模型详情 → 快速开始」一键复制，"
                    "已包含 `/v1`，不要自行拼接。\n"
                    "- `model` 填 **Model ID**（如 `platform-flash`），不是展示名称。\n"
                    "- Key 若绑定了模型白名单，未授权模型会被拒绝。"
                ),
            ),
            _anon_reply(
                "seed-forum-reply-002-02",
                2,
                4.0,
                "按模型详情页复制 base_url 后还是 timeout，可能是什么原因？",
            ),
            _admin_reply(
                "seed-forum-reply-002-03",
                5.0,
                (
                    "请先确认：\n"
                    "1. 运行环境能访问管理员配置的网关地址；\n"
                    "2. 没有把 `base_url` 和具体 path（如 `/chat/completions`）重复拼接；\n"
                    "3. 防火墙未拦截 HTTPS 出站。\n\n"
                    "可在本机 `curl` 网关 `/v1/models` 验证连通性；"
                    "仍失败请带上 `X-Request-Id` 到调用日志排查。"
                ),
            ),
            _anon_reply(
                "seed-forum-reply-002-04",
                8,
                18.0,
                "是运行环境代理配置的问题，修正后按详情页复制的 base_url 就通了。",
            ),
        ],
    ),
    _SeedPost(
        id="seed-forum-003",
        anon_slot=3,
        days_ago=22,
        view_count=447,
        like_count=19,
        follow_count=6,
        title="调用返回 401，提示 API Key 无效",
        content=(
            "代码里 Key 明明复制了，一请求就 401 `Invalid API Key`。"
            "是格式不对还是 Key 过期了？"
        ),
        replies=[
            _admin_reply(
                "seed-forum-reply-003",
                2.0,
                (
                    "401 表示鉴权未通过，按下面顺序排查：\n\n"
                    "1. **完整复制**：Key 以 `sk-platform-` 开头，确认无多余空格、换行。\n"
                    "2. **Header 格式**：`Authorization: Bearer sk-platform-...`；"
                    "SDK 里填 `api_key=` 即可。\n"
                    "3. **密钥状态**：在「API Keys」确认未被撤销。\n"
                    "4. **环境混用**：开发/生产 Key 不要混用。\n\n"
                    "仍失败请记 `X-Request-Id` 反馈。"
                ),
            ),
            _anon_reply(
                "seed-forum-reply-003-02",
                3,
                8.0,
                "排查了一圈，发现是从网页复制时末尾带了换行，trim 一下就好了……",
            ),
            _admin_reply(
                "seed-forum-reply-003-03",
                9.0,
                "是的，这类 invisible character 很常见。建议复制后直接粘贴到纯文本编辑器检查，或用 `strip()` 处理后再写入环境变量。",
            ),
            _anon_reply(
                "seed-forum-reply-003-04",
                12,
                30.0,
                "+1，Windows 记事本复制经常带隐藏字符，踩过同款坑。",
            ),
        ],
    ),
    _SeedPost(
        id="seed-forum-004",
        anon_slot=4,
        days_ago=19,
        view_count=398,
        like_count=27,
        follow_count=9,
        title="频繁遇到 429 限流，怎么办？",
        content=(
            "跑批处理脚本时经常 429，响应里有 `retry-after`。"
            "是配额不够吗？有没有不限流的时间段？"
        ),
        replies=[
            _admin_reply(
                "seed-forum-reply-004",
                1.8,
                (
                    "429 表示触发了 **RPM** 或 **TPM** 限制。\n\n"
                    "**立即处理**：读 `retry-after` 退避重试；批量任务加指数退避。\n"
                    "**查看配额**：「用量统计」页看速率面板。\n"
                    "**批处理窗口**：若管理员启用了特殊时段策略，可按控制台提示错峰执行。\n"
                    "**长期**：可在「API Keys」申请高并发升级。"
                ),
            ),
            _anon_reply(
                "seed-forum-reply-004-02",
                4,
                6.0,
                "按控制台提示错峰并加入退避后，429 明显减少了。",
            ),
            _admin_reply(
                "seed-forum-reply-004-03",
                7.0,
                (
                    "这是常见组合：白天用默认档位扛在线请求，"
                    "大批量 embedding / 数据清洗放到管理员配置的批处理窗口。"
                    "若白天峰值仍不够，再提升级申请并附上预估 QPS。"
                ),
            ),
            _anon_reply(
                "seed-forum-reply-004-04",
                9,
                20.0,
                "补充：Python 里用 `tenacity` 做 retry 配合 `retry-after` 很省心。",
            ),
        ],
    ),
    _SeedPost(
        id="seed-forum-005",
        anon_slot=5,
        days_ago=16,
        view_count=362,
        like_count=15,
        follow_count=5,
        title="创建 Key 时没保存，还能找回明文吗？",
        content=(
            "审批通过后弹出密钥窗口，当时没复制就关了。"
            "现在还能再看到完整 Key 吗？"
        ),
        replies=[
            _admin_reply(
                "seed-forum-reply-005",
                2.5,
                (
                    "不能。平台**只在签发时展示一次明文**，库内仅存哈希，"
                    "管理员也无法还原。\n\n"
                    "**处理**：未使用则撤销后重新申请；"
                    "已上线则先签新 Key → 切流量 → 再撤旧 Key。\n"
                    "建议用团队密钥库统一保管。"
                ),
            ),
            _anon_reply(
                "seed-forum-reply-005-02",
                5,
                9.0,
                "我们组现在统一放 Vault 里，创建 Key 后值班同学立刻入库，再发给开发。",
            ),
            _admin_reply(
                "seed-forum-reply-005-03",
                10.0,
                "这是推荐做法。另外可在 Key 名称里标注用途和负责人，方便后续轮换审计。",
            ),
        ],
    ),
    _SeedPost(
        id="seed-forum-006",
        anon_slot=6,
        days_ago=13,
        view_count=334,
        like_count=22,
        follow_count=11,
        title="Claude Code / Codex CLI 怎么接入平台？",
        content=(
            "想用 Claude Code 写代码，官方文档配的是 Anthropic 地址。"
            "咱们平台能直接用吗，环境变量怎么设？"
        ),
        replies=[
            _admin_reply(
                "seed-forum-reply-006",
                2.0,
                (
                    "可以。平台兼容 **OpenAI** 与 **Anthropic** 两套协议：\n\n"
                    "**Claude Code**\n"
                    "```bash\n"
                    "export ANTHROPIC_BASE_URL=\"<网关根地址>\"\n"
                    "export ANTHROPIC_API_KEY=\"sk-platform-xxxxxxxx\"\n"
                    "```\n\n"
                    "**Codex CLI**\n"
                    "```bash\n"
                    "export OPENAI_BASE_URL=\"<控制台 Base URL>\"\n"
                    "export OPENAI_API_KEY=\"sk-platform-xxxxxxxx\"\n"
                    "```\n\n"
                    "详见文档「Agent 工具接入」。"
                ),
            ),
            _anon_reply(
                "seed-forum-reply-006-02",
                6,
                8.0,
                "Claude Code 配好后工具调用正常，model 填 platform-flash 就够用。",
            ),
            _anon_reply(
                "seed-forum-reply-006-03",
                7,
                14.0,
                "Codex 那边注意 OPENAI_BASE_URL 要带 /v1，跟模型详情页复制的一致就行。",
            ),
            _admin_reply(
                "seed-forum-reply-006-04",
                15.0,
                "没错。各工具变量名略有差异，以官方文档为准；平台侧只需保证 endpoint 与 Key 正确。遇到具体报错可贴 `X-Request-Id`。",
            ),
        ],
    ),
    _SeedPost(
        id="seed-forum-007",
        anon_slot=7,
        days_ago=10,
        view_count=289,
        like_count=18,
        follow_count=7,
        title="新手第一次调用，选哪个模型合适？",
        content=(
            "模型广场模型很多，做普通问答和写代码分别用哪个？"
            "看到有些标「抢先体验」是什么意思？"
        ),
        replies=[
            _admin_reply(
                "seed-forum-reply-007",
                1.5,
                (
                    "**日常问答 / 轻量脚本**：`platform-flash`——快、延迟低。\n"
                    "**复杂推理 / 长代码**：`platform-sota` 或管理员配置的推理模型。\n"
                    "**选型建议**：先看场景标签与上下文长度；不确定可从 `platform-flash` 起步。\n"
                    "**抢先体验**：`upcoming` 模型需在「抢先体验计划」申请，"
                    "通过后名下全部 Key 可调用。"
                ),
            ),
            _anon_reply(
                "seed-forum-reply-007-02",
                7,
                5.0,
                "示例客服机器人用快速别名即可，复杂报告生成再切高能力别名。",
            ),
            _admin_reply(
                "seed-forum-reply-007-03",
                6.0,
                "这是典型分层用法。也可在调用日志对比不同模型的延迟与 Token 消耗，再定生产默认值。",
            ),
        ],
    ),
    _SeedPost(
        id="seed-forum-008",
        anon_slot=8,
        days_ago=7,
        view_count=256,
        like_count=14,
        follow_count=4,
        title="流式输出结束后，怎么拿到 token 用量？",
        content=(
            "开了 `stream=True`，控制台打印的内容有了，但不知道消耗了多少 token，"
            "usage 字段在哪？"
        ),
        replies=[
            _admin_reply(
                "seed-forum-reply-008",
                2.0,
                (
                    "流式 **最后一帧** 会带 `usage`（`prompt_tokens` / "
                    "`completion_tokens` / `total_tokens`）。\n\n"
                    "```python\n"
                    "for chunk in stream:\n"
                    "    if chunk.usage:\n"
                    "        print(chunk.usage)\n"
                    "```\n\n"
                    "上游未返回时网关会补齐；非流式在响应体 `usage` 字段。"
                    "「调用日志」「用量统计」也可查。"
                ),
            ),
            _anon_reply(
                "seed-forum-reply-008-02",
                8,
                7.0,
                "原来在最后一个 chunk，之前一直在中间 chunk 里找 usage。",
            ),
            _admin_reply(
                "seed-forum-reply-008-03",
                8.0,
                "OpenAI SDK 新版本也支持 `stream_options={\"include_usage\": True}`，可显式要求最后一包带 usage，平台侧同样兼容。",
            ),
        ],
    ),
    _SeedPost(
        id="seed-forum-009",
        anon_slot=9,
        days_ago=4,
        view_count=218,
        like_count=11,
        follow_count=3,
        title="报错 model not found / 模型不存在",
        content=(
            "请求里 model 填了 `platform-flash`，返回 404 说找不到模型。"
            "模型广场明明能看到这个模型啊？"
        ),
        replies=[
            _admin_reply(
                "seed-forum-reply-009",
                1.5,
                (
                    "常见原因：\n"
                    "1. **Model ID 拼写**——区分大小写（`platform-flash` ≠ `platform-flash`）。\n"
                    "2. **Key 授权范围**——申请时未勾选该模型。\n"
                    "3. **模型状态**——`offline`/`maintenance` 不可调；"
                    "`upcoming` 需抢先体验。\n"
                    "4. **协议路径**——OpenAI 走 `/v1/chat/completions`，"
                    "Anthropic 走 `/v1/messages`。\n\n"
                    "调用日志可看实际路由。"
                ),
            ),
            _anon_reply(
                "seed-forum-reply-009-02",
                9,
                6.0,
                "我是 Key 白名单没勾这个模型，让管理员加了一下就好了。",
            ),
            _admin_reply(
                "seed-forum-reply-009-03",
                7.0,
                "对，403/404 里「无权调用」和「模型不存在」要分开看。"
                "可在 Key 详情确认已授权模型列表，或重新提交申请补充模型。",
            ),
        ],
    ),
    _SeedPost(
        id="seed-forum-010",
        anon_slot=10,
        days_ago=1,
        view_count=187,
        like_count=9,
        follow_count=6,
        title="怎么申请提高并发（高并发升级）？",
        content=(
            "业务要上线了，默认 RPM 不够用。看到有用量页有「升级申请」，"
            "具体怎么提、批完多久生效？"
        ),
        replies=[
            _admin_reply(
                "seed-forum-reply-010",
                2.0,
                (
                    "「高并发升级」面向确有峰值需求的 Key，"
                    "通过后提升 RPM/TPM（或无限档）。\n\n"
                    "**步骤**：「API Keys」→ 选 Key →「申请高并发升级」→ "
                    "说明场景、预期 QPS、上线时间。\n"
                    "**生效**：审批通过后立即生效，无需换 Key。\n"
                    "仅做离线批跑时，也可先确认部署方是否配置了专用批处理窗口。"
                ),
            ),
            _anon_reply(
                "seed-forum-reply-010-02",
                10,
                8.0,
                "我们上线前提交了升级，写了预估峰值和上线日期，当天就批了。",
            ),
            _admin_reply(
                "seed-forum-reply-010-03",
                9.0,
                "申请里写清业务场景和峰值预估会加快审批。"
                "批后可在用量页看到新档位与实时 RPM/TPM。",
            ),
            _anon_reply(
                "seed-forum-reply-010-04",
                11,
                22.0,
                "批完立刻生效，不用换 Key，这点挺方便。",
            ),
        ],
    ),
    _SeedPost(
        id="seed-forum-011",
        anon_slot=11,
        days_ago=27,
        view_count=312,
        like_count=17,
        follow_count=5,
        title="出错了 X-Request-Id 怎么用？调用日志在哪查？",
        content=(
            "接口报错时响应头有个 `X-Request-Id`，文档说去调用日志查，"
            "但控制台里条目太多，怎么快速定位这一条？"
        ),
        replies=[
            _admin_reply(
                "seed-forum-reply-011",
                1.5,
                (
                    "每次请求网关都会生成唯一的 `X-Request-Id`，"
                    "贯穿鉴权、路由、转发全链路。\n\n"
                    "**查日志**：「调用日志」页搜索框直接粘贴 Request ID，"
                    "或在列表里按时间 + 模型筛选后对照。\n"
                    "**反馈问题时请附上**：Request ID、发生时间、model、"
                    "HTTP 状态码及报错摘要——比截图完整响应更有用。"
                ),
            ),
            _anon_reply(
                "seed-forum-reply-011-02",
                11,
                5.0,
                "搜 Request ID 确实秒定位，比翻页快多了。",
            ),
            _admin_reply(
                "seed-forum-reply-011-03",
                6.0,
                "对。日志里还能看到路由到的上游、耗时、Token 用量，"
                "401/429/502 类问题基本都能在这一条里对齐上下文。",
            ),
        ],
    ),
    _SeedPost(
        id="seed-forum-012",
        anon_slot=12,
        days_ago=24,
        view_count=276,
        like_count=13,
        follow_count=4,
        title="502 / 503 / 504 上游错误是什么意思？",
        content=(
            "偶尔调用成功，偶尔 502 Bad Gateway 或 504 Timeout。"
            "是我代码问题还是平台挂了？需要重试吗？"
        ),
        replies=[
            _admin_reply(
                "seed-forum-reply-012",
                2.0,
                (
                    "这类状态码表示**网关收到了请求，但上游推理节点异常或超时**，"
                    "通常不是你的 Key 或参数格式问题。\n\n"
                    "**建议**：\n"
                    "1. 带退避的重试（502/503 可重试，504 视业务容忍度）；\n"
                    "2. 查「平台状态」看是否有维护/节点离线公告；\n"
                    "3. 持续出现请带 `X-Request-Id` 反馈，便于查具体上游节点。\n\n"
                    "平台对部分场景有自动兜底路由，可在调用日志看是否触发 fallback。"
                ),
            ),
            _anon_reply(
                "seed-forum-reply-012-02",
                12,
                8.0,
                "我们加了三次重试 + 指数退避，偶发 502 基本无感了。",
            ),
            _anon_reply(
                "seed-forum-reply-012-03",
                14,
                16.0,
                "504 有时是 prompt 太长或生成太久，缩短输入或调低 max_tokens 也有帮助。",
            ),
            _admin_reply(
                "seed-forum-reply-012-04",
                17.0,
                "没错。超长上下文 + 大 max_tokens 会拉高 TTFT 和总耗时，"
                "容易触发超时。可先查模型详情页的上下文上限。",
            ),
        ],
    ),
    _SeedPost(
        id="seed-forum-013",
        anon_slot=13,
        days_ago=21,
        view_count=241,
        like_count=10,
        follow_count=3,
        title="一个 API Key 可以给多个项目共用吗？",
        content=(
            "组里两三个小项目都想调模型，是各申请一个 Key 还是共用一个就行？"
            "用量能分开统计吗？"
        ),
        replies=[
            _admin_reply(
                "seed-forum-reply-013",
                2.0,
                (
                    "**可以共用**，但不推荐生产环境多项目混用一个 Key。\n\n"
                    "**推荐**：按项目/系统各申请一把 Key——"
                    "便于用量拆分、限流隔离、出问题快速撤销单项目而不影响其它业务。\n"
                    "申请时把「项目名称」写清楚，「用量统计」和「调用日志」"
                    "可按 Key / 项目维度查看。\n\n"
                    "探索性脚本临时共用一个 Key 没问题，上线前建议拆分。"
                ),
            ),
            _anon_reply(
                "seed-forum-reply-013-02",
                13,
                7.0,
                "我们按微服务拆 Key 了，哪个服务爆量一眼能看出来。",
            ),
            _admin_reply(
                "seed-forum-reply-013-03",
                8.0,
                "这是最佳实践。Key 名称和项目名保持一致，后续审计和轮换会轻松很多。",
            ),
        ],
    ),
    _SeedPost(
        id="seed-forum-014",
        anon_slot=14,
        days_ago=18,
        view_count=268,
        like_count=21,
        follow_count=8,
        title="不用 SDK，curl 怎么直接调 chat/completions？",
        content=(
            "环境不方便装 Python 包，想用 curl 先验证 Key 和模型能不能通，"
            "有最小示例吗？"
        ),
        replies=[
            _admin_reply(
                "seed-forum-reply-014",
                1.5,
                (
                    "可以，最小示例：\n\n"
                    "```bash\n"
                    "curl -s <Base URL>/chat/completions \\\n"
                    "  -H \"Authorization: Bearer sk-platform-xxxxxxxx\" \\\n"
                    "  -H \"Content-Type: application/json\" \\\n"
                    "  -d '{\n"
                    "    \"model\": \"platform-flash\",\n"
                    "    \"messages\": [{\"role\": \"user\", \"content\": \"你好\"}]\n"
                    "  }'\n"
                    "```\n\n"
                    "`<Base URL>` 从模型详情页复制（已含 `/v1`）。"
                    "流式则在 body 加 `\"stream\": true`，"
                    "响应为 SSE 格式。"
                ),
            ),
            _anon_reply(
                "seed-forum-reply-014-02",
                14,
                4.0,
                "curl 通了再配 SDK，排查快很多，建议新手都先跑一遍。",
            ),
            _admin_reply(
                "seed-forum-reply-014-03",
                5.0,
                "同意。也可 `curl <Base URL>/models` 验证鉴权与连通性，无需消耗推理算力。",
            ),
        ],
    ),
    _SeedPost(
        id="seed-forum-015",
        anon_slot=15,
        days_ago=15,
        view_count=203,
        like_count=12,
        follow_count=4,
        title="平台支持 Embedding 向量接口吗？",
        content=(
            "想做知识库检索，需要调 embedding 模型。"
            "文档里主要讲 chat，embedding 接口路径一样吗？"
        ),
        replies=[
            _admin_reply(
                "seed-forum-reply-015",
                2.0,
                (
                    "支持。已在模型广场上架的 **embedding** 类模型，"
                    "走 OpenAI 兼容的 `/v1/embeddings` 路径：\n\n"
                    "```python\n"
                    "resp = client.embeddings.create(\n"
                    "    model=\"<Embedding Model ID>\",\n"
                    "    input=[\"文本1\", \"文本2\"],\n"
                    ")\n"
                    "```\n\n"
                    "请在模型广场筛选 embedding 类别，"
                    "确认 Key 已授权对应模型。批量入库建议按管理员配置错峰执行。"
                ),
            ),
            _anon_reply(
                "seed-forum-reply-015-02",
                15,
                9.0,
                "embedding 批处理放晚上跑，白天 chat 和向量各用一把 Key，互不干扰。",
            ),
        ],
    ),
    _SeedPost(
        id="seed-forum-016",
        anon_slot=16,
        days_ago=12,
        view_count=195,
        like_count=8,
        follow_count=2,
        title="请求总是 timeout，timeout 参数能调大吗？",
        content=(
            "生成长报告经常等一半就客户端 timeout 了。"
            "是 SDK 的 timeout 设置问题还是平台有限制？"
        ),
        replies=[
            _admin_reply(
                "seed-forum-reply-016",
                1.8,
                (
                    "多数情况是**客户端 timeout 过短**，不是平台主动截断。\n\n"
                    "**OpenAI SDK**：\n"
                    "```python\n"
                    "client = OpenAI(..., timeout=120.0)  # 秒\n"
                    "```\n\n"
                    "长生成 + 流式建议 120s 以上；"
                    "流式有数据持续返回时通常不会触发 idle timeout。"
                    "若网关返回 504，则是上游推理超时，"
                    "可缩短输入、降低 max_tokens 或换更快模型。"
                ),
            ),
            _anon_reply(
                "seed-forum-reply-016-02",
                16,
                6.0,
                "把 timeout 从 30 改到 180 后长报告稳定多了。",
            ),
            _admin_reply(
                "seed-forum-reply-016-03",
                7.0,
                "另外开 `stream=True` 可以边生成边消费，"
                "用户体验更好，也不容易踩客户端总超时。",
            ),
        ],
    ),
    _SeedPost(
        id="seed-forum-017",
        anon_slot=17,
        days_ago=9,
        view_count=224,
        like_count=16,
        follow_count=6,
        title="用量统计页的数据怎么看？RPM 和 TPM 啥区别？",
        content=(
            "用量页有 Token 数、请求数，还有 RPM/TPM 进度条。"
            "不太理解这些指标分别代表什么，怎么知道自己快被限流了？"
        ),
        replies=[
            _admin_reply(
                "seed-forum-reply-017",
                2.0,
                (
                    "**Token 用量**：累计消耗的 prompt + completion tokens，"
                    "按 Key / 模型 / 时间维度汇总。\n"
                    "**RPM**（Requests Per Minute）：每分钟请求次数上限。\n"
                    "**TPM**（Tokens Per Minute）：每分钟 Token 吞吐上限。\n\n"
                    "进度条接近 100% 时下一分钟窗口内可能 429；"
                    "响应头 `x-ratelimit-remaining-*` 也可实时参考。"
                    "无限档 Key 会显示「无限」而非进度条。"
                ),
            ),
            _anon_reply(
                "seed-forum-reply-017-02",
                17,
                5.0,
                "看 remaining 比等 429 再重试体验好太多。",
            ),
            _admin_reply(
                "seed-forum-reply-017-03",
                6.0,
                "若部署方启用了不限流时段，速率面板会标注「不限流」，"
                "具体策略和时间以当前实例配置为准。",
            ),
        ],
    ),
    _SeedPost(
        id="seed-forum-018",
        anon_slot=18,
        days_ago=6,
        view_count=178,
        like_count=11,
        follow_count=5,
        title="文档页的 Ask Docs 是什么？怎么用？",
        content=(
            "看接口文档时右侧有个 Ask Docs，可以直接问问题。"
            "跟答疑社区发帖有什么区别？"
        ),
        replies=[
            _admin_reply(
                "seed-forum-reply-018",
                1.5,
                (
                    "**Ask Docs** 是基于平台文档的即时问答，"
                    "适合「接入细节 / 参数含义 / 示例代码」类问题，"
                    "秒级返回。\n\n"
                    "**答疑社区** 适合账号、审批、配额、"
                    "具体报错排查等需要人工跟进的共性问题。\n\n"
                    "Ask Docs 需登录后使用；"
                    "若答案解决不了，欢迎把问题发到社区，"
                    "附上 `X-Request-Id` 便于排查。"
                ),
            ),
            _anon_reply(
                "seed-forum-reply-018-02",
                18,
                4.0,
                "Ask Docs 查 base_url 格式很快，复杂审批流程还是来社区看帖子方便。",
            ),
        ],
    ),
    _SeedPost(
        id="seed-forum-019",
        anon_slot=19,
        days_ago=3,
        view_count=164,
        like_count=7,
        follow_count=2,
        title="Key 被撤销了，线上服务全挂了怎么办？",
        content=(
            "同事误操作把生产 Key 撤销了，所有调用 401。"
            "能恢复吗？还是要全部重新配置？"
        ),
        replies=[
            _admin_reply(
                "seed-forum-reply-019",
                1.0,
                (
                    "撤销**不可恢复**，旧 Key 永久失效——"
                    "这是安全设计，防止泄露 Key 被重新启用。\n\n"
                    "**应急**：\n"
                    "1. 立即申请/签发新 Key；\n"
                    "2. 更新各服务的 `api_key` 环境变量或配置中心；\n"
                    "3. 滚动重启或热加载配置；\n"
                    "4. 验证调用日志恢复 200 后再清理旧配置。\n\n"
                    "建议生产 Key 权限最小化，撤销操作仅负责人可执行。"
                ),
            ),
            _anon_reply(
                "seed-forum-reply-019-02",
                19,
                3.0,
                "我们改走配置中心下发 Key，换 Key 不用改代码重新发版。",
            ),
            _admin_reply(
                "seed-forum-reply-019-03",
                4.0,
                "推荐。另建议准备备用 Key 并在 runbook 里写清轮换步骤，"
                "误撤销时能按剧本快速切换。",
            ),
            _anon_reply(
                "seed-forum-reply-019-04",
                20,
                12.0,
                "踩过一次坑后我们把 Key 管理权限收紧了，只留两人能撤销。",
            ),
        ],
    ),
    _SeedPost(
        id="seed-forum-020",
        anon_slot=20,
        days_ago=2,
        view_count=142,
        like_count=6,
        follow_count=3,
        title="403 无权调用该模型，但模型广场能看到",
        content=(
            "调 `demo-reasoning-model` 返回 403，提示无权调用。"
            "模型广场明明在线，是抢先体验的问题吗？"
        ),
        replies=[
            _admin_reply(
                "seed-forum-reply-020",
                2.0,
                (
                    "403「无权调用」通常是**权限**问题，不是模型下线：\n\n"
                    "1. **Key 白名单**：申请 Key 时未勾选该模型；\n"
                    "2. **抢先体验**：模型为 `upcoming` 状态，"
                    "需先加入「抢先体验计划」；\n"
                    "3. **部门/场景限制**：部分模型有额外准入策略。\n\n"
                    "在模型详情页看状态标签；"
                    "`online` 且 Key 已授权仍 403 请带 Request ID 反馈。"
                ),
            ),
            _anon_reply(
                "seed-forum-reply-020-02",
                20,
                6.0,
                "是抢先体验模型，申请通过后第二天就能调了。",
            ),
            _admin_reply(
                "seed-forum-reply-020-03",
                7.0,
                "对。抢先体验通过后，你名下**全部** Key 自动获得权限，"
                "无需逐把 Key 配置。",
            ),
        ],
    ),
]


def _now_base(now: datetime | None = None) -> datetime:
    return (now or datetime.now(timezone.utc).replace(tzinfo=None)).replace(microsecond=0)


def _insert_post_bundle(db: Session, post: _SeedPost, base: datetime, idx: int) -> None:
    post_at = base - timedelta(days=post.days_ago, hours=10 - idx)

    if db.get(ForumPostORM, post.id) is None:
        db.add(
            ForumPostORM(
                id=post.id,
                author_auth_id=f"seed-forum-anon-{post.anon_slot:02d}",
                author_name=_ANON,
                title=post.title,
                content=post.content,
                pinned=False,
                resolved=True,
                view_count=post.view_count,
                created_at=post_at,
            )
        )
    else:
        # v1 → v2：刷新浏览量，让列表热度更自然
        existing = db.get(ForumPostORM, post.id)
        if existing and existing.view_count < post.view_count:
            existing.view_count = post.view_count

    for reply in post.replies:
        if db.get(ForumReplyORM, reply.id) is not None:
            continue
        db.add(
            ForumReplyORM(
                id=reply.id,
                post_id=post.id,
                author_auth_id=reply.author_auth_id,
                author_name=reply.author_name,
                is_admin=reply.is_admin,
                content=reply.content,
                created_at=post_at + timedelta(hours=reply.hours_after_post),
            )
        )

    _seed_reactions(db, post, post_at)


def _seed_reactions(db: Session, post: _SeedPost, post_at: datetime) -> None:
    for i in range(1, post.like_count + 1):
        rid = f"seed-forum-like-{post.anon_slot:03d}-{i:02d}"
        if db.get(ForumReactionORM, rid) is not None:
            continue
        db.add(
            ForumReactionORM(
                id=rid,
                post_id=post.id,
                user_auth_id=f"seed-user-like-{post.anon_slot:03d}-{i:02d}",
                reaction_type=ForumReactionORM.LIKE,
                created_at=post_at + timedelta(hours=3 + i * 0.4),
            )
        )

    for i in range(1, post.follow_count + 1):
        rid = f"seed-forum-follow-{post.anon_slot:03d}-{i:02d}"
        if db.get(ForumReactionORM, rid) is not None:
            continue
        db.add(
            ForumReactionORM(
                id=rid,
                post_id=post.id,
                user_auth_id=f"seed-user-follow-{post.anon_slot:03d}-{i:02d}",
                reaction_type=ForumReactionORM.FOLLOW,
                created_at=post_at + timedelta(hours=4 + i * 0.6),
            )
        )


def seed_forum_faq(db: Session, *, now: datetime | None = None) -> None:
    """插入/补全预置 FAQ（幂等，按帖增量）。"""
    base = _now_base(now)
    for idx, post in enumerate(_FAQ_POSTS):
        _insert_post_bundle(db, post, base, idx)
