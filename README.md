# Schnorr Scheme V1

This repository now contains a single active system: a Telegram-controlled, deterministic, threshold Bitcoin Taproot wallet built from three cooperating Node.js services.

The system supports:

- deterministic personal address creation
- deterministic group address creation
- threshold Schnorr signing
- Taproot key-path Bitcoin sends
- Telegram approval flow before signing
- peer health monitoring between signer nodes

This is still an experimental prototype.

Do not treat it as production custody software.

## Overview

There are always exactly three signer nodes:

- `node-1`
- `node-2`
- `node-3`

Each node:

- runs an HTTPS peer server
- polls Telegram for commands addressed to its bot
- keeps its own master seed and local share material
- can become coordinator for a round if the command was sent to its bot

Both major stages are distributed:

- distributed deterministic key generation and share derivation during `create`
- distributed threshold signing during `sign`, `signhash`, `send`, `multisign`, `multisignhash`, `multisend`

The active runtime lives in `v1/`.

Main files:

- `v1/three-headed-bot.js`
  Entry point, orchestration, command handlers, round coordination.

- `v1/crypto_backend.js`
  Threshold crypto, storage, HTTPS peer transport, Bitcoin provider access, transaction building, cleanup logic.

- `v1/tg_backend.js`
  Telegram polling, parsing of addressed commands, group messaging.

Configs:

- `v1/node-1.config.json`
- `v1/node-2.config.json`
- `v1/node-3.config.json`

Persistent runtime data:

- `v1/data/`

## Crypto Model

The wallet uses:

- Taproot addresses: `bc1p...`
- Schnorr signatures: `BIP340`
- Taproot key-path signing: `BIP341`

The signer topology is currently `2-of-3`.

That means:

- three nodes hold shares
- a successful sign/send operation uses exactly two of them
- the full private key is not reconstructed during signing

The system also does not construct the full private key during address creation.

During `create`:

- each node derives its own deterministic local contribution from its `masterSeed_fix`
- all three nodes exchange the required distributed protocol messages
- each node ends with only its own final local share
- the group public key and Taproot address are derived without any node ever holding the full private key

## Personal And Group Modes

The system has two address modes.

### Personal Mode

One Telegram user gets one deterministic address.

Relevant commands:

- `/create@bot`
- `/address@bot`
- `/balance@bot`
- `/sign@bot`
- `/signhash@bot`
- `/send@bot`

### Group Mode

One initiator plus two additional Telegram user IDs get one deterministic group address.

Group key format:

- sorted triple of user IDs
- example: `100-200-300`

Important:

- order of the two additional user IDs does not matter
- duplicates are currently allowed for testing

Relevant commands:

- `/create@bot <user_id2> <user_id3>`
- `/multisign@bot <user_id2> <user_id3> <message>`
- `/multisignhash@bot <user_id2> <user_id3> <32-byte-hex-hash>`
- `/multisend@bot <user_id2> <user_id3> <to_address> <amount_sats> <fee_rate>`

## What Is Secret

Critical secrets:

- `crypto.masterSeed_fix` in each node config
- `http.tls.keyPem` in each node config
- node databases in `v1/data/`, because they contain local share material after `create`

Not secret:

- Telegram bot usernames
- Bitcoin addresses
- public keys
- group keys
- peer IPs and ports

## Configuration

Each node has a JSON config file.

Important fields:

- `protocol_fix`
- `version`
- `node.index_fix`
- `node.id`
- `telegram.botToken`
- `telegram.allowedGroupId`
- `crypto.masterSeed_fix`
- `http.listenHost`
- `http.port`
- `http.tls.certPem`
- `http.tls.keyPem`
- `peers`
- `bitcoin.providers`

Fields with `_fix` affect deterministic derivation and must stay stable if you expect the same user or group to reproduce the same address later.

Most important `_fix` fields:

- `protocol_fix`
- `node.index_fix`
- `crypto.masterSeed_fix`
- peer node indexes

## Dependencies

Install in the project root:

```bash
npm install
```

Important packages:

- `@noble/curves`
- `bitcoinjs-lib`
- `tiny-secp256k1`

`bitcoinjs-lib` and `tiny-secp256k1` are used for:

- Taproot address validation
- transaction construction
- `BIP341` sighash generation
- witness finalization

## Start The System

Run all three nodes in separate terminals:

```bash
node v1/three-headed-bot.js v1/node-1.config.json
node v1/three-headed-bot.js v1/node-2.config.json
node v1/three-headed-bot.js v1/node-3.config.json
```

Or:

```bash
npm run v1:start -- v1/node-1.config.json
```

At startup each bot:

- loads config
- loads its Telegram username through `getMe`
- starts HTTPS peer server
- starts peer health loop
- starts round cleanup loop
- starts Telegram polling
- sends a startup message into the Telegram group
- sends a help message with all supported commands

## Telegram Rules

Commands must be addressed to a specific bot:

```text
/create@bank_node_1_bot
```

The bot ignores:

- private chats
- other groups
- commands addressed to another bot

## Supported Commands

### Create Address

Personal:

```text
/create@bot
```

Group:

```text
/create@bot <user_id2> <user_id3>
```

The first create requires all three nodes online.

If the address already exists in local storage, the bot returns the cached address.

### Show Addresses

```text
/address@bot
```

Shows:

- personal address of the caller if present
- every group address where the caller is listed in `memberUserIds`

### Show Balance

For all addresses relevant to the caller:

```text
/balance@bot
```

Shows:

- personal balance
- balances of all group addresses where the caller participates

For an arbitrary address:

```text
/balance@bot <address>
```

### Check UTXO

```text
/utxo@bot
```

This currently checks only the caller's personal address.

Group UTXO inspection is intentionally not exposed through `/utxo`.

### Peer Status

```text
/status@bot
```

Shows peer state:

- `up`
- `down`
- `unknown`

### Sign Plain Message

Personal:

```text
/sign@bot <message>
```

Group:

```text
/multisign@bot <user_id2> <user_id3> <message>
```

### Sign 32-Byte Hash

Personal:

```text
/signhash@bot <32-byte-hex-hash>
```

Group:

```text
/multisignhash@bot <user_id2> <user_id3> <32-byte-hex-hash>
```

### Send Bitcoin

Personal:

```text
/send@bot <to_address> <amount_sats> <fee_rate>
```

Group:

```text
/multisend@bot <user_id2> <user_id3> <to_address> <amount_sats> <fee_rate>
```

Arguments:

- `to_address`: recipient Bitcoin address
- `amount_sats`: amount in sats
- `fee_rate`: fee in `sat/vB`

Special case:

- if `amount_sats = 0`, the system sends all available funds and subtracts the fee from the total

### Approval Commands

```text
/approve@bot
/reject@bot
```

Rules:

- personal mode:
  - approval is expected from the initiating user
  - reject is allowed

- group mode:
  - approval is expected from one of the two additional user IDs from the command
  - reject is not used
  - timeout aborts the request

## Approval Flow

The following commands require approval before the second signer releases its partial signature:

- `/sign`
- `/signhash`
- `/send`
- `/multisign`
- `/multisignhash`
- `/multisend`

Personal mode:

1. User sends command to one bot.
2. That bot becomes coordinator.
3. Coordinator chooses the second signer.
4. Second signer posts approval request in Telegram.
5. The same user sends `/approve@that_bot` or `/reject@that_bot`.
6. If approved, second signer sends its partial signature.

Group mode:

1. Initiator sends a multi-command.
2. One bot becomes coordinator.
3. One second signer is selected.
4. Second signer posts approval request in Telegram.
5. The approval message explicitly lists which two Telegram IDs may approve.
6. Any one of those two users may send `/approve@that_bot`.
7. Reject is not used in group mode.
8. If no approval arrives before timeout, the request is aborted.

## Determinism

Personal address derivation depends on:

- caller Telegram user ID
- node master seeds
- fixed protocol parameters

Group address derivation depends on:

- sorted triple of member user IDs
- node master seeds
- fixed protocol parameters

Databases are caches, not the ultimate source of truth.

If databases are removed and the `_fix` fields stay unchanged:

- running `create` again reproduces the same address

## Runtime State

Persistent state:

- stored user records
- stored group records
- local share material

Stored under:

- `v1/data/`

In-memory only:

- active rounds
- pending approvals
- round timers

Important limitation:

- pending approvals are not restored after process restart

## Peer Communication

Nodes communicate via HTTPS.

Each node is both:

- server
- client

Each node:

- listens on its configured interface and port
- accepts requests only from peer IPs from config
- periodically pings the other two nodes

Telegram group messages do not expose peer IP addresses.

Peer details stay in console logs only.

## Bitcoin Providers

Bitcoin provider configuration lives in `bitcoin.providers`.

Current provider type:

- Esplora-style HTTP API

How providers are used:

- `/balance` checks all configured providers
- `/utxo` checks all configured providers
- `/send` and `/multisend` choose two providers at random
- consistency is checked where needed
- broadcast succeeds if at least one selected provider accepts the transaction

On successful send the bot prints:

- local txid
- returned txid from each selected provider
- amount
- fee
- input count
- signing set

## Send Pipeline

The send pipeline currently does the following:

1. Validate destination address and fee arguments.
2. Load UTXOs from Bitcoin providers.
3. Check provider consistency.
4. Build Taproot spend candidate.
5. Support multiple inputs if needed.
6. Compute one `BIP341` sighash per input.
7. Run threshold signing per input.
8. Finalize witness.
9. Broadcast final raw transaction.

Supported:

- Taproot key-path spend
- multi-input selection
- send-all mode

Not supported:

- script-path Taproot spend
- PSBT import/export
- advanced coin selection policy
- multiple recipients in one command

## Timeout And Cleanup

The system has:

- round timeout from `runtime.roundTtlMs`
- cleanup loop
- blocking of new active sign rounds for the same user or group until the current one finishes or aborts

If approval is not received in time:

- the round is aborted
- pending approval is removed
- active round key is released

## Test Checklist

### 1. Start The Three Nodes

```bash
node v1/three-headed-bot.js v1/node-1.config.json
node v1/three-headed-bot.js v1/node-2.config.json
node v1/three-headed-bot.js v1/node-3.config.json
```

### 2. Personal Create

```text
/create@bank_node_1_bot
/address@bank_node_1_bot
/balance@bank_node_1_bot
```

### 3. Personal Sign

```text
/sign@bank_node_1_bot hello world
/signhash@bank_node_1_bot 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
```

Approve from the second signer bot that requested approval.

### 4. Group Create

```text
/create@bank_node_1_bot 111111111 222222222
/address@bank_node_1_bot
/balance@bank_node_1_bot
```

### 5. Group Sign

```text
/multisign@bank_node_1_bot 111111111 222222222 hello
/multisignhash@bank_node_1_bot 111111111 222222222 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
```

Approve from one of the two listed Telegram user IDs.

### 6. Personal Or Group Send

Examples:

```text
/send@bank_node_1_bot bc1p... 15000 3
/send@bank_node_1_bot bc1p... 0 3
/multisend@bank_node_1_bot 111111111 222222222 bc1p... 15000 3
```

## Troubleshooting

`sign already in progress`

- wait for timeout
- finish the current approval flow
- if necessary restart the node and inspect console logs

`no address ... run create first`

- run personal `create`
- or group `create` with two additional user IDs

`bitcoin providers inconsistent`

- providers returned different UTXO views
- retry later
- or replace a bad provider

`all bitcoin providers unavailable`

- check internet access
- check provider URLs in configs

No approval message appears:

- check that the command was addressed to the correct bot
- check that all signer nodes are running
- check `/status@bot`

## Current Scope

This repository now intentionally contains only the active `v1` implementation.

Legacy root-level demo scripts and file-based signing examples were removed.
