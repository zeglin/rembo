# ADR-0005: Cryptography

- Status: proposed
- Date: 2026-10-20
- Research: docs/research/platform.md (crypto libraries)

## Decision

### Primitives and libraries (no native modules, no home-made crypto)

| need | primitive | implementation |
| --- | --- | --- |
| content encryption | XChaCha20-Poly1305 (24-byte random nonce) | `@noble/ciphers` (audited by Cure53, pure JS, ~3 KB) |
| phrase -> key | Argon2id (RFC 9106) | `node:crypto.argon2` (Node >= 24.7) else `hash-wasm` (WASM, bundled), same output; feature-tested at runtime |
| key derivation | HKDF-SHA-256 | `node:crypto` |
| signatures | Ed25519 | `node:crypto` (`sign(null, ...)`) |
| key agreement (device link, later) | X25519 | `node:crypto` |
| random | CSPRNG | `node:crypto.randomBytes` |
| recovery phrase | BIP-39 English wordlist, 12 words / 128 bits | `@scure/bip39` (audited) |

Byte compatibility with libsodium's `crypto_aead_xchacha20poly1305_ietf` and
`crypto_pwhash` (Argon2id) is checked with test vectors in CI (libsodium only
as a dev dependency). libsodium-wrappers itself is not shipped: ~290 KB, and
Argon2 only in the larger "sumo" build.

### Keys

- `VK` vault key: 32 random bytes, identified by `kid` (random 8 bytes).
- From `VK` via HKDF: `k_enc` (content), `k_ids` (keyed ids, ADR-0004/0006).
- Recovery phrase -> Argon2id(salt = vault id ‖ random 16 B stored in the
  keyring, t=3, m=64 MiB, p=1) -> `KEK`. With 128-bit phrase entropy these
  parameters are defence in depth, not the main barrier; they are stored in
  the keyring so they can be raised later.
- **Keyring object** (on the hub, itself ciphertext): `{v, kdf params, salt,
  wrapped: [{kid, XChaCha20-Poly1305(KEK, VK)}]}`. The hub stores it like any
  object; it is useless without the phrase.

### Object envelope

```
magic "RMB1" | ver u8 | mode u8 (0 plain, 1 xchacha) | kid [8] | nonce [24] | ciphertext+tag
AAD = "rembo/obj/v1" ‖ vault_id ‖ object_id ‖ rev (u64 BE)
```

- Plaintext: the JSON object of ADR-0006, padded to a bucket (default: next
  multiple of 512 bytes, configurable; `pad: off` allowed) to blur sizes.
- The AAD binds each ciphertext to its vault, id and rev: the hub cannot swap
  objects between ids or vaults, or replay an old version under a newer rev.
- `mode 0` (encryption off, self-host only, explicit): same envelope, no
  encryption, so `rembo vault migrate` can switch modes object by object.

### Encryption on/off

`vault-config` object: `encryption: on|off` (default on; a cloud hub rejects
off). Changing it = `rembo vault migrate --encryption on|off`, which rewrites
every object and is resumable.

### Rotation

`rembo vault rotate` (after a device revocation): new `VK'`, re-encrypt every
object under `kid'`, update the keyring (wrap `VK'` with the same phrase-
derived `KEK`; optionally a new phrase). Readers accept any `kid` present in
the keyring during the rotation; old `kid` is removed at the end. Revoked
devices cannot fetch the new keyring (API access gone).

### Local secrets

`~/.rembo/device.json` and `vaults/<id>/key`: files with mode 0600 (POSIX);
on Windows they rely on the user-profile ACL. OS keychains are not used in the
MVP (no native modules; Claude Code's own secret store is undocumented and not
readable by an external CLI). The local markdown copy is plaintext anyway, so
a stronger store for the key alone would add little against a device
compromise. Documented in THREAT-MODEL.md.

## Consequences

- Two small audited dependencies in the client (`@noble/ciphers`,
  `@scure/bip39`) and one fallback (`hash-wasm`, unaudited but only used to
  derive the KEK on Node < 24.7). Everything else is `node:crypto`.
- Losing the phrase and all devices loses the vault, by design.
