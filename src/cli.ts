import { Command, CommanderError } from "commander";
import { z } from "zod";
import { UserError } from "./errors.ts";
import { setupInstance, verifyInstance, type SetupSummary } from "./setup.ts";
import { startReceivingServer } from "./server.ts";

function printSummary(summary: SetupSummary) {
  const { config } = summary;
  console.log(summary.created ? "Identity created." : "Existing identity selected.");
  console.log(`Username: ${config.username}`);
  console.log(`Mint: ${config.mintUrl}`);
  console.log(`Payout threshold: ${config.payoutThresholdSats} sats`);
  console.log(`Next payout index: ${config.nextPayoutIndex}`);
  console.log(`First payout address (/0/0): ${summary.firstPayoutAddress}`);
  console.log(`Accumulated balance: ${summary.accumulatedBalanceSats} sats`);
  console.log("Compare the first payout address with your wallet. Use a fresh, dedicated account xpub; address history is not checked.");
  console.log("Local verification only; mint capabilities have not been checked.");
}

export async function runCli(argv: string[]) {
  const program = new Command()
    .name("sats-on-ice")
    .description("Run an env-configured Lightning Address and inspect its Cashu wallet.")
    .option("--database <path>", "persistent SQLite database file", process.env.SOI_DATABASE ?? "./data/sats-on-ice.sqlite")
    .exitOverride();

  program.command("setup")
    .description("Initialize/select the environment-configured identity locally (optional before serve)")
    .action(async () => printSummary(await setupInstance(program.opts().database)));

  program.command("verify")
    .description("Inspect the env-selected identity and local balance at the configured mint")
    .action(async () => printSummary(await verifyInstance(program.opts().database)));

  program.command("serve")
    .description("Serve the Lightning Address and claim incoming payments (one server per database)")
    .option("--hostname <host>", "interface to bind; use 0.0.0.0 behind an HTTPS proxy", process.env.SOI_HOSTNAME ?? "127.0.0.1")
    .option("--port <port>", "HTTP port (0 selects a free port)", process.env.SOI_PORT ?? "3000")
    .action(async (options) => {
      const port = z.string().regex(/^[0-9]+$/).transform(Number).pipe(z.number().int().min(0).max(65535)).parse(options.port);
      const service = await startReceivingServer({
        database: program.opts().database,
        hostname: options.hostname,
        port,
        onStatus: (_status, message) => console.log(message),
        onPayout: (message) => console.log(message),
      });
      console.log(`Listening on ${options.hostname}:${service.port}. The HTTPS proxy must preserve the public Host header.`);
      const shutdown = () => {
        process.off("SIGINT", shutdown);
        process.off("SIGTERM", shutdown);
        void service.stop().catch(() => {
          console.error("Unable to shut down receiving cleanly. Reopen the saved wallet to reconcile pending payments.");
          process.exitCode = 1;
        });
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    });

  try {
    await program.parseAsync(argv);
  } catch (error) {
    if (error instanceof CommanderError) {
      process.exitCode = error.exitCode;
      return;
    }
    if (error instanceof z.ZodError) {
      console.error(`Invalid configuration: ${error.issues.map((issue) => `${issue.path.join(".") || "value"}: ${issue.message}`).join("; ")}`);
    } else if (error instanceof UserError) {
      console.error(error.message);
    } else {
      // Library/SQL errors may contain bound seed or proof values. Never dump them.
      console.error("Unable to open or initialize the wallet. Check the database path, permissions, available disk space and application migrations. Existing wallet data is never reset automatically.");
    }
    process.exitCode = 1;
  }
}
