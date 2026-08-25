"""Add night_batch_registrations table (夜间批量调用登记处)."""
from __future__ import annotations

revision = "007_night_batch_registrations"
down_revision = "006_add_model_max_context_tokens"
branch_labels = None
depends_on = None


def upgrade() -> None:
    from app.database import Base, engine
    from app import models  # noqa: F401
    Base.metadata.create_all(bind=engine)


def downgrade() -> None:
    pass
