# One owner, one active identity and one mint for new payments

Each deployment serves one owner through one active receiving identity and one environment-selected Cashu mint for new receiving and payout attempts. Earlier identities and destinations remain available for reuse; they do not partition balances or create multi-user accounts. Changing the mint leaves previous balances in Coco without automatic migration or new sweeps at those mints, while Coco retains responsibility for recovering existing operations.
