import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/storage/schema.ts",
  out: "./drizzle",
  migrations: { table: "soi_migrations" },
});
