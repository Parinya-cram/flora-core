"""Canopy accounts from the command line (run in the canopy-api container, as the database owner).

    python -m app.cli_accounts list
    python -m app.cli_accounts create CODE "Hospital name" --admin admin --password '…' [--haber-url URL]
    python -m app.cli_accounts migrate [CODE]            # apply new bundle files to every account (or one)
    python -m app.cli_accounts rotate-secret CODE        # new Leaf / Haber sync secret (printed once)
    python -m app.cli_accounts suspend|activate CODE
    python -m app.cli_accounts set-haber CODE URL
    python -m app.cli_accounts adopt-public CODE "Name"  # one time: today's single-hospital data becomes account CODE
    python -m app.cli_accounts platform-admin USERNAME   # create / reset a platform administrator (password prompted)

Needs FLORA_PLATFORM_DATABASE_URL (the database owner). adopt-public keeps FLORA_SYNC_SHARED_SECRET as
that account's sync secret so running Leafs and Haber keep working.
"""
from __future__ import annotations

import argparse
import getpass
import json
import os
import sys

from . import tenancy_provision as provision


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m app.cli_accounts")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("list")
    create = commands.add_parser("create")
    create.add_argument("code")
    create.add_argument("name")
    create.add_argument("--admin", default="admin")
    create.add_argument("--password")
    create.add_argument("--haber-url")
    migrate = commands.add_parser("migrate")
    migrate.add_argument("code", nargs="?")
    for name in ("rotate-secret", "suspend", "activate"):
        commands.add_parser(name).add_argument("code")
    haber = commands.add_parser("set-haber")
    haber.add_argument("code")
    haber.add_argument("url")
    adopt = commands.add_parser("adopt-public")
    adopt.add_argument("code")
    adopt.add_argument("name")
    admin = commands.add_parser("platform-admin")
    admin.add_argument("username")
    args = parser.parse_args(argv)
    actor = f"cli:{os.getenv('USER', 'operator')}"
    try:
        if args.command == "list":
            for row in provision.list_accounts():
                print(f"{row['code']:<16} {row['status']:<10} {row['schema_name']:<22} migrations {row['migrations']}/{row['migrations_total']}  {row['name']}")
        elif args.command == "create":
            password = args.password or getpass.getpass(f"Password for {args.admin}: ")
            result = provision.create_account(args.code, args.name, args.admin, password, actor, args.haber_url)
            print(json.dumps(result, indent=1))
            print("Keep the sync_secret: Leafs (FLORA_SYNC_SHARED_SECRET) and Haber of this account use it; it is not shown again.")
        elif args.command == "migrate":
            for code, files in provision.migrate(args.code, actor).items():
                print(f"{code}: {len(files)} file(s) applied" + (f" ({', '.join(files)})" if files else ""))
        elif args.command == "rotate-secret":
            print(provision.rotate_secret(args.code, actor))
        elif args.command in ("suspend", "activate"):
            provision.update_account(args.code, actor, status="suspended" if args.command == "suspend" else "active")
            print("ok")
        elif args.command == "set-haber":
            provision.update_account(args.code, actor, haber_url=args.url)
            print("ok")
        elif args.command == "adopt-public":
            secret = os.getenv("FLORA_SYNC_SHARED_SECRET", "").strip()
            if not secret:
                print("FLORA_SYNC_SHARED_SECRET is not set: Leafs of this account would lose their sync secret", file=sys.stderr)
                return 2
            haber = os.getenv("FLORA_HABER_URL", "http://haber:8000").strip() or None
            print(json.dumps(provision.adopt_public(args.code, args.name, secret, actor, haber), indent=1))
        elif args.command == "platform-admin":
            password = getpass.getpass("New password: ") if sys.stdin.isatty() else sys.stdin.readline().strip()
            if len(password) < 10:
                print("use at least 10 characters", file=sys.stderr)
                return 2
            provision.ensure_platform_admin(args.username, password)
            print("ok")
    except provision.ProvisionError as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
