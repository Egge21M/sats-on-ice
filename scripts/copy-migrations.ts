import { cpSync } from "node:fs";

// Keep the generated SQL alongside the bundled entry point.
cpSync(new URL("../drizzle", import.meta.url), new URL("../dist/drizzle", import.meta.url), { recursive: true });
