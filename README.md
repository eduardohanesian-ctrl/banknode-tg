# BankNode TG

Telegram-controlled 2-of-3 threshold wallets for Bitcoin and Ethereum,
implemented as two independent Node.js applications with a common operational
model.

Three cooperating signer nodes jointly create wallet addresses and authorize
signatures. Any two nodes can complete a signing operation, while no node stores
or reconstructs the complete private key.

> **Experimental software:** neither implementation should be treated as
> production custody software without an independent security audit, hardened
> deployment, protected key-share storage, and tested recovery procedures.

## Implementations

| | Bitcoin | Ethereum |
|---|---|---|
| Directory | [`Bitcoin/`](Bitcoin/) | [`Ethereum/`](Ethereum/) |
| Detailed guide | [Bitcoin README](Bitcoin/README.md) | [Ethereum README](Ethereum/README.md) |
| Signing scheme | 2-of-3 threshold Schnorr | 2-of-3 threshold ECDSA |
| Curve | secp256k1 | secp256k1 |
| Address / account type | Taproot `bc1p...` | Ethereum EOA `0x...` |
| Transaction standard | BIP340/BIP341 Taproot key-path spend | EIP-1559 transaction |
| Assets | Native BTC | Native ETH, arbitrary ERC-20 tokens, Mainnet USDT aliases |
| Network backend | Multiple Esplora-style providers | Multiple Ethereum JSON-RPC providers with failover |
| Send-all convention | `amount_sats = 0` | `amount_wei = 0` |

The implementations share their user-facing structure, but they do **not** use
the same threshold-signing protocol internally. Bitcoin produces BIP340 Schnorr
signatures for Taproot. Ethereum produces standard recoverable low-S ECDSA
signatures suitable for EOAs and EVM transactions.

## Shared operating model

Each implementation runs exactly three services:

- `node-1`
- `node-2`
- `node-3`

Every service has its own Telegram bot, peer server, configuration, master seed,
and persistent local share material. A command may be sent to any one of the
three bots; that node becomes the coordinator and completes the operation with
one available peer signer.

Both implementations provide:

- deterministic personal wallets derived from a Telegram user ID;
- deterministic group wallets derived from three Telegram user IDs;
- distributed address creation without assembling the private key;
- 2-of-3 threshold message, digest, and transaction signing;
- Telegram approval before the second signer releases its contribution;
- personal and group balance reporting;
- peer health checks, request timeouts, and cleanup of incomplete rounds;
- HTTP(S) communication between signer nodes;
- configuration-file-based secrets and runtime settings.

Telegram commands are accepted only from the configured `allowedGroupId` and
must be addressed to a specific bot, for example:

```text
/create@banknode_1_bot
```

The complete command syntax and chain-specific behavior are documented in the
[Bitcoin guide](Bitcoin/README.md) and [Ethereum guide](Ethereum/README.md).

## Repository layout

```text
banknode-tg/
├── Bitcoin/                  # Threshold Schnorr / Taproot implementation
│   ├── README.md
│   ├── three-headed-bot.js
│   ├── crypto_backend.js
│   ├── tg_backend.js
│   └── node-1.config.example.json
└── Ethereum/                 # Threshold ECDSA / EOA / ERC-20 implementation
    ├── README.md
    ├── LICENSE
    ├── THIRD_PARTY_NOTICES.md
    ├── three-headed-bot.js
    ├── crypto_backend.js
    ├── tg_backend.js
    └── node-1.config.example.json
```

The two directories are separate npm projects. Install dependencies and run
commands from the directory of the implementation you want to use:

```bash
git clone https://github.com/eduardohanesian-ctrl/banknode-tg.git
cd banknode-tg/Bitcoin    # or: cd banknode-tg/Ethereum
npm ci
```

Then follow that directory's README for configuration and startup commands.
Do not reuse Telegram bot tokens, master seeds, databases, or peer ports between
the Bitcoin and Ethereum deployments.

## Personal and group wallets

A personal wallet is associated with one Telegram user. A group wallet is
associated with the initiator and two additional Telegram user IDs. Wallet
membership determines which addresses are shown and which users may approve a
group operation.

The common command families are:

```text
/create       /address       /balance       /status
/sign         /signhash      /send
/multisign    /multisignhash /multisend
/approve      /reject
```

Ethereum additionally exposes ERC-20 and fixed-address Mainnet USDT commands.
Bitcoin additionally works with UTXOs, fee rates in `sat/vB`, and Taproot
key-path transaction construction.

## Security boundaries

The security goal is to prevent a single signer node from authorizing a
transaction or recovering the wallet key. That goal does not remove operational
risks around Telegram accounts, host compromise, backups, networking, RPC
providers, dependency integrity, or rollback of persisted state.

For any serious deployment:

1. Run the three signer nodes on separate machines and in separate security
   domains.
2. Use unique high-entropy master seeds and protect every node database as key
   material.
3. Restrict peer ports with network ACLs and use authenticated TLS with
   certificates from a trusted CA.
4. Pin and review dependencies and retain the supplied lock files.
5. Encrypt storage, separate backups, and test loss and disaster-recovery
   procedures.
6. Treat Telegram as an approval interface, not as the sole authentication
   factor for high-value custody.
7. Audit the exact commit and deployment configuration before storing real
   value.

## License

Commercial use of the original BankNode code is not permitted without a
separate written license from the copyright holder.

The Ethereum implementation is distributed under the
[`PolyForm-Noncommercial-1.0.0`](Ethereum/LICENSE) license. The Bitcoin
directory currently contains no separate license grant. Third-party packages
remain subject to their respective licenses and notices.
