# Keep setup and verification independent of payment recovery

The owner must be able to initialize or inspect local identity and wallet state without contacting the mint or advancing payments, so `setup` and `verify` initialize and read Coco’s repositories directly. In Coco 2.0.0, `initializeCoco()` performs operation recovery even with watchers and processors disabled; these commands therefore create no manager and report only unreserved ready proofs in sats at the environment-selected mint, accepting a locally observed balance that has not been reconciled with the mint. The payment server started by `serve` owns capability checks, receiving recovery and background processing, and a successful local CLI check establishes no payment readiness.

See [local setup](../design/local-setup.md) and [receiving](../design/lightning-receiving.md) for the connection lifecycle and verification limits.
