# Security model

What pumpvault protects, what it does not, and why each choice was made.

## The short version

Your private keys are generated in your browser, encrypted with your passphrase, and stored in that browser's local storage. They are never transmitted. Transactions are signed locally and posted straight to Jito's block engine. The server never sees a key and has nothing to steal.

That means: no server breach can take your funds, and no operator can freeze or seize them. It also means nobody can recover a lost passphrase or restore a cleared browser. **Back up every private key.**

## How keys are stored

| Step | Mechanism |
| --- | --- |
| Generation | `Keypair.generate()`, which uses `crypto.getRandomValues` |
| Key derivation | PBKDF2-SHA256, 310,000 iterations, 16-byte random salt per blob |
| Encryption | AES-256-GCM, 12-byte random IV per blob |
| Storage | `localStorage`, ciphertext only |
| In use | Decrypted into memory while the vault is unlocked |

Every encryption draws a fresh salt and IV, so the same key encrypted twice produces different ciphertext. GCM is authenticated, so a tampered blob fails to decrypt rather than yielding garbage bytes.

## The session cache, stated plainly

pumpvault is four separate pages. Without a cache, every navigation would drop the in-memory keys and re-prompt for the passphrase, which trains people to type it constantly and pick a weaker one.

So an unlocked vault writes the passphrase to `sessionStorage`:

- **Scoped to the tab.** Closing it discards the cache. Other tabs and windows do not share it.
- **Expires after 15 minutes** with no pointer or keyboard activity; a background timer locks the vault when it lapses.
- **Cleared by Lock**, immediately.

The tradeoff: while a tab is open and unlocked, the plaintext passphrase exists in that tab's `sessionStorage`. Code running in the page could read it. That is a real cost, accepted because code running in the page could equally read the decrypted keys already in memory. If you want the strongest posture, press Lock when you finish, or close the tab.

## What this does not protect against

- **A compromised browser or machine.** A malicious extension with access to the page, or malware on the device, can read what the page can read. Non-custodial means the keys are with you, not that they are safe from your own machine.
- **Someone with your passphrase and your device.** Both together are the whole vault.
- **A bad destination address.** Transfers on Solana are final. pumpvault shows the destination in a confirmation dialog before signing; check it.
- **Phishing.** Only use a build you deployed or a source you trust. A hostile copy of this UI can do anything a page can do. Check the URL.
- **A key that has already leaked.** Rescue moves what is currently in the wallet. It cannot protect funds sent to that address afterwards. Once a key is exposed, it is exposed permanently.

## Why rescues need a second wallet

A sweeper bot watching a compromised address will take any SOL that lands, usually within a block. The intuitive fix, sending gas to the wallet so it can move its own funds, hands the bot the gas.

The rescue flow avoids the race entirely:

1. A **clean funder wallet** is the fee payer and pays the Jito tip.
2. The **compromised wallet only signs**; it never needs a balance to pay a fee.
3. Collect, drain, and token transfers ride in **one bundle** that lands atomically.

There is no intermediate state in which the exposed wallet holds a balance a bot could take. If the bundle does not land, nothing moved and only the network fee was spent.

## What the server can see

`server/index.mjs` proxies three things: JSON-RPC calls, pump.fun API reads, and the IPFS upload for coin metadata. It therefore sees the addresses you look up and the images you upload, the same way any RPC provider does. It never sees a private key, a passphrase, or a signed transaction; those go from your browser to Jito directly.

If you self-host, that log is yours. If you use someone else's deployment, you are trusting them with that metadata and with serving honest JavaScript.

## Reporting a vulnerability

Open a security advisory on [the repository](https://github.com/nirholas/pumpvault/security/advisories). Please do not file a public issue for anything that could put funds at risk.
