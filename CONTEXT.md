# Sats on Ice

Sats on Ice is a self-hosted, free and open-source Lightning Address service that accumulates incoming Lightning payments as Cashu ecash for threshold-triggered payouts to a Bitcoin wallet.

## Language

**Owner**:
The person who deploys a Sats on Ice instance for their own incoming payments and destination wallet.
_Avoid_: Tenant, customer

**Identity**:
The server's single configured receiving identity, identified by its username and associated with a destination wallet and sequence of payout addresses.
_Avoid_: User, tenant, alias

**Username**:
The configured name before `@` in the server's Lightning Address.

**Lightning Address**:
A human-readable `username@domain` payment identifier for an identity, through which a payer can request a receiving invoice using LNURL-pay.

**Incoming payment**:
A Lightning payment received through a Lightning Address and intended to become Cashu ecash held by Sats on Ice until payout.
_Avoid_: Deposit, on-chain payment

**Payer**:
The person sending an incoming payment to the owner's Lightning Address.

**Receiving invoice**:
A mint-issued Lightning invoice for an incoming payment. Payment of the invoice does not by itself mean the owner holds spendable Cashu ecash.

**Ecash claim**:
The issuance of locally held Cashu ecash against a paid receiving invoice, making the received funds available to the owner's accumulated balance.

**Cashu mint**:
The single owner-configured service that issues the Cashu ecash accumulated by a Sats on Ice instance and redeems that ecash for a payout.

**Cashu wallet**:
The instance's single wallet holding ecash from its configured Cashu mint while awaiting payout.
_Avoid_: Destination wallet, Bitcoin wallet

**Cashu seed**:
The secret from which the Cashu wallet derives its keys and deterministic ecash secrets, independent of the destination wallet's private keys.
_Avoid_: Destination key, destination wallet seed

**Accumulated balance**:
The spendable Cashu ecash held by Sats on Ice from incoming payments while awaiting payout; ecash reserved for a pending payout is excluded. Unpaid receiving invoices and paid receiving invoices awaiting an ecash claim contribute nothing to this balance.
_Avoid_: Bitcoin wallet balance, on-chain balance

**Payout threshold**:
The owner-configured minimum local accumulated balance, measured before payout fees, at which an automatic payout is attempted.

**Payout**:
A withdrawal of accumulated Cashu ecash through a Cashu mint to an on-chain address in the destination wallet.
_Avoid_: Lightning payment, incoming payment

**Destination wallet**:
The owner's Bitcoin wallet associated with an identity, with payout addresses derived from the extended public key supplied for that identity.
_Avoid_: Cashu wallet, mint wallet

**Destination key**:
The extended public key for an account in the destination wallet, from which payout addresses can be derived without authority to spend that wallet's bitcoin.
_Avoid_: Cashu seed, private key

**Payout address**:
An on-chain Bitcoin receiving address in the destination wallet to which a payout is directed.
_Avoid_: Lightning Address

**Payout index**:
The position of a payout address in the sequence of receiving addresses derived from the destination wallet's extended public key.

**Next payout index**:
An identity's next unallocated position in its destination wallet's receiving-address sequence, initially zero; starting a payout consumes that position even if the payout has not completed.
_Avoid_: Last-paid index, last-used address
