# Run on a regular server with persistent storage

Sats on Ice runs as one Bun process on a regular server, directly or in the supplied Docker image, with one persistent SQLite database and an HTTPS reverse proxy. Fly.io remains an optional deployment example rather than a platform requirement; its template keeps one Machine running with one persistent volume. This replaces the initial Fly-specific deployment target and accepts downtime during deployments or host failures instead of introducing replicated wallet state and failover.
