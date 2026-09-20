# Share one database with separate application and wallet migrations

Configuration, identity, next payout index, Cashu seed and Coco wallet state share one SQLite file so a consistent backup can capture the whole instance without coordinating separate stores. Drizzle owns the application tables and their committed SQL migrations, while Coco owns its wallet tables and migration history; keeping those histories separate avoids making application schema generation responsible for Coco's schema. Initial application writes are atomic, but Coco's asynchronous initialization runs afterward and can be retried with the persisted seed; sharing a file does not make application changes and wallet operations one transaction.

The table ownership, initialization order and backup limits are documented in [local setup](../design/local-setup.md).
