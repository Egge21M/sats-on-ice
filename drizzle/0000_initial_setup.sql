CREATE TABLE `soi_identity` (
	`id` integer PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`destination_key` text NOT NULL,
	`next_payout_index` integer DEFAULT 0 NOT NULL,
	CONSTRAINT "soi_identity_singleton" CHECK("soi_identity"."id" = 1),
	CONSTRAINT "soi_identity_index" CHECK(typeof("soi_identity"."next_payout_index") = 'integer' AND "soi_identity"."next_payout_index" BETWEEN 0 AND 2147483648)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `soi_identity_username_unique` ON `soi_identity` (`username`);--> statement-breakpoint
CREATE TABLE `soi_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	CONSTRAINT "soi_settings_json" CHECK(json_valid("soi_settings"."value"))
);
--> statement-breakpoint
CREATE TABLE `soi_wallet_secret` (
	`id` integer PRIMARY KEY NOT NULL,
	`seed` blob NOT NULL,
	CONSTRAINT "soi_wallet_secret_singleton" CHECK("soi_wallet_secret"."id" = 1),
	CONSTRAINT "soi_wallet_secret_length" CHECK(typeof("soi_wallet_secret"."seed") = 'blob' AND length("soi_wallet_secret"."seed") = 64)
);
