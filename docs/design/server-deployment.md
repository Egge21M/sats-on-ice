# Deploy on a regular server

Run one `serve` process on a host with persistent local storage and an HTTPS reverse proxy. The host may stay on continuously or fully stop the application and start a new process later. Before host sleep or shutdown, terminate the service and wait for it to exit; after the host starts, launch `serve` again. Memory-preserving process suspension and warm resume are unsupported.

## Native process

Install the pinned Bun version and dependencies, configure the environment described in the [README](../../README.md#configure-and-start-an-instance), then run:

```sh
bun run build
bun dist/index.js --database /var/lib/sats-on-ice/wallet.sqlite serve --hostname 127.0.0.1 --port 3000
```

Create `/var/lib/sats-on-ice` for the service user before starting. Keep `dist/index.js` and `dist/drizzle/` together. Configure your service supervisor to pass the runtime environment, send SIGTERM on shutdown, wait for the process to exit and start only one copy against this database. The service initializes a fresh database automatically. See [local setup](local-setup.md) for identity configuration and address verification before receiving payments.

## Docker

The supplied image runs the same server and stores its database at `/data/sats-on-ice.sqlite`. Use a persistent volume:

```sh
docker build -t sats-on-ice:local .
docker volume create soi_data
docker run --name sats-on-ice --mount source=soi_data,target=/data \
  --env-file .env --stop-timeout 30 \
  -p 127.0.0.1:3000:3000 sats-on-ice:local
```

For this example, omit `SOI_DATABASE`, `SOI_HOSTNAME` and `SOI_PORT` from `.env` to use the image defaults. Stop with `docker stop sats-on-ice`; start a new server process in the same container with `docker start sats-on-ice`. When replacing the container for an upgrade, retain and remount `soi_data`. Run status as the same OS user inside the container with `docker exec sats-on-ice bun /app/dist/index.js status`.

## Networking and recovery

Preserve the public `Host` header through the HTTPS reverse proxy so `alice` on `pay.example` receives at `alice@pay.example`. When a proxy connects over a container network, bind `SOI_HOSTNAME=0.0.0.0`; the image already does this. Use `GET /readyz` to check completion of capability validation and wallet initialization. It returns no wallet details and is not a continuous mint-health probe.

Retain the complete database and runtime environment through every shutdown. Startup initializes Coco with its default recovery and workers, then enables receiving and evaluates available funds. Recovery may continue after the service becomes ready. Claims and payouts wait while the service is stopped, even if an already-issued invoice is paid directly at the mint. See [payment recovery](payment-recovery.md) for startup retries, shutdown behavior and the known Coco polling limitation.

Take [complete database backups](wallet-backup.md) and keep a copy off the server. Do not run another wallet server against the same database or a copied wallet. Multiple containers and replicated volumes are not a supported failover setup.

[Fly.io](fly-deployment.md) is an optional hosting example with the same process and storage requirements. Its template keeps the server running; optional idle stopping must use a full stop and start.
