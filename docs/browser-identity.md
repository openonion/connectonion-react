# Browser identity: non-extractable WebCrypto keys

- Status: Accepted for the next Alpha
- Date: 2026-08-14
- Owner: `@connectonion/react`
- Tracking: [issue #51](https://github.com/openonion/connectonion-react/issues/51)

## Context

ConnectOnion browser clients sign legacy WebSocket and native ACP admission with
an Ed25519 identity. The old implementation serialized the private key as hex in
`localStorage['connectonion_keys']`; O Chat also stored its recovery phrase in
that record. Any script running on the origin, browser-storage export, or copied
profile could read a durable reusable private key.

The package boundary is already settled: `@connectonion/react` owns browser
identity and protocol behavior. O Chat is a consumer, and the standalone
TypeScript SDK is not part of this browser path.

## Security goal and limit

The Alpha must stop persisting exportable private bytes or recovery phrases in
Web Storage. Copying ordinary origin key/value data must not reveal a reusable
private key.

This decision does not claim that WebCrypto makes a compromised origin safe.
Injected same-origin JavaScript can request signatures while it runs and may be
able to transfer a `CryptoKey` handle through structured clone. CSP, dependency
review, opaque-origin isolation for untrusted documents, and XSS prevention are
separate required controls.

## Decision

1. React owns one asynchronous `MessageSigner` boundary used by legacy
   WebSocket CONNECT, native ACP ticket authorization, onboarding, and
   transcription.
2. A browser identity derives Ed25519 from a BIP39 recovery phrase, imports the
   32-byte seed into WebCrypto as `extractable: false`, and stores the resulting
   private `CryptoKey` in a dedicated IndexedDB database.
3. The record contains only the non-extractable key, public key, address, and a
   schema version. It contains no phrase or raw private bytes.
4. Creation and migration return recovery material to the first caller once.
   If an internal default connection is that caller, it retains the value only
   in module memory for one explicit `claimPendingBrowserRecovery()` handoff.
   Later callers receive only the identity.
5. A legacy record is parsed strictly: address, public key, private key, and an
   optional phrase must all describe the same Ed25519 key pair.
6. Migration uses create-if-absent semantics, reloads the stored key, signs a
   probe, verifies it against the public key, and only then removes the legacy
   record. A failure preserves the old recovery path.
7. Concurrent initializers converge on the one IndexedDB record that wins the
   add transaction. A losing creator discards its unused phrase.
8. Explicit create/import replacements snapshot the current stored record and
   become visible only after read-back signing verification and legacy cleanup.
   A failed replacement restores the snapshot (or deletes an unverified first
   candidate); a failed rollback surfaces a corruption error instead of
   reporting success.
9. Missing WebCrypto Ed25519 or IndexedDB support fails with an actionable error.
   There is no clear-text fallback.
10. Raw-key helpers remain explicit in-memory compatibility tools. They do not
   load or save browser storage.

WebCrypto explicitly expects serializable `CryptoKey` objects to be persisted by
storage such as IndexedDB without exposing key material to JavaScript. See
[WebCrypto key storage](https://www.w3.org/TR/WebCryptoAPI/#key-storage), the
[IndexedDB structured-storage model](https://www.w3.org/TR/IndexedDB/), and
[OWASP's Web Storage guidance](https://cheatsheetseries.owasp.org/cheatsheets/HTML5_Security_Cheat_Sheet.html#local-storage).

## Alternatives

### Keep localStorage and rely on CSP

Rejected. CSP reduces injection opportunities but does not make a raw permanent
credential appropriate for JavaScript-readable key/value storage.

### Encrypt the key with another browser-stored key

Rejected. If ordinary origin JavaScript can read both the ciphertext and its
decryption material, the design adds machinery without removing the
exfiltration path.

### Use WebAuthn as the ConnectOnion signer

Rejected for this protocol version. WebAuthn signs authenticator and client-data
structures scoped to an RP; it does not emit the raw Ed25519 detached signature
required by the current ConnectOnion envelope. WebAuthn may later protect an
unlock or wrapping key if the UX and compatibility cost is accepted.

### Sign on an O Chat server

Rejected as the SDK default. Server custody changes the self-owned browser
identity model, centralizes compromise, and does not serve other React clients.

## Consequences

- Identity load and signing are asynchronous. `signOnboard()` therefore returns
  a Promise.
- The phrase cannot be exported again after the one-time handoff. Losing it means
  replacing the identity.
- O Chat must delete its duplicate BIP39/tweetnacl implementation, keep JWTs out
  of persistent Zustand state, and use this package's identity API.
- Existing users keep the exact same address and Ed25519 signature behavior.
- Tests need deterministic store/crypto seams plus a real-browser migration and
  reload exercise before publication.

## Revisit when

- the ConnectOnion wire protocol supports authenticator-backed signatures;
- browser support permits a portable hardware-backed unlock without silently
  excluding supported clients;
- identity sync across devices becomes a product requirement; or
- evidence shows the current non-extractable IndexedDB model does not provide
  the intended at-rest protection in target browsers.
