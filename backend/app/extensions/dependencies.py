"""Stable FastAPI dependencies for separately packaged extensions.

Extensions should import these names from ``app.extensions`` rather than
reaching into core authentication or database internals.  Direct aliases keep
the original FastAPI dependency signatures intact.
"""
from app.auth import require_admin as require_admin
from app.auth import require_recent_admin as require_recent_admin
from app.database import get_db as get_db

__all__ = ["get_db", "require_admin", "require_recent_admin"]
