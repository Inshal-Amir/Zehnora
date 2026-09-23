"""Local administration commands (run on the server, never exposed over HTTP).

  python -m app.cli bootstrap-admin --email admin@example.com   # password read from a prompt or --password-file
  python -m app.cli seed-model --alias zehnora-coder --identity "..." --context 4096 --max-output 1024
  python -m app.cli create-gateway-key                          # restricted LiteLLM key for the portal playground
  python -m app.cli grant-credits --email user@example.com --credits 100 --reason "demo"
  python -m app.cli create-key --email user@example.com --name "sdk test"   # prints the secret once
"""

from __future__ import annotations

import argparse
import asyncio
import getpass
import sys
import uuid
from pathlib import Path

from sqlalchemy import select

from . import billing, litellm_client
from .config import get_settings
from .db import dispose, sessionmaker
from .models import AuditEvent, ModelCatalog, ModelRate, User, Wallet
from .routes_platform import KeyCreate, issue_key, normalize_email
from .security import hash_password


async def bootstrap_admin(email: str, password_file: str | None) -> None:
    email = normalize_email(email)
    if password_file:
        password = Path(password_file).read_text().strip()
    else:
        password = getpass.getpass("New admin password: ")
        if password != getpass.getpass("Repeat password: "):
            sys.exit("Passwords do not match.")
    if len(password) < 12:
        sys.exit("Admin password must be at least 12 characters.")
    async with sessionmaker()() as db:
        user = await db.scalar(select(User).where(User.email == email))
        if user is None:
            user = User(email=email, password_hash=hash_password(password), role="admin", status="active")
            db.add(user)
            await db.flush()
            db.add(Wallet(user_id=user.id, balance_units=0, reserved_units=0))
            action = "admin.bootstrap.create"
        else:
            user.role, user.password_hash, user.status = "admin", hash_password(password), "active"
            action = "admin.bootstrap.promote"
        db.add(AuditEvent(actor_user_id=None, action=action, target_type="user", target_id=str(user.id), details={"via": "cli"}))
        await db.commit()
    print(f"Admin ready: {email} ({action}). Password was not logged.")


async def seed_model(alias: str, identity: str, description: str, context: int, max_output: int, default_output: int,
                     input_rate: int, output_rate: int) -> None:
    async with sessionmaker()() as db:
        m = await db.scalar(select(ModelCatalog).where(ModelCatalog.alias == alias))
        if m is None:
            m = ModelCatalog(alias=alias, deployment_identity=identity, description=description, context_limit=context,
                             max_output_limit=max_output, default_output_tokens=default_output)
            db.add(m)
            await db.flush()
        else:
            m.deployment_identity, m.description = identity, description
            m.context_limit, m.max_output_limit, m.default_output_tokens = context, max_output, default_output
        latest = await db.scalar(select(ModelRate).where(ModelRate.model_id == m.id).order_by(ModelRate.version.desc()).limit(1))
        if latest is None or (latest.input_units_per_token, latest.output_units_per_token) != (input_rate, output_rate):
            db.add(ModelRate(model_id=m.id, version=(latest.version + 1) if latest else 1,
                             input_units_per_token=input_rate, output_units_per_token=output_rate))
        await db.commit()
    print(f"Model {alias} -> {identity} (context {context}, max output {max_output}, rates {input_rate}/{output_rate})")


async def create_gateway_key(models: list[str]) -> None:
    secret, token_id = await litellm_client.generate_key(models=models, alias="zehnora-portal-playground",
                                                         metadata={"purpose": "portal playground (server-side only)"})
    print(secret)
    print(f"(LiteLLM token id {token_id}; store the key above as ZEHNORA_PLAYGROUND_GATEWAY_KEY in server secrets)", file=sys.stderr)


async def _user_by_email(db, email: str) -> User:
    user = await db.scalar(select(User).where(User.email == normalize_email(email)))
    if user is None:
        sys.exit(f"No account with email {email}. Register in the portal or run bootstrap-admin first.")
    return user


async def grant_credits(email: str, credits: float, reason: str) -> None:
    async with sessionmaker()() as db:
        user = await _user_by_email(db, email)
        units = round(credits * get_settings().units_per_credit)
        op = f"cli-grant:{uuid.uuid4()}"
        wallet = await billing.grant(db, user_id=user.id, units=units, actor_user_id=None, reason=reason, operation_id=op)
        db.add(AuditEvent(actor_user_id=None, action="credits.grant", target_type="user", target_id=str(user.id),
                          details={"units": units, "reason": reason, "operation_id": op, "via": "cli"}))
        await db.commit()
    print(f"Granted {credits:g} credits to {user.email}; balance {wallet.balance_units / get_settings().units_per_credit:g} credits.")


async def create_key(email: str, name: str) -> None:
    async with sessionmaker()() as db:
        user = await _user_by_email(db, email)
        k, secret = await issue_key(db, user_id=user.id, body=KeyCreate(name=name), ip=None)
    print(secret)
    print(f"(key {k.display_prefix}...{k.last4} for {user.email}; shown once, store it safely)", file=sys.stderr)


def main() -> None:
    ap = argparse.ArgumentParser(prog="python -m app.cli")
    sub = ap.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("bootstrap-admin")
    b.add_argument("--email", required=True)
    b.add_argument("--password-file")
    s = sub.add_parser("seed-model")
    s.add_argument("--alias", default="zehnora-coder")
    s.add_argument("--identity", required=True)
    s.add_argument("--description", default="Zehnora coding assistant model")
    s.add_argument("--context", type=int, default=4096)
    s.add_argument("--max-output", type=int, default=1024)
    s.add_argument("--default-output", type=int, default=512)
    s.add_argument("--input-rate", type=int, default=1)
    s.add_argument("--output-rate", type=int, default=2)
    g = sub.add_parser("create-gateway-key")
    g.add_argument("--models", nargs="+", default=["zehnora-coder"])
    c = sub.add_parser("grant-credits")
    c.add_argument("--email", required=True)
    c.add_argument("--credits", type=float, required=True)
    c.add_argument("--reason", default="granted from the server CLI")
    k = sub.add_parser("create-key")
    k.add_argument("--email", required=True)
    k.add_argument("--name", default="cli key")
    a = ap.parse_args()

    async def run():
        try:
            if a.cmd == "bootstrap-admin":
                await bootstrap_admin(a.email, a.password_file)
            elif a.cmd == "seed-model":
                await seed_model(a.alias, a.identity, a.description, a.context, a.max_output, a.default_output,
                                 a.input_rate, a.output_rate)
            elif a.cmd == "grant-credits":
                await grant_credits(a.email, a.credits, a.reason)
            elif a.cmd == "create-key":
                await create_key(a.email, a.name)
            else:
                await create_gateway_key(a.models)
        finally:
            await dispose()

    asyncio.run(run())


if __name__ == "__main__":
    main()
