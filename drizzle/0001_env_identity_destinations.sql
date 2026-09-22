CREATE TABLE `soi_destination` (
  `id` integer PRIMARY KEY NOT NULL,
  `xpub` text NOT NULL,
  `next_payout_index` integer DEFAULT 0 NOT NULL,
  CONSTRAINT "soi_destination_index" CHECK(typeof("soi_destination"."next_payout_index") = 'integer' AND "soi_destination"."next_payout_index" BETWEEN 0 AND 2147483648)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `soi_destination_xpub_unique` ON `soi_destination` (`xpub`);
--> statement-breakpoint
INSERT INTO `soi_destination` (`id`, `xpub`, `next_payout_index`)
SELECT `id`, `destination_key`, `next_payout_index` FROM `soi_identity`;
--> statement-breakpoint
CREATE TABLE `__new_soi_identity` (
  `id` integer PRIMARY KEY NOT NULL,
  `username` text NOT NULL,
  `destination_id` integer NOT NULL,
  FOREIGN KEY (`destination_id`) REFERENCES `soi_destination`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_soi_identity` (`id`, `username`, `destination_id`)
SELECT `id`, `username`, `id` FROM `soi_identity`;
--> statement-breakpoint
DROP TABLE `soi_identity`;
--> statement-breakpoint
ALTER TABLE `__new_soi_identity` RENAME TO `soi_identity`;
--> statement-breakpoint
CREATE UNIQUE INDEX `soi_identity_username_destination_unique` ON `soi_identity` (`username`,`destination_id`);
--> statement-breakpoint
CREATE TABLE `soi_active_identity` (
  `id` integer PRIMARY KEY NOT NULL,
  `identity_id` integer NOT NULL,
  FOREIGN KEY (`identity_id`) REFERENCES `soi_identity`(`id`) ON UPDATE no action ON DELETE no action,
  CONSTRAINT "soi_active_identity_singleton" CHECK("soi_active_identity"."id" = 1)
);
--> statement-breakpoint
INSERT INTO `soi_active_identity` (`id`, `identity_id`) SELECT 1, `id` FROM `soi_identity`;
--> statement-breakpoint
DROP TABLE `soi_settings`;
