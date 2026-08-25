"""结构收口：外键、查询索引、限额不变式约束、文档反馈表。

定位是「最后一次结构调整」，因此逐项都做了取舍说明——将来有人想动，先读这里。

外键只加安全子集。判据是应用现有的删除语义，而不是「关系上看起来该连就连」：
  · 密钥是软删（deleted_at），所以 usage_logs → api_keys 可以安全引用；
  · 模型是硬删（db.delete），若 usage_logs.model_id 加外键，要么挡住管理员删模型，
    要么把历史用量的模型归属抹成 NULL——两者都不可接受。用量日志里的 model_id
    是「调用当时的标签」，不是活引用，故不加；
  · 密钥可以属于尚未注册的账号（routers/user.py 的找回密码流程明确支持
    「已有密钥但从未注册过账号」并据此补建），故 api_keys.auth_id 不加外键，
    否则密钥导入与删用户都会被挡死。

CHECK 约束只加真正的不变式，不加状态枚举。status 之类的取值会随业务演进，
在「不再改结构」的前提下用 CHECK 锁死，等于把未来的取值扩展也变成一次结构变更。
而限额里 0 非法（-1=无限，>0=该值，NULL=平台默认）是写死在 normalize_rate_limit
里的语义，且 0 曾被误当成「回落默认」造成静默降速，值得在库层兜住。

全部操作幂等：已存在则跳过，可在任意历史状态的库上重复执行。
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa

revision = "017_schema_hardening"
down_revision = "016_drop_ip_wl_allowed_hours"
branch_labels = None
depends_on = None


def _insp():
    return sa.inspect(op.get_bind())


def _has_table(name: str) -> bool:
    return name in _insp().get_table_names()


def _has_fk(table: str, name: str) -> bool:
    if not _has_table(table):
        return False
    return any(fk.get("name") == name for fk in _insp().get_foreign_keys(table))


def _has_index(table: str, name: str) -> bool:
    if not _has_table(table):
        return False
    return any(ix.get("name") == name for ix in _insp().get_indexes(table))


def _has_constraint(table: str, name: str) -> bool:
    if not _has_table(table):
        return False
    bind = op.get_bind()
    return bool(bind.execute(
        sa.text("SELECT 1 FROM pg_constraint WHERE conname = :n "
                "AND conrelid = to_regclass(:t)"),
        {"n": name, "t": table},
    ).first())


# (约束名, 子表, 子列, 父表, 父列, ondelete)
_FOREIGN_KEYS = [
    # 论坛是干净的父子结构：帖子没了，它的回复/点赞/关注就该一起走，
    # 否则删帖后这些行永远悬空，计数还会把它们算进去。
    ("fk_forum_replies_post", "forum_replies", "post_id", "forum_posts", "id", "CASCADE"),
    ("fk_forum_likes_post", "forum_likes", "post_id", "forum_posts", "id", "CASCADE"),
    ("fk_forum_follows_post", "forum_follows", "post_id", "forum_posts", "id", "CASCADE"),
    # 密钥由申请单批出；申请单若被清理，密钥本身必须留着继续工作，故 SET NULL。
    ("fk_api_keys_application", "api_keys", "application_id", "applications", "id", "SET NULL"),
    # 用量日志引用密钥。密钥走软删，这条几乎不会触发；真被硬删时 SET NULL
    # 保住历史用量行，不至于连带删掉计费与审计依据。
    ("fk_usage_logs_api_key", "usage_logs", "api_key_id", "api_keys", "id", "SET NULL"),
]

# (索引名, 表, 列)  —— 均对应代码里实际的排序/过滤，不是凭空加
_INDEXES = [
    # admin.py list_audit_logs: ORDER BY created_at DESC + offset/limit
    ("ix_audit_logs_created_at", "audit_logs", ["created_at"]),
    # admin.py list_applications / list_users: ORDER BY created_at DESC
    ("ix_applications_created_at", "applications", ["created_at"]),
    ("ix_users_created_at", "users", ["created_at"]),
    # admin.py list_early_access: WHERE status = ?
    ("ix_early_access_status", "early_access_applications", ["status"]),
]


def upgrade() -> None:
    # ── 外键 ────────────────────────────────────────────────────────────────
    # 加之前先把孤儿行的引用置空，否则约束建不起来。历史库里可能存在应用层
    # 漏清理留下的悬空引用（此前全库零外键，全靠应用自觉）。
    for name, table, col, ref_table, ref_col, ondelete in _FOREIGN_KEYS:
        if not (_has_table(table) and _has_table(ref_table)):
            continue
        if _has_fk(table, name) or _has_constraint(table, name):
            continue

        if ondelete == "CASCADE":
            # 子表的悬空行直接删：父帖已不存在，这些回复/点赞本就不该被读到
            op.execute(sa.text(
                f"DELETE FROM {table} WHERE {col} IS NOT NULL "
                f"AND NOT EXISTS (SELECT 1 FROM {ref_table} p WHERE p.{ref_col} = {table}.{col})"
            ))
        else:
            op.execute(sa.text(
                f"UPDATE {table} SET {col} = NULL WHERE {col} IS NOT NULL "
                f"AND NOT EXISTS (SELECT 1 FROM {ref_table} p WHERE p.{ref_col} = {table}.{col})"
            ))

        op.create_foreign_key(name, table, ref_table, [col], [ref_col], ondelete=ondelete)

    # ── 查询索引 ────────────────────────────────────────────────────────────
    for name, table, cols in _INDEXES:
        if _has_table(table) and not _has_index(table, name):
            op.create_index(name, table, cols)

    # ── 限额不变式：0 非法 ──────────────────────────────────────────────────
    if _has_table("api_keys"):
        # 先修正历史脏值：0 的本意几乎都是"不限"，但落到策略层会被当成平台默认，
        # 与调用方预期相反。统一改成 NULL（回落平台默认），语义明确且不会静默降速。
        op.execute(sa.text("UPDATE api_keys SET rpm_limit = NULL WHERE rpm_limit = 0"))
        op.execute(sa.text("UPDATE api_keys SET tpm_limit = NULL WHERE tpm_limit = 0"))
        if not _has_constraint("api_keys", "ck_api_keys_rpm_limit_nonzero"):
            op.create_check_constraint(
                "ck_api_keys_rpm_limit_nonzero", "api_keys",
                "rpm_limit IS NULL OR rpm_limit <> 0",
            )
        if not _has_constraint("api_keys", "ck_api_keys_tpm_limit_nonzero"):
            op.create_check_constraint(
                "ck_api_keys_tpm_limit_nonzero", "api_keys",
                "tpm_limit IS NULL OR tpm_limit <> 0",
            )

    # ── 文档反馈落库 ────────────────────────────────────────────────────────
    if not _has_table("doc_feedback"):
        op.create_table(
            "doc_feedback",
            sa.Column("id", sa.String(), primary_key=True),
            sa.Column("section", sa.String(), nullable=True),
            sa.Column("vote", sa.String(), nullable=False),
            sa.Column("comment", sa.Text(), nullable=True),
            sa.Column("auth_id", sa.String(), nullable=True),
            sa.Column("lang", sa.String(), nullable=True),
            sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
        )
        op.create_index("ix_doc_feedback_section", "doc_feedback", ["section"])
        op.create_index("ix_doc_feedback_auth_id", "doc_feedback", ["auth_id"])
        op.create_index("ix_doc_feedback_created_at", "doc_feedback", ["created_at"])


def downgrade() -> None:
    if _has_table("doc_feedback"):
        op.drop_table("doc_feedback")

    for cname in ("ck_api_keys_rpm_limit_nonzero", "ck_api_keys_tpm_limit_nonzero"):
        if _has_constraint("api_keys", cname):
            op.drop_constraint(cname, "api_keys", type_="check")

    for name, table, _cols in _INDEXES:
        if _has_index(table, name):
            op.drop_index(name, table_name=table)

    for name, table, _c, _rt, _rc, _od in _FOREIGN_KEYS:
        if _has_fk(table, name):
            op.drop_constraint(name, table, type_="foreignkey")
