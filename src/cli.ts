import { Command, CommanderError } from "commander";
import { z } from "zod";
import { thresholdArgumentSchema } from "./config.ts";
import { UserError } from "./errors.ts";
import { setupInstance, verifyInstance, type SetupSummary } from "./setup.ts";

function printSummary(summary: SetupSummary) {
  const { config } = summary;
  console.log(summary.created ? "Setup created." : "Existing setup verified.");
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
    .description("Configure a self-hosted Lightning Address and its local Cashu wallet.")
    .option("--database <path>", "persistent SQLite database file", "./data/sats-on-ice.sqlite")
    .exitOverride();

  program.command("setup")
    .description("Create setup, or verify identical existing setup without replacing it")
    .requiredOption("--username <name>", "single lowercase Lightning Address username")
    .requiredOption("--mint <url>", "Cashu mint HTTP(S) URL")
    .requiredOption("--xpub <key>", "Bitcoin mainnet native SegWit account xpub or zpub")
    .requiredOption("--threshold <sats>", "positive whole-satoshi payout threshold")
    .action(async (options) => {
      const summary = await setupInstance(program.opts().database, {
        username: options.username,
        mintUrl: options.mint,
        destinationKey: options.xpub,
        payoutThresholdSats: thresholdArgumentSchema.parse(options.threshold),
      });
      printSummary(summary);
    });

  program.command("verify")
    .description("Reopen stored setup and show its local spendable balance")
    .action(async () => printSummary(await verifyInstance(program.opts().database)));

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
