# Keep setup and verification independent of payment recovery

The owner must be able to initialize or inspect local configuration without contacting the mint or advancing payments, so `setup` and `verify` open Coco for local inspection only. In Coco 2.0.0, `initializeCoco()` performs operation recovery even with watchers and processors disabled; the CLI therefore initializes repositories and constructs `Manager` explicitly, accepting a locally observed balance that has not been reconciled with the mint. The future payment server owns capability checks, recovery and background processing, and a successful CLI check establishes no payment readiness.

See [local setup](../design/local-setup.md) for the connection lifecycle and verification limits.
