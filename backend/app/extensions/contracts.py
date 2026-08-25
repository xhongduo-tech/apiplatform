"""Public, versioned contracts for optional application extensions.

This module deliberately has no runtime dependency on ``app.main`` or
``app.config``.  Private distributions can therefore depend on this small API
surface without creating an import cycle with application construction.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from typing import TYPE_CHECKING, Awaitable, Protocol, runtime_checkable

if TYPE_CHECKING:
    from fastapi import FastAPI


EXTENSION_API_VERSION = "1"
"""Extension ABI understood by this release of the community application."""

LifecycleResult = None | Awaitable[None]


class ApplicationExtension(ABC):
    """Reference implementation of the application-extension contract.

    An extension is installed exactly once while the FastAPI application is
    being assembled.  Its startup hook runs after core dependencies are ready,
    and its shutdown hook runs before core dependencies are closed.

    Subclassing this class is recommended but not required: the loader accepts
    structurally compatible objects so separately packaged extensions are not
    coupled to a concrete base class implementation.
    """

    name: str
    api_version: str = EXTENSION_API_VERSION

    @abstractmethod
    def install(self, app: FastAPI) -> None:
        """Install routes, middleware and providers on ``app`` synchronously."""

    def startup(self, app: FastAPI) -> LifecycleResult:
        """Start extension resources; implementations may be sync or async."""
        return None

    def shutdown(self, app: FastAPI) -> LifecycleResult:
        """Release extension resources; implementations may be sync or async."""
        return None


@runtime_checkable
class Provider(Protocol):
    """Minimal protocol for a service published by an extension.

    Individual provider contracts should define their own richer Protocols and
    use ``ExtensionRegistry.require_provider(..., expected_type=...)`` at the
    consumption boundary.  ``provider_id`` is a stable, non-secret identifier
    used in diagnostics; it must not contain credentials or tenant data.
    """

    @property
    def provider_id(self) -> str:
        """Stable, non-secret identifier for diagnostics and audit metadata."""
        ...
