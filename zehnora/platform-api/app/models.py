"""ORM tables for the Zehnora platform database (zehnora_platform)."""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import ARRAY, JSONB, UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    pass


def _uuid() -> Mapped[uuid.UUID]:
    return mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)


def _created() -> Mapped[datetime]:
    return mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)


class User(Base):
    __tablename__ = "users"
    id: Mapped[uuid.UUID] = _uuid()
    email: Mapped[str] = mapped_column(String(320), unique=True, nullable=False)  # stored normalized (lowercase)
    password_hash: Mapped[str] = mapped_column(Text, nullable=False)
    role: Mapped[str] = mapped_column(String(16), nullable=False, default="user")
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="active")
    created_at: Mapped[datetime] = _created()
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())
    __table_args__ = (
        CheckConstraint("role in ('user','admin')", name="users_role_ck"),
        CheckConstraint("status in ('active','disabled')", name="users_status_ck"),
    )


class Session(Base):
    __tablename__ = "sessions"
    id: Mapped[uuid.UUID] = _uuid()
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    created_at: Mapped[datetime] = _created()
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    user_agent: Mapped[str | None] = mapped_column(String(300))
    ip: Mapped[str | None] = mapped_column(String(64))


class LoginAttempt(Base):
    __tablename__ = "login_attempts"
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    email: Mapped[str] = mapped_column(String(320), index=True, nullable=False)
    ip: Mapped[str | None] = mapped_column(String(64), index=True)
    success: Mapped[bool] = mapped_column(Boolean, nullable=False)
    created_at: Mapped[datetime] = _created()


class Wallet(Base):
    __tablename__ = "wallets"
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    balance_units: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    reserved_units: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())
    __table_args__ = (
        CheckConstraint("balance_units >= 0", name="wallets_balance_nonneg"),
        CheckConstraint("reserved_units >= 0", name="wallets_reserved_nonneg"),
        CheckConstraint("reserved_units <= balance_units", name="wallets_available_nonneg"),
    )


class CreditLedger(Base):
    """Append-only (UPDATE/DELETE blocked by a trigger in the migration)."""

    __tablename__ = "credit_ledger"
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), index=True, nullable=False)
    kind: Mapped[str] = mapped_column(String(16), nullable=False)
    amount_units: Mapped[int] = mapped_column(BigInteger, nullable=False)  # signed
    balance_after_units: Mapped[int] = mapped_column(BigInteger, nullable=False)
    actor_user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    reason: Mapped[str] = mapped_column(Text, nullable=False)
    operation_id: Mapped[str] = mapped_column(String(200), unique=True, nullable=False)
    request_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    created_at: Mapped[datetime] = _created()
    __table_args__ = (CheckConstraint("kind in ('grant','adjustment','usage')", name="ledger_kind_ck"),)


class ApiKey(Base):
    __tablename__ = "api_keys"
    id: Mapped[uuid.UUID] = _uuid()
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    fingerprint: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)  # HMAC-SHA256 hex
    display_prefix: Mapped[str] = mapped_column(String(16), nullable=False)
    last4: Mapped[str] = mapped_column(String(4), nullable=False)
    litellm_key_ref: Mapped[str] = mapped_column(String(200), nullable=False)  # LiteLLM hashed token id
    allowed_models: Mapped[list[str]] = mapped_column(ARRAY(String(100)), nullable=False)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="active")
    gateway_state: Mapped[str] = mapped_column(String(24), nullable=False, default="active")
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = _created()
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    __table_args__ = (
        CheckConstraint("status in ('active','revoked')", name="api_keys_status_ck"),
        CheckConstraint("gateway_state in ('active','revoke_pending','revoked')", name="api_keys_gateway_ck"),
    )


class ModelCatalog(Base):
    __tablename__ = "model_catalog"
    id: Mapped[uuid.UUID] = _uuid()
    alias: Mapped[str] = mapped_column(String(100), unique=True, nullable=False)
    deployment_identity: Mapped[str] = mapped_column(Text, nullable=False)  # actual underlying model, shown transparently
    description: Mapped[str] = mapped_column(Text, nullable=False, default="")
    is_visible: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    is_available: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    context_limit: Mapped[int] = mapped_column(Integer, nullable=False)
    max_output_limit: Mapped[int] = mapped_column(Integer, nullable=False)
    default_output_tokens: Mapped[int] = mapped_column(Integer, nullable=False)
    created_at: Mapped[datetime] = _created()
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class ModelRate(Base):
    __tablename__ = "model_rates"
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    model_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("model_catalog.id", ondelete="CASCADE"), nullable=False)
    version: Mapped[int] = mapped_column(Integer, nullable=False)
    input_units_per_token: Mapped[int] = mapped_column(Integer, nullable=False)
    output_units_per_token: Mapped[int] = mapped_column(Integer, nullable=False)
    effective_from: Mapped[datetime] = _created()
    created_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    __table_args__ = (
        UniqueConstraint("model_id", "version", name="model_rates_version_uq"),
        CheckConstraint("input_units_per_token >= 0 and output_units_per_token >= 0", name="model_rates_nonneg"),
    )


class InferenceRequest(Base):
    __tablename__ = "inference_requests"
    id: Mapped[uuid.UUID] = _uuid()  # server-side request id
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), index=True, nullable=False)
    api_key_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("api_keys.id"))
    source: Mapped[str] = mapped_column(String(16), nullable=False)  # api | playground
    model_alias: Mapped[str] = mapped_column(String(100), nullable=False)
    state: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    stream: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    reserved_units: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    max_output_tokens: Mapped[int] = mapped_column(Integer, nullable=False)
    input_token_bound: Mapped[int] = mapped_column(Integer, nullable=False)
    input_tokens: Mapped[int | None] = mapped_column(Integer)
    output_tokens: Mapped[int | None] = mapped_column(Integer)
    charged_units: Mapped[int | None] = mapped_column(BigInteger)
    rate_version: Mapped[int] = mapped_column(Integer, nullable=False)
    input_rate: Mapped[int] = mapped_column(Integer, nullable=False)
    output_rate: Mapped[int] = mapped_column(Integer, nullable=False)
    upstream_status: Mapped[int | None] = mapped_column(Integer)
    error_code: Mapped[str | None] = mapped_column(String(64))
    note: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = _created()
    dispatched_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    __table_args__ = (
        CheckConstraint(
            "state in ('reserved','dispatched','settled','released','pending_reconciliation')",
            name="inference_requests_state_ck",
        ),
    )


class PlaygroundConversation(Base):
    __tablename__ = "playground_conversations"
    id: Mapped[uuid.UUID] = _uuid()
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False)
    title: Mapped[str] = mapped_column(String(200), nullable=False, default="New conversation")
    model_alias: Mapped[str] = mapped_column(String(100), nullable=False)
    created_at: Mapped[datetime] = _created()
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class PlaygroundMessage(Base):
    __tablename__ = "playground_messages"
    id: Mapped[uuid.UUID] = _uuid()
    conversation_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("playground_conversations.id", ondelete="CASCADE"), index=True, nullable=False
    )
    role: Mapped[str] = mapped_column(String(16), nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    request_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    created_at: Mapped[datetime] = _created()


class AuditEvent(Base):
    __tablename__ = "audit_events"
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    actor_user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    action: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    target_type: Mapped[str | None] = mapped_column(String(32))
    target_id: Mapped[str | None] = mapped_column(String(64))
    details: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    ip: Mapped[str | None] = mapped_column(String(64))
    created_at: Mapped[datetime] = _created()
