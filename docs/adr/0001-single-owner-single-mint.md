# One owner and one mint per deployment

Each Sats on Ice deployment serves its owner's own funds through one configured username and one owner-configured Cashu mint for incoming Lightning payments and on-chain payouts. The server verifies the mint's required capabilities at startup. A single receiving identity keeps one accumulated balance and one destination wallet, avoiding accounting and wallet isolation across multiple usernames as well as multi-user access control and multi-mint routing.
