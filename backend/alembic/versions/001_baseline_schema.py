"""Baseline schema — idempotent create_all for fresh and upgraded deployments."""
from __future__ import annotations

revision = "001_baseline"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    from app.database import Base, engine
    from app import models  # noqa: F401
    Base.metadata.create_all(bind=engine)


def downgrade() -> None:
    pass
