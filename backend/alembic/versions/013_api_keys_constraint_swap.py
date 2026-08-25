"""安全迁移——唯一约束从 api_key 迁移至 key_hash，同时 api_key 改为可空。

背景：
  旧设计：api_key 列存明文 + NOT NULL + unique 约束/索引。库泄露即全量密钥泄露。
  新设计：api_key 列允许 NULL（旧行保留明文以兼容回退，新行为 NULL 仅存哈希）；
          key_hash 加 unique 索引，确保哈希层不发生重复。

历史数据安全：
  - 旧代码创建密钥时同步写入 api_key 明文 + key_hash 哈希，所有历史行均已
    填充 key_hash，无需数据迁移，仅变更约束。
  - 本迁移幂等：若目标状态已达成则跳过，在 partially-migrated 的库上安全复跑。

downgrade 在库中存在 api_key=NULL 的新行时拒绝回退（NOT NULL 要求会阻断），
确保不会丢失 Key 数据。
"""
from alembic import op
import sqlalchemy as sa

revision = "013_api_keys_constraint_swap"
down_revision = "012_add_request_id"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    if "api_keys" not in insp.get_table_names():
        return

    cols = {c["name"]: c for c in insp.get_columns("api_keys")}

    # 1. 删除 api_key 上的旧 unique 索引 / 约束（幂等：找不到不报错）
    if "api_key" in cols:
        indexes = insp.get_indexes("api_keys")
        for idx in indexes:
            if idx.get("unique") and "api_key" in idx.get("column_names", []):
                op.drop_index(idx["name"], table_name="api_keys")
        # 也可能以 UniqueConstraint 而非 Index 形式存在
        try:
            constraints = insp.get_unique_constraints("api_keys")
            for cst in constraints:
                if "api_key" in cst.get("column_names", []):
                    op.drop_constraint(cst["name"], "api_keys", type_="unique")
        except NotImplementedError:
            pass

    # 2. key_hash 添加 unique index（幂等：已有则跳过）
    if "key_hash" in cols:
        indexes = insp.get_indexes("api_keys")
        has_hash_unique = any(
            idx.get("unique") and "key_hash" in idx.get("column_names", [])
            for idx in indexes
        )
        if not has_hash_unique:
            op.create_index(
                "ix_api_keys_key_hash", "api_keys", ["key_hash"], unique=True,
            )

    # 3. api_key 改为可空（幂等：已可空则跳过）
    api_key_col = cols.get("api_key")
    if api_key_col and not api_key_col.get("nullable", True):
        op.alter_column("api_keys", "api_key", existing_type=sa.String(), nullable=True)


def downgrade() -> None:
    """回退：重建 api_key unique + NOT NULL，移除 key_hash unique。
    安全护栏：若已有 api_key=NULL 的行（新代码所创建），拒绝回退。
    """
    bind = op.get_bind()
    insp = sa.inspect(bind)
    if "api_keys" not in insp.get_table_names():
        return

    indexes = insp.get_indexes("api_keys")

    # 1. 移除 key_hash unique index
    for idx in indexes:
        if idx.get("unique") and "key_hash" in idx.get("column_names", []):
            op.drop_index(idx["name"], table_name="api_keys")

    # 2. 重建 api_key unique index
    cols = {c["name"]: c for c in insp.get_columns("api_keys")}
    if "api_key" in cols:
        # 刷新 index 列表
        indexes = insp.get_indexes("api_keys")
        has_api_key_unique = any(
            idx.get("unique") and "api_key" in idx.get("column_names", [])
            for idx in indexes
        )
        if not has_api_key_unique:
            op.create_index(
                "ix_api_keys_api_key", "api_keys", ["api_key"], unique=True,
            )

        # 3. 恢复 NOT NULL（安全护栏）
        api_key_col = cols["api_key"]
        if api_key_col.get("nullable", True):
            result = bind.execute(
                sa.text("SELECT COUNT(*) FROM api_keys WHERE api_key IS NULL")
            )
            null_count = result.scalar()
            if null_count and null_count > 0:
                raise RuntimeError(
                    f"无法回退：api_keys 表存在 {null_count} 行 api_key=NULL，"
                    "旧设计要求 NOT NULL。请先为这些行填入 api_key 明文后再重试。"
                )
            op.alter_column(
                "api_keys", "api_key", existing_type=sa.String(), nullable=False,
            )
