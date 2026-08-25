"""合并 fallback_policy / ask_docs_config 为通用 platform_settings（key → JSON）。

两张旧表都是"单行、admin 可编辑、一堆开关+参数"的配置表；以后再新增同类
平台级开关，不必再新建 ORM 类 + 迁移，直接在 platform_settings 里插一行。

幂等 + 兼容存量数据：旧表若存在（且有数据）先把内容搬进新表对应 key，
再删旧表。字段级类型校验交由 app/platform_settings.py 的 dataclass 负责。
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect

revision = "032_platform_settings"
down_revision = "031_forum_reactions"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = inspect(bind)
    tables = set(inspector.get_table_names())

    if "platform_settings" not in tables:
        op.create_table(
            "platform_settings",
            sa.Column("key", sa.String(64), primary_key=True),
            sa.Column("value", sa.JSON(), nullable=False, server_default="{}"),
            sa.Column("created_at", sa.DateTime(), server_default=sa.func.now()),
            sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now()),
        )

    if "fallback_policy" in tables:
        op.execute(sa.text("""
            INSERT INTO platform_settings (key, value, created_at, updated_at)
            SELECT 'fallback_policy',
                   jsonb_build_object(
                       'enabled', enabled,
                       'target_model_id', target_model_id,
                       'source_model_ids', COALESCE(source_model_ids::jsonb, '[]'::jsonb),
                       'trip_fails', trip_fails,
                       'trip_rate', trip_rate,
                       'window_s', window_s,
                       'cooldown_s', cooldown_s,
                       'max_cooldown_s', max_cooldown_s,
                       'circuit_enabled', circuit_enabled,
                       'forced', forced
                   )::json,
                   now(), COALESCE(updated_at, now())
            FROM fallback_policy
            WHERE id = 'default'
            ON CONFLICT (key) DO NOTHING
        """))
        op.drop_table("fallback_policy")

    if "ask_docs_config" in tables:
        op.execute(sa.text("""
            INSERT INTO platform_settings (key, value, created_at, updated_at)
            SELECT 'ask_docs_config',
                   jsonb_build_object(
                       'id', id,
                       'provider', provider,
                       'model', model,
                       'api_base', api_base,
                       'api_key', api_key,
                       'system_prompt', system_prompt,
                       'max_tokens', max_tokens,
                       'temperature', temperature,
                       'enabled', enabled
                   )::json,
                   COALESCE(created_at, now()), COALESCE(updated_at, now())
            FROM ask_docs_config
            ORDER BY created_at ASC NULLS LAST
            LIMIT 1
            ON CONFLICT (key) DO NOTHING
        """))
        op.drop_table("ask_docs_config")


def downgrade() -> None:
    bind = op.get_bind()
    inspector = inspect(bind)
    tables = set(inspector.get_table_names())
    if "platform_settings" not in tables:
        return

    if "fallback_policy" not in tables:
        op.create_table(
            "fallback_policy",
            sa.Column("id", sa.String(), primary_key=True, server_default="default"),
            sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.false()),
            sa.Column("target_model_id", sa.String(), nullable=True),
            sa.Column("source_model_ids", sa.JSON(), nullable=False, server_default="[]"),
            sa.Column("trip_fails", sa.Integer(), nullable=False, server_default="5"),
            sa.Column("trip_rate", sa.Float(), nullable=False, server_default="0.5"),
            sa.Column("window_s", sa.Integer(), nullable=False, server_default="60"),
            sa.Column("cooldown_s", sa.Integer(), nullable=False, server_default="120"),
            sa.Column("max_cooldown_s", sa.Integer(), nullable=False, server_default="1800"),
            sa.Column("circuit_enabled", sa.Boolean(), nullable=False, server_default=sa.false()),
            sa.Column("forced", sa.Boolean(), nullable=False, server_default=sa.false()),
            sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now()),
        )
        op.execute(sa.text("""
            INSERT INTO fallback_policy (
                id, enabled, target_model_id, source_model_ids, trip_fails, trip_rate,
                window_s, cooldown_s, max_cooldown_s, circuit_enabled, forced, updated_at
            )
            SELECT 'default',
                   COALESCE((value->>'enabled')::boolean, false),
                   value->>'target_model_id',
                   COALESCE(value->'source_model_ids', '[]'::json),
                   COALESCE((value->>'trip_fails')::int, 5),
                   COALESCE((value->>'trip_rate')::float, 0.5),
                   COALESCE((value->>'window_s')::int, 60),
                   COALESCE((value->>'cooldown_s')::int, 120),
                   COALESCE((value->>'max_cooldown_s')::int, 1800),
                   COALESCE((value->>'circuit_enabled')::boolean, false),
                   COALESCE((value->>'forced')::boolean, false),
                   updated_at
            FROM platform_settings WHERE key = 'fallback_policy'
        """))

    if "ask_docs_config" not in tables:
        op.create_table(
            "ask_docs_config",
            sa.Column("id", sa.String(), primary_key=True),
            sa.Column("provider", sa.String(), nullable=False, server_default="openai"),
            sa.Column("model", sa.String(), nullable=False, server_default="gpt-4o"),
            sa.Column("api_base", sa.String(), nullable=True),
            sa.Column("api_key", sa.String(), nullable=True),
            sa.Column("system_prompt", sa.Text(), nullable=True),
            sa.Column("max_tokens", sa.Integer(), nullable=False, server_default="4096"),
            sa.Column("temperature", sa.Float(), nullable=False, server_default="0.3"),
            sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.text("false")),
            sa.Column("created_at", sa.DateTime(), server_default=sa.func.now()),
            sa.Column("updated_at", sa.DateTime(), server_default=sa.func.now()),
        )
        op.execute(sa.text("""
            INSERT INTO ask_docs_config (
                id, provider, model, api_base, api_key, system_prompt,
                max_tokens, temperature, enabled, created_at, updated_at
            )
            SELECT value->>'id',
                   COALESCE(value->>'provider', 'openai'),
                   COALESCE(value->>'model', 'gpt-4o'),
                   value->>'api_base',
                   value->>'api_key',
                   value->>'system_prompt',
                   COALESCE((value->>'max_tokens')::int, 4096),
                   COALESCE((value->>'temperature')::float, 0.3),
                   COALESCE((value->>'enabled')::boolean, false),
                   created_at, updated_at
            FROM platform_settings WHERE key = 'ask_docs_config'
        """))

    op.execute(sa.text(
        "DELETE FROM platform_settings WHERE key IN ('fallback_policy', 'ask_docs_config')"
    ))
    remaining = bind.execute(sa.text("SELECT COUNT(*) FROM platform_settings")).scalar()
    if not remaining:
        op.drop_table("platform_settings")
