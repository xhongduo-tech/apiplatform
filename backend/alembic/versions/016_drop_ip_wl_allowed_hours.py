"""删除 api_keys.ip_whitelist / allowed_hours（改由限流档位与夜间窗口覆盖）。

与 008/009/011 同样带存在性判断：001 基线已按当前模型形状重写，不再创建这两列，
全新库跑到这里时它们根本不存在。无条件 drop_column 会让 `alembic upgrade head`
整条链失败，而 entrypoint.sh 是 `set -e`——后端容器起不来，nginx 又是
`depends_on: backend: condition: service_healthy`，于是 nginx 也不启动，
最终表现为「整站打不开」，从现象完全看不出根因在一条迁移上。

老库（曾按旧基线升级到 015）确实有这两列，判断为真照常删除，行为不变。

revision id 另有一处硬约束：alembic_version.version_num 是 varchar(32)，
原 id "016_drop_ip_whitelist_allowed_hours" 长 35 字符，写版本号时必然
StringDataRightTruncation。因此缩短为 28 字符。改名安全——该 id 从未
成功落库过（正因为写不进去），不存在已 stamp 的库需要兼容。
新增迁移时请把 revision id 控制在 32 字符以内。
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa

revision = "016_drop_ip_wl_allowed_hours"
down_revision = "015_ask_docs_config"
branch_labels = None
depends_on = None

_COLUMNS = ("ip_whitelist", "allowed_hours")


def _existing_columns() -> set[str]:
    insp = sa.inspect(op.get_bind())
    return {c["name"] for c in insp.get_columns("api_keys")}


def upgrade() -> None:
    present = _existing_columns()
    for col in _COLUMNS:
        if col in present:
            op.drop_column("api_keys", col)


def downgrade() -> None:
    present = _existing_columns()
    if "allowed_hours" not in present:
        op.add_column("api_keys", sa.Column("allowed_hours", sa.String(), nullable=True))
    if "ip_whitelist" not in present:
        op.add_column("api_keys", sa.Column("ip_whitelist", sa.JSON(), nullable=True))
