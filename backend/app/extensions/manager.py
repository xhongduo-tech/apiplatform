"""Deterministic, fail-closed loading and lifecycle management for extensions."""
from __future__ import annotations

import importlib
import inspect
import logging
import re
from dataclasses import dataclass
from types import ModuleType
from typing import TYPE_CHECKING, Any

from app.extensions.contracts import EXTENSION_API_VERSION
from app.extensions.registry import ExtensionRegistry

if TYPE_CHECKING:
    from fastapi import FastAPI


log = logging.getLogger("apiplatform.extensions")

_MODULE_RE = re.compile(r"^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$")
_ATTRIBUTE_RE = re.compile(r"^[A-Za-z_]\w*$")


class ExtensionError(RuntimeError):
    """Base class for extension configuration, loading and lifecycle failures."""


class ExtensionConfigurationError(ExtensionError):
    """The configured extension list or an exported contract is invalid."""


class ExtensionLoadError(ExtensionError):
    """An extension could not be imported or installed."""


class ExtensionLifecycleError(ExtensionError):
    """An extension startup or shutdown hook failed."""


@dataclass(frozen=True, slots=True)
class ExtensionSpec:
    module: str
    attribute: str = "extension"

    @property
    def display_name(self) -> str:
        return f"{self.module}:{self.attribute}"


@dataclass(frozen=True, slots=True)
class InstalledExtension:
    name: str
    module: str
    attribute: str


class ExtensionManager:
    """Own installation and lifecycle state for one FastAPI application."""

    def __init__(self) -> None:
        self.registry = ExtensionRegistry()
        self._extensions: list[Any] = []
        self._installed: list[InstalledExtension] = []
        self._started: list[Any] = []
        self._installation_attempted = False
        self._active = False

    @property
    def installed_extensions(self) -> tuple[InstalledExtension, ...]:
        return tuple(self._installed)

    def install_configured(self, app: FastAPI, configuration: str) -> None:
        """Load and synchronously install the explicitly configured extensions.

        All modules and contracts are validated before the first ``install``
        call.  Any error is raised to the application factory, so a configured
        but broken extension can never result in a partially enabled production
        service.
        """
        if self._installation_attempted:
            raise ExtensionConfigurationError("extensions have already been installed")
        self._installation_attempted = True
        app.state.extension_registry = self.registry

        specs = parse_extension_specs(configuration)
        loaded = [(spec, _load_extension(spec)) for spec in specs]
        _validate_unique_names(loaded)

        for spec, extension in loaded:
            try:
                result = extension.install(app)
            except Exception as exc:
                raise ExtensionLoadError(
                    f"extension {extension.name!r} install failed"
                ) from exc
            if inspect.isawaitable(result):
                if inspect.iscoroutine(result):
                    result.close()
                raise ExtensionConfigurationError(
                    f"extension {extension.name!r} install must be synchronous"
                )
            if result is not None:
                raise ExtensionConfigurationError(
                    f"extension {extension.name!r} install must return None"
                )
            self._extensions.append(extension)
            self._installed.append(
                InstalledExtension(extension.name, spec.module, spec.attribute)
            )
            log.info("installed application extension %s", extension.name)

    async def startup(self, app: FastAPI) -> None:
        """Start extensions in installation order, unwinding on any failure."""
        if not self._installation_attempted:
            raise ExtensionConfigurationError("extensions must be installed before startup")
        if self._active:
            raise ExtensionLifecycleError("extensions are already started")
        self._active = True

        for extension in self._extensions:
            try:
                await _call_lifecycle(extension.startup, app)
            except Exception as exc:
                await self._cleanup_failed_startup(extension, app)
                raise ExtensionLifecycleError(
                    f"extension {extension.name!r} startup failed"
                ) from exc
            self._started.append(extension)
            log.info("started application extension %s", extension.name)

    async def shutdown(self, app: FastAPI) -> None:
        """Stop started extensions in reverse order and report all failures."""
        if not self._active:
            return
        self._active = False
        failures = await self._shutdown_started(app)
        if failures:
            names = ", ".join(failures)
            raise ExtensionLifecycleError(f"extension shutdown failed: {names}")

    async def _cleanup_failed_startup(self, failed: Any, app: FastAPI) -> None:
        try:
            await _call_lifecycle(failed.shutdown, app)
        except Exception:
            log.exception("failed to clean up extension %s after startup error", failed.name)
        await self._shutdown_started(app)
        self._active = False

    async def _shutdown_started(self, app: FastAPI) -> list[str]:
        failures: list[str] = []
        while self._started:
            extension = self._started.pop()
            try:
                await _call_lifecycle(extension.shutdown, app)
            except Exception:
                failures.append(extension.name)
                log.exception("failed to stop application extension %s", extension.name)
            else:
                log.info("stopped application extension %s", extension.name)
        return failures


def parse_extension_specs(configuration: str) -> tuple[ExtensionSpec, ...]:
    """Parse ``module[:attribute]`` entries without silently dropping mistakes."""
    raw = str(configuration or "").strip()
    if not raw:
        return ()
    entries = raw.split(",")
    if any(not entry.strip() for entry in entries):
        raise ExtensionConfigurationError("APPLICATION_EXTENSIONS contains an empty entry")

    specs: list[ExtensionSpec] = []
    for entry in entries:
        token = entry.strip()
        if token.count(":") > 1:
            raise ExtensionConfigurationError(f"invalid extension entry: {token!r}")
        module, separator, attribute = token.partition(":")
        module = module.strip()
        attribute = attribute.strip() if separator else "extension"
        if not _MODULE_RE.fullmatch(module) or not _ATTRIBUTE_RE.fullmatch(attribute):
            raise ExtensionConfigurationError(f"invalid extension entry: {token!r}")
        specs.append(ExtensionSpec(module=module, attribute=attribute))
    return tuple(specs)


def _load_extension(spec: ExtensionSpec) -> Any:
    try:
        module = importlib.import_module(spec.module)
    except Exception as exc:
        raise ExtensionLoadError(f"could not import extension {spec.display_name}") from exc
    extension = _module_attribute(module, spec)
    _validate_extension_contract(extension, spec)
    return extension


def _module_attribute(module: ModuleType, spec: ExtensionSpec) -> Any:
    try:
        return getattr(module, spec.attribute)
    except AttributeError as exc:
        raise ExtensionLoadError(
            f"extension export not found: {spec.display_name}"
        ) from exc


def _validate_extension_contract(extension: Any, spec: ExtensionSpec) -> None:
    if inspect.isclass(extension):
        raise ExtensionConfigurationError(
            f"extension export must be an object, not a class: {spec.display_name}"
        )
    name = getattr(extension, "name", None)
    if not isinstance(name, str) or not name.strip() or name != name.strip():
        raise ExtensionConfigurationError(
            f"extension {spec.display_name} must have a non-empty normalized name"
        )
    version = getattr(extension, "api_version", None)
    if version != EXTENSION_API_VERSION:
        raise ExtensionConfigurationError(
            f"extension {name!r} requires API {version!r}; core supports "
            f"{EXTENSION_API_VERSION!r}"
        )
    for hook in ("install", "startup", "shutdown"):
        if not callable(getattr(extension, hook, None)):
            raise ExtensionConfigurationError(
                f"extension {name!r} must define callable {hook}(app)"
            )


def _validate_unique_names(loaded: list[tuple[ExtensionSpec, Any]]) -> None:
    names: set[str] = set()
    for _spec, extension in loaded:
        if extension.name in names:
            raise ExtensionConfigurationError(
                f"duplicate application extension name: {extension.name!r}"
            )
        names.add(extension.name)


async def _call_lifecycle(hook: Any, app: FastAPI) -> None:
    result = hook(app)
    if inspect.isawaitable(result):
        await result
    elif result is not None:
        raise TypeError("extension lifecycle hooks must return None or an awaitable")
