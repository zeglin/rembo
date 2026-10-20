# ADR-0005: Cryptography

- Status: proposed (revised 2026-10-20 after first-principles review)
- Date: 2026-10-20

## Decision

**Only `node:crypto` (OpenSSL).** No third-party crypto dependencies, no WASM,
no native addons. OpenSSL is the most widely reviewed crypto library there is;
this satisfies "only proven libraries, no home-made crypto".

| need | choice |
| --- | --- |
| content encryption | **AES-256-GCM**, random 96-bit nonce per object, 128-bit tag |
| key derivation | HKDF-SHA-256 |
| hashing / ids | SHA-256, HMAC-SHA-256 |
| randomness | `crypto.randomBytes` |

Why AES-256-GCM over (X)ChaCha20-Poly1305: both are in `node:crypto`, but only
AES-GCM is also in WebCrypto (`crypto.subtle`), which mods and browsers have,
so the same envelope can later be read by a mod or a web panel with no
library. Random 96-bit nonces are safe far beyond rembo's scale (collision
risk stays negligible below ~2^32 objects per key; vaults hold thousands).

**No Argon2, no word list.** Slow KDFs protect low-entropy, human-chosen
secrets. rembo's recovery key is 256 random bits, so HKDF is sufficient.

### Keys

- **Vault key `VK`**: 32 random bytes with an id `kid`. HKDF gives `k_enc`
  (content) and `k_ids` (keyed ids for dedup, ADR-0004).
- **Recovery key**: 32 random bytes, generated on the first device, shown once
  as `RK-` + base32 groups + checksum (e.g. for a password manager), never
  stored by rembo, never sent anywhere.
- **Keyring object** (on the hub, encrypted): `VK` wrapped with
  `HKDF(recovery key)` via AES-256-GCM. A new device downloads the keyring and
  unwraps it with the recovery key. Devices store `VK`, not the recovery key.

### Envelope

```
"RMB1" | mode u8 (0 = plaintext, 1 = aes-256-gcm) | kid [8] | nonce [12] | ciphertext | tag [16]
AAD = "rembo/obj/v1" || vault_id || object_id
```

Objects are immutable (ADR-0004), so binding the id is enough: the hub
cannot move a ciphertext to another id or vault. Plaintext is padded to the
next 512 bytes by default (`pad: off` allowed) to blur sizes.

### Encryption on/off

Per-vault setting stored in a `vault-config` object (newest wins); default on;
a cloud hub refuses `off`. `rembo vault migrate` re-uploads everything under
the new mode as new objects and tombstones the old ones.

### Rotation (after revoking a device)

`rembo vault rotate`: new `VK'`, re-encrypt all live entries as new objects,
tombstone the old ones, publish a new keyring (same recovery key; optionally
a new one). Revoked devices lose API access and never see `VK'`. Built in
Etap 6.

### Local secrets

`~/.rembo/config.json` (device token) and `vaults/<id>/key`: mode 0600 on
POSIX, user-profile ACL on Windows. No OS keychain in the MVP (would need
native code). The local markdown copy is plaintext anyway, so a stronger store
for the key alone adds little against a compromised device
(THREAT-MODEL.md).

## Consequences

- Zero crypto dependencies; works on any Node >= 22 (and in WebCrypto).
- Losing the recovery key and all devices loses the vault, by design.
