# Shared development server

One Flora stack runs on the Ubuntu server at `172.22.1.103`; both developers
point their browser at the same instance so they always see the same build and
the same data. GitLab CE runs on the same host at port 8080.

| What | Where |
| --- | --- |
| GitLab CE | <http://172.22.1.103:8080> |
| Leaf UI | <http://172.22.1.103:6890> |
| Leaf API docs | <http://172.22.1.103:6893/docs> |
| LiveAgent feed | <http://172.22.1.103:6897/health> |
| SSH | port 2222 |

## The rule

Share the running server, not the working tree.

Each developer edits on their own machine, in their own checkout, with their
own Claude session, and pushes to GitLab. The server's checkout is a deploy
target: nobody edits files there, and nobody runs `docker compose` there by
hand. Two people editing one directory overwrite each other silently, and git
cannot help before a commit exists.

## How an update reaches the server

The dev stack bind-mounts `frontend/` and `services/flora-api/app`, and the API
runs `uvicorn --reload`, so most changes need no rebuild:

| Changed | Effect |
| --- | --- |
| React / Python source | hot reload, pull is enough |
| `requirements.txt`, `package.json`, any `Dockerfile` | rebuild |
| `compose.dev.yaml`, `compose/*.yaml` | rebuild |
| `infrastructure/postgres/*.sql` | **database reset — see below** |

`scripts/server/deploy.sh` decides which of these applies and acts accordingly.
The `deploy-dev` CI job runs it on every push to the default branch.

## Migrations destroy shared data

`infrastructure/postgres/*.sql` is mounted into `/docker-entrypoint-initdb.d/`,
which PostgreSQL executes only when the data volume is empty. Adding a file
there has no effect on a running database; applying it means deleting the
volume, and this database is shared.

Before adding a migration, tell the other developer. Then:

```bash
./scripts/server/backup-db.sh     # keeps the 20 most recent dumps
./scripts/server/reset-db.sh      # destroys and rebuilds, asks for RESET
./scripts/server/restore-db.sh backup/flora-<timestamp>.sql.gz
```

There is no migration runner in this repository. Until one exists, this manual
step is the cost of the shared database.

## Server setup

```bash
ssh -p 2222 <user>@172.22.1.103
sudo mkdir -p /opt/flora && sudo chown "$USER" /opt/flora
git clone <gitlab-url> /opt/flora && cd /opt/flora
cp .env.server.example .env        # then edit the passwords
docker compose -f compose.dev.yaml up -d --build
```

`.env` is untracked. The server keeps its own copy; it is never committed.

`FLORA_BIND_ADDR` controls which interface the ports bind to. It defaults to
`127.0.0.1` so a workstation stays closed, and `.env.server.example` sets
`0.0.0.0` so both developers can reach the API and database over the LAN.

## Backups

```cron
0 * * * * cd /opt/flora && ./scripts/server/backup-db.sh >> /var/log/flora-backup.log 2>&1
```

## Canopy and the device gateway

Neither starts with the default stack.

```bash
docker compose -f compose.dev.yaml --profile canopy up -d --build
docker compose -f flora-gateway/compose.yaml --profile demo up -d --build
```

The gateway is a separate Compose project on ports 74xx. See
[demo/README.md](../demo/README.md) for the whole platform on one machine.
