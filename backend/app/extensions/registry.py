"""Provider registry shared by independently packaged application extensions."""
from __future__ import annotations

from typing import TYPE_CHECKING, TypeVar, cast

from app.extensions.contracts import Provider

if TYPE_CHECKING:
    from fastapi import FastAPI


ProviderT = TypeVar("ProviderT")


class ProviderRegistrationError(RuntimeError):
    """A provider registration would make the registry ambiguous or unsafe."""


class ProviderNotFoundError(LookupError):
    """A required provider contract has not been installed."""


class ExtensionRegistry:
    """Process-local registry populated during extension installation.

    Contract names are intentionally strings (for example
    ``"identity.v1"``), which keeps separately distributed Python packages
    decoupled.  Registration is first-writer-wins; implicit replacement is
    rejected so extension order cannot silently change a security provider.
    """

    def __init__(self) -> None:
        self._providers: dict[str, Provider] = {}

    def register_provider(self, contract: str, provider: Provider) -> None:
        normalized = _normalize_contract(contract)
        if normalized in self._providers:
            raise ProviderRegistrationError(
                f"provider contract already registered: {normalized}"
            )
        if not isinstance(provider, Provider):
            raise ProviderRegistrationError(
                f"provider for {normalized} must expose a provider_id"
            )
        provider_id = provider.provider_id
        if (
            not isinstance(provider_id, str)
            or not provider_id
            or provider_id != provider_id.strip()
        ):
            raise ProviderRegistrationError(
                f"provider for {normalized} has an invalid provider_id"
            )
        self._providers[normalized] = provider

    def get_provider(self, contract: str) -> Provider | None:
        return self._providers.get(_normalize_contract(contract))

    def require_provider(
        self,
        contract: str,
        *,
        expected_type: type[ProviderT] | None = None,
    ) -> Provider | ProviderT:
        normalized = _normalize_contract(contract)
        provider = self._providers.get(normalized)
        if provider is None:
            raise ProviderNotFoundError(f"required provider is not installed: {normalized}")
        if expected_type is not None:
            try:
                compatible = isinstance(provider, expected_type)
            except TypeError as exc:
                raise ProviderRegistrationError(
                    "expected_type must support runtime instance checks"
                ) from exc
            if not compatible:
                raise ProviderRegistrationError(
                    f"provider {provider.provider_id!r} does not implement {normalized}"
                )
        if expected_type is not None:
            return cast(ProviderT, provider)
        return provider

    @property
    def contracts(self) -> tuple[str, ...]:
        """Registered contract names in deterministic installation order."""
        return tuple(self._providers)


def get_extension_registry(app: FastAPI) -> ExtensionRegistry:
    """Return the registry attached by the core extension manager."""
    registry = getattr(app.state, "extension_registry", None)
    if not isinstance(registry, ExtensionRegistry):
        raise RuntimeError("application extension registry is not initialized")
    return registry


def _normalize_contract(contract: str) -> str:
    normalized = str(contract).strip().lower()
    if not normalized or any(char.isspace() for char in normalized):
        raise ProviderRegistrationError("provider contract must be a non-empty token")
    return normalized
