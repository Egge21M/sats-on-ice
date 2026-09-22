FROM oven/bun:1.3.14-slim@sha256:d56a2534ffd262e92c12fd3249d3924d296d97086da773f821d7d0477435ea04 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY index.ts migrations.ts ./
COPY src ./src
COPY scripts/copy-migrations.ts ./scripts/copy-migrations.ts
COPY drizzle ./drizzle
RUN bun run build

FROM oven/bun:1.3.14-slim@sha256:d56a2534ffd262e92c12fd3249d3924d296d97086da773f821d7d0477435ea04
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY LICENSE ./LICENSE
# Fly mounts a root-owned volume at /data. Wallet files are created as 0600;
# use the same OS user for the server and local status/backup commands.
USER root
ENV NODE_ENV=production \
    SOI_DATABASE=/data/sats-on-ice.sqlite \
    SOI_HOSTNAME=0.0.0.0 \
    SOI_PORT=3000
EXPOSE 3000
STOPSIGNAL SIGTERM
ENTRYPOINT ["bun", "/app/dist/index.js"]
CMD ["serve"]
