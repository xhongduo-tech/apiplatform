"""Versioned application extension loading, providers and lifecycle ordering."""
from __future__ import annotations

import sys
from types import ModuleType
from typing import Protocol, runtime_checkable

import pytest
from fastapi import FastAPI

from app.extensions import (
    EXTENSION_API_VERSION,
    ExtensionConfigurationError,
    ExtensionLifecycleError,
    ExtensionLoadError,
    ExtensionManager,
    ExtensionRegistry,
    ExtensionSpec,
    ProviderNotFoundError,
    ProviderRegistrationError,
    get_extension_registry,
    parse_extension_specs,
)


class _Extension:
    api_version = EXTENSION_API_VERSION

    def __init__(self, name: str, calls: list[str], *, asynchronous: bool = False):
        self.name = name
        self.calls = calls
        self.asynchronous = asynchronous

    def install(self, app: FastAPI) -> None:
        assert get_extension_registry(app)
        self.calls.append(f"install:{self.name}")

    def startup(self, _app: FastAPI):
        if not self.asynchronous:
            self.calls.append(f"startup:{self.name}")
            return None

        async def run() -> None:
            self.calls.append(f"startup:{self.name}")

        return run()

    def shutdown(self, _app: FastAPI):
        if not self.asynchronous:
            self.calls.append(f"shutdown:{self.name}")
            return None

        async def run() -> None:
            self.calls.append(f"shutdown:{self.name}")

        return run()


def _publish(monkeypatch: pytest.MonkeyPatch, module_name: str, **exports: object) -> None:
    module = ModuleType(module_name)
    for name, value in exports.items():
        setattr(module, name, value)
    monkeypatch.setitem(sys.modules, module_name, module)


def test_parse_extension_specs_preserves_declared_order() -> None:
    assert parse_extension_specs("vendor.alpha, vendor.beta:application_extension") == (
        ExtensionSpec("vendor.alpha", "extension"),
        ExtensionSpec("vendor.beta", "application_extension"),
    )


@pytest.mark.parametrize("value", ["vendor.ok,", ",vendor.ok", "vendor..bad", "a:b:c"])
def test_invalid_extension_configuration_is_rejected(value: str) -> None:
    with pytest.raises(ExtensionConfigurationError):
        parse_extension_specs(value)


@pytest.mark.asyncio
async def test_install_startup_and_reverse_shutdown_order(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[str] = []
    _publish(monkeypatch, "vendor_alpha", extension=_Extension("alpha", calls))
    _publish(
        monkeypatch,
        "vendor_beta",
        application_extension=_Extension("beta", calls, asynchronous=True),
    )
    app = FastAPI()
    manager = ExtensionManager()

    manager.install_configured(
        app,
        "vendor_alpha,vendor_beta:application_extension",
    )
    await manager.startup(app)
    await manager.shutdown(app)

    assert calls == [
        "install:alpha",
        "install:beta",
        "startup:alpha",
        "startup:beta",
        "shutdown:beta",
        "shutdown:alpha",
    ]
    assert [item.name for item in manager.installed_extensions] == ["alpha", "beta"]


@pytest.mark.asyncio
async def test_empty_configuration_keeps_default_application_behavior() -> None:
    app = FastAPI()
    manager = ExtensionManager()

    manager.install_configured(app, "")
    await manager.startup(app)
    await manager.shutdown(app)
    # A clean lifespan may be entered again by test clients or a development server.
    await manager.startup(app)
    await manager.shutdown(app)

    assert manager.installed_extensions == ()
    assert get_extension_registry(app).contracts == ()


def test_all_contracts_are_validated_before_any_install(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[str] = []
    valid = _Extension("valid", calls)
    invalid = _Extension("invalid", calls)
    invalid.api_version = "999"
    _publish(monkeypatch, "vendor_valid", extension=valid)
    _publish(monkeypatch, "vendor_invalid", extension=invalid)

    with pytest.raises(ExtensionConfigurationError, match="core supports"):
        ExtensionManager().install_configured(
            FastAPI(),
            "vendor_valid,vendor_invalid",
        )

    assert calls == []


def test_duplicate_extension_names_are_rejected_before_install(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[str] = []
    _publish(monkeypatch, "vendor_one", extension=_Extension("same", calls))
    _publish(monkeypatch, "vendor_two", extension=_Extension("same", calls))

    with pytest.raises(ExtensionConfigurationError, match="duplicate"):
        ExtensionManager().install_configured(FastAPI(), "vendor_one,vendor_two")

    assert calls == []


def test_explicit_missing_extension_fails_closed() -> None:
    with pytest.raises(ExtensionLoadError, match="could not import"):
        ExtensionManager().install_configured(
            FastAPI(),
            "package_that_does_not_exist_for_extension_test",
        )


def test_install_failure_stops_following_extensions(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[str] = []

    class Broken(_Extension):
        def install(self, _app: FastAPI) -> None:
            calls.append("install:broken")
            raise ValueError("broken")

    _publish(monkeypatch, "vendor_broken", extension=Broken("broken", calls))
    _publish(monkeypatch, "vendor_later", extension=_Extension("later", calls))

    with pytest.raises(ExtensionLoadError, match="install failed"):
        ExtensionManager().install_configured(
            FastAPI(),
            "vendor_broken,vendor_later",
        )

    assert calls == ["install:broken"]


def test_async_install_is_rejected_without_running_coroutine(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[str] = []

    class AsyncInstall(_Extension):
        async def install(self, _app: FastAPI) -> None:
            calls.append("async-install-body")

    _publish(monkeypatch, "vendor_async_install", extension=AsyncInstall("async", calls))

    with pytest.raises(ExtensionConfigurationError, match="must be synchronous"):
        ExtensionManager().install_configured(FastAPI(), "vendor_async_install")

    assert calls == []


@pytest.mark.asyncio
async def test_startup_failure_cleans_failed_and_started_extensions(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[str] = []

    class Broken(_Extension):
        async def startup(self, _app: FastAPI) -> None:
            calls.append("startup:broken")
            raise ValueError("broken")

    _publish(monkeypatch, "vendor_started", extension=_Extension("started", calls))
    _publish(monkeypatch, "vendor_broken_startup", extension=Broken("broken", calls))
    manager = ExtensionManager()
    app = FastAPI()
    manager.install_configured(app, "vendor_started,vendor_broken_startup")

    with pytest.raises(ExtensionLifecycleError, match="startup failed"):
        await manager.startup(app)

    assert calls[-4:] == [
        "startup:started",
        "startup:broken",
        "shutdown:broken",
        "shutdown:started",
    ]
    # Failure cleanup is idempotent when the application lifespan enters finally.
    await manager.shutdown(app)


@pytest.mark.asyncio
async def test_shutdown_failure_does_not_skip_other_extensions(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[str] = []

    class Broken(_Extension):
        def shutdown(self, _app: FastAPI) -> None:
            calls.append("shutdown:broken")
            raise ValueError("broken")

    _publish(monkeypatch, "vendor_first", extension=_Extension("first", calls))
    _publish(monkeypatch, "vendor_broken_stop", extension=Broken("broken", calls))
    manager = ExtensionManager()
    app = FastAPI()
    manager.install_configured(app, "vendor_first,vendor_broken_stop")
    await manager.startup(app)

    with pytest.raises(ExtensionLifecycleError, match="broken"):
        await manager.shutdown(app)

    assert calls[-2:] == ["shutdown:broken", "shutdown:first"]


def test_provider_registry_is_first_writer_wins_and_typed() -> None:
    @runtime_checkable
    class Greeter(Protocol):
        provider_id: str

        def greet(self) -> str: ...

    class GreetingProvider:
        provider_id = "example.greeter"

        def greet(self) -> str:
            return "hello"

    registry = ExtensionRegistry()
    provider = GreetingProvider()
    registry.register_provider("GREETING.V1", provider)

    resolved = registry.require_provider("greeting.v1", expected_type=Greeter)
    assert resolved.greet() == "hello"
    with pytest.raises(ProviderRegistrationError, match="already registered"):
        registry.register_provider("greeting.v1", provider)
    with pytest.raises(ProviderNotFoundError):
        registry.require_provider("missing.v1")


def test_provider_registry_rejects_invalid_identity_and_non_runtime_protocol() -> None:
    class InvalidProvider:
        provider_id = " "

    class StaticOnlyProvider(Protocol):
        provider_id: str

    registry = ExtensionRegistry()
    with pytest.raises(ProviderRegistrationError, match="invalid provider_id"):
        registry.register_provider("invalid.v1", InvalidProvider())

    class ValidProvider:
        provider_id = "valid.provider"

    registry.register_provider("valid.v1", ValidProvider())
    with pytest.raises(ProviderRegistrationError, match="runtime instance checks"):
        registry.require_provider("valid.v1", expected_type=StaticOnlyProvider)


def test_extension_dependencies_are_stable_core_aliases() -> None:
    from app.auth import require_admin as core_require_admin
    from app.auth import require_recent_admin as core_require_recent_admin
    from app.database import get_db as core_get_db
    from app.extensions import get_db, require_admin, require_recent_admin

    assert require_admin is core_require_admin
    assert require_recent_admin is core_require_recent_admin
    assert get_db is core_get_db
