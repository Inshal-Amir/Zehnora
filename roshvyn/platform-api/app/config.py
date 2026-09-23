"""Runtime settings, read from environment variables (see .env.example)."""

from __future__ import annotations

from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="ROSHVYN_", env_file=".env", extra="ignore")

    # Profile label shown in /platform/v1/health and the portal: "mock", "dev-local-4b" or "gpu".
    profile: str = "mock"

    database_url: str = "postgresql+psycopg://roshvyn_platform:change-me@127.0.0.1:5433/roshvyn_platform"

    # Private LiteLLM gateway. The master key is only used for key management.
    litellm_base_url: str = "http://127.0.0.1:4000"
    litellm_master_key: str = ""
    # Restricted LiteLLM virtual key used ONLY by the server-side portal playground path.
    playground_gateway_key: str = ""

    # Secrets for key fingerprints and CSRF tokens (32+ random bytes, hex).
    key_hmac_secret: str = ""
    session_secret: str = ""

    cookie_secure: bool = False  # True behind HTTPS
    session_hours: int = 12
    cors_origins: list[str] = Field(default_factory=list)
    public_api_base: str = "http://127.0.0.1:8200/v1"

    # Credits: 1 displayed credit = 1000 integer units (brief 6.5).
    units_per_credit: int = 1000

    # Upper-bound token estimate: byte-level BPE tokens cover >= 1 byte each,
    # plus chat-template overhead per message and for tool preambles.
    template_overhead_tokens: int = 1024
    per_message_overhead_tokens: int = 16

    max_inflight_requests: int = 4  # beyond this: 429 capacity
    upstream_timeout_s: float = 600.0
    disconnect_drain_s: float = 20.0  # bounded wait for final usage after a client disconnect

    login_max_failures_per_email: int = 5
    login_max_failures_per_ip: int = 20
    login_window_minutes: int = 15
    min_password_length: int = 10


@lru_cache
def get_settings() -> Settings:
    return Settings()
