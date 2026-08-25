"""Add forum_likes and forum_follows tables."""
from __future__ import annotations

revision = "003_forum_social"
down_revision = "002_add_model_readme"
branch_labels = None
depends_on = None


def upgrade() -> None:
    from app.database import Base, engine
    from app import models  # noqa: F401
    Base.metadata.create_all(bind=engine)


def downgrade() -> None:
    pass
