"""Stable public API for optional open-source and commercial extensions."""
from app.extensions.contracts import (
    EXTENSION_API_VERSION,
    ApplicationExtension,
    LifecycleResult,
    Provider,
)
from app.extensions.dependencies import get_db, require_admin, require_recent_admin
from app.extensions.manager import (
    ExtensionConfigurationError,
    ExtensionError,
    ExtensionLifecycleError,
    ExtensionLoadError,
    ExtensionManager,
    ExtensionSpec,
    InstalledExtension,
    parse_extension_specs,
)
from app.extensions.registry import (
    ExtensionRegistry,
    ProviderNotFoundError,
    ProviderRegistrationError,
    get_extension_registry,
)

__all__ = [
    "EXTENSION_API_VERSION",
    "ApplicationExtension",
    "ExtensionConfigurationError",
    "ExtensionError",
    "ExtensionLifecycleError",
    "ExtensionLoadError",
    "ExtensionManager",
    "ExtensionRegistry",
    "ExtensionSpec",
    "InstalledExtension",
    "LifecycleResult",
    "Provider",
    "ProviderNotFoundError",
    "ProviderRegistrationError",
    "get_db",
    "get_extension_registry",
    "parse_extension_specs",
    "require_admin",
    "require_recent_admin",
]
