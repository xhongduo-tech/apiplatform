"""安全、可重复的演示数据。

本模块只在数据库没有任何用户和 API Key 时写入数据，绝不会覆盖或混入运行期
数据。所有人物、部门、项目、统计值均为虚构；演示 Key 没有可用的明文或哈希，
并且一律处于已撤销状态，因此不能用于调用上游模型。
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import (
    ApiKeyORM,
    NotificationORM,
    PlatformSettingORM,
    UsageDailySummaryORM,
    UsageHourlySummaryORM,
    UserORM,
)

log = logging.getLogger("platform.demo_seed")

DEMO_SEED_KEY = "demo_seed"
DEMO_SEED_VERSION = 1


@dataclass(frozen=True)
class DemoUser:
    id: str
    auth_id: str
    name: str
    department: str


_USERS = (
    DemoUser("demo-user-001", "demo-001", "演示用户一", "示例团队甲"),
    DemoUser("demo-user-002", "demo-002", "演示用户二", "示例团队乙"),
    DemoUser("demo-user-003", "demo-003", "演示用户三", "示例团队丙"),
)

_KEYS = (
    ("demo-key-001", "demo-001", "智能问答演示", "示例项目甲", "示例团队甲", "innovation"),
    ("demo-key-002", "demo-002", "代码助手演示", "示例项目乙", "示例团队乙", "dept_explore"),
    ("demo-key-003", "demo-003", "文档分析演示", "示例项目丙", "示例团队丙", "explore"),
)

_MODELS = ("platform-flash", "platform-sota", "demo-embedding-model")


def _database_has_runtime_data(db: Session) -> bool:
    users = db.scalar(select(func.count()).select_from(UserORM)) or 0
    keys = db.scalar(select(func.count()).select_from(ApiKeyORM)) or 0
    return bool(users or keys)


def seed_demo_data(db: Session) -> bool:
    """向全新数据库写入虚构数据；写入返回 True，跳过返回 False。

    调用方负责 commit。以 users/api_keys 作为安全边界：任一表已有记录就整批跳过，
    防止演示数据进入真实实例。
    """
    marker = db.get(PlatformSettingORM, DEMO_SEED_KEY)
    if marker is not None:
        return False
    if _database_has_runtime_data(db):
        log.info("数据库已有用户或 API Key，跳过演示数据")
        return False

    now = datetime.now(timezone.utc).replace(tzinfo=None)
    for user in _USERS:
        db.add(
            UserORM(
                id=user.id,
                auth_id=user.auth_id,
                name=user.name,
                department=user.department,
                # 演示账号仅用于看板聚合，不预置任何可登录的共享密码。
                password_hash=None,
                created_at=now - timedelta(days=45),
            )
        )

    for idx, (key_id, auth_id, name, project, department, scene) in enumerate(_KEYS):
        db.add(
            ApiKeyORM(
                id=key_id,
                name=name,
                auth_id=auth_id,
                project_name=project,
                project_desc="仅用于开源演示的虚构项目，不对应任何真实业务。",
                department=department,
                scene_type=scene,
                models=[],
                api_key=None,
                key_hash=None,
                key_prefix="demo-disabled-",
                granted_at=now - timedelta(days=40 - idx * 3),
                revoked=True,
                revoked_at=now - timedelta(days=1),
            )
        )

    # 生成 30 天稳定但非规则递增的汇总，足以驱动首页与管理看板的图表。
    today = date.today()
    for day_offset in range(30):
        day = today - timedelta(days=29 - day_offset)
        for key_idx, key in enumerate(_KEYS):
            for model_idx, model_id in enumerate(_MODELS):
                calls = 12 + ((day_offset * 7 + key_idx * 11 + model_idx * 5) % 43)
                prompt = calls * (180 + key_idx * 45 + model_idx * 70)
                completion = calls * (95 + key_idx * 25 + model_idx * 40)
                db.add(
                    UsageDailySummaryORM(
                        day=day,
                        api_key_id=key[0],
                        model_id=model_id,
                        calls=calls,
                        prompt_tokens=prompt,
                        completion_tokens=completion,
                        total_tokens=prompt + completion,
                        cache_hit_tokens=(prompt // 8 if model_idx == 0 else 0),
                    )
                )
            for hour in (9, 10, 14, 16, 20):
                db.add(
                    UsageHourlySummaryORM(
                        day=day,
                        hour=hour,
                        api_key_id=key[0],
                        calls=2 + ((day_offset + key_idx + hour) % 9),
                    )
                )

    db.add(
        NotificationORM(
            id="demo-notification-001",
            type="info",
            title="欢迎使用演示环境",
            body="当前看板中的用户、项目与用量均为系统生成的虚构数据。",
        )
    )
    db.add(
        PlatformSettingORM(
            key=DEMO_SEED_KEY,
            value={
                "version": DEMO_SEED_VERSION,
                "synthetic": True,
                "generated_at": now.isoformat() + "Z",
            },
        )
    )
    db.flush()
    log.info("已写入安全演示数据：users=%s keys=%s days=30", len(_USERS), len(_KEYS))
    return True


def main() -> None:
    from app.database import SessionLocal

    with SessionLocal() as db:
        changed = seed_demo_data(db)
        db.commit()
    print("演示数据已写入" if changed else "已有数据或已写入过演示数据，跳过")


if __name__ == "__main__":
    main()
