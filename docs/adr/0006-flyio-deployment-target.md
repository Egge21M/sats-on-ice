# Target Fly.io for deployment

Fly.io is the initial deployment target for the Docker-packaged Bun server, using one Machine with one persistent volume for SQLite state, including the Cashu seed, wallet state, configuration, and next payout index. This accepts downtime during deployments or host failures instead of introducing replicated wallet state and failover in v1. The application remains packaged as a container, with Fly providing the HTTPS proxy and persistent volume.
