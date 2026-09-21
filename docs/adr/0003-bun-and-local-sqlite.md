# Run one Bun process with local SQLite persistence

Sats on Ice uses TypeScript on Bun with SQLite persistence, distributed as a Docker image with persistent storage. One server process and a local database fit the single-owner deployment without requiring a separately operated database service. Coco uses its Bun SQLite adapter; this couples the initial deployment to Bun and durable local storage.

For the receiving slice, running only one active server against a database is a documented operating requirement, without application enforcement of exclusive process ownership. Coco's process-local locks do not coordinate multiple servers; local CLI inspection remains supported. See the [receiving design](../design/lightning-receiving.md).
