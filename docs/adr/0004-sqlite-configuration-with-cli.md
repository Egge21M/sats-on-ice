# Store configuration in SQLite and manage it through a CLI

Instance settings live in a SQLite key-value store, while receiving identities have a dedicated SQLite table; a CLI is the initial configuration interface. This replaces file-based configuration so an onboarding flow or future browser interface can use the same stored settings. Username and payout-threshold changes take effect after a server restart, while the mint and destination xpub remain fixed for existing wallet state; a browser interface and migration of those fixed settings are outside the initial scope.
