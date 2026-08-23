# Changelog

## 0.4.2-rc.0 — 2026-08-23

### Added

- Preserve Core's normalized managed-usage fields, including uncached input,
  cache reads, cache writes and TTL classes, cache reporting status, provider
  identity, and the server pricing metadata used for the final charge.

### Release boundary

- This is the first coordinated React release candidate for ConnectOnion
  `1.7.0rc1`; stable npm `latest` remains `0.4.1`.
- Publish through the protected tag workflow under the npm `rc` dist-tag.
- O Chat must pin this exact package and repeat the installed Core, real
  `co ai`/`co browser`, Work Room, reconnect, and UI-review gate before 1.7
  can be promoted unchanged.

## 0.4.2-beta.0 — 2026-08-21

### Changed

- Expose only `read-only`, `auto`, and bounded `full-access` through `Mode`,
  `mode`, `turnsLeft`, `availableModes`, and `setSessionMode()`.
- Default fresh and unknown persisted state to Auto without translating old
  permission aliases into current authority.
- Remove collaboration/Plan mode, execution-profile, permission-profile, YOLO,
  ULW, and checkpoint compatibility surfaces.
- Validate the byte-identical Core fixture at
  `tests/fixtures/oip/mode-contract-v1.json` before React consumes Host state.

## 0.4.2-alpha.15 — 2026-08-17

Truthful current-state evidence for native Codex and Claude Code Work Rooms.

### Added

- Carry a positive, per-invocation `stateRevision` through the normalized
  provider lifecycle and require a Stop acknowledgement to prove the exact
  revision it accepted.
- Accept an optional `provider_artifact` only when it is a bounded PNG/JPEG
  raster for the same current lifecycle revision; expose it as a typed
  `ProviderArtifact` rather than a provider URL or text payload.

### Fixed

- Preserve a newer locally rendered provider state over an older reconnect
  snapshot, so stale activity cannot revive Stop or approval controls.
- Revalidate nested reconnect artifacts before exposing them to React consumers;
  missing, stale, oversized, or non-raster previews disappear safely.

### Release boundary

- This remains an OIP-only preview addition. Core and O Chat must upgrade as a
  reader-before-writer pair before enabling a Host screenshot producer.
- Publish under the npm `alpha` dist-tag; stable `latest` remains `0.4.1`.
- O Chat will pin `0.4.2-alpha.15` after the published artifact is available
  and repeat the long native-provider Work Room acceptance flow.

## 0.4.2-alpha.14 — 2026-08-17

Truthful stop requests for native Codex and Claude Code Work Rooms.

### Fixed

- Make `interruptProvider()` send a request-scoped `PROVIDER_INTERRUPT` frame
  and resolve only after the Host acknowledges that exact invocation.
- Reject a stop request on a Host refusal, invalid request, timeout, reset, or
  connection loss, so consumers can restore a clear retry action instead of
  being stuck in an optimistic stopping state.
- Keep the provider's terminal lifecycle event as the only authoritative
  completion/cancellation signal; an acknowledgement says only that delivery
  was accepted.

### Release boundary

- This remains an OIP-only protocol addition with a bounded legacy fallback for
  a rolling Host deployment.
- Publish under the npm `alpha` dist-tag; stable `latest` remains `0.4.1`.
- O Chat must pin `0.4.2-alpha.14` exactly and verify accepted and rejected
  Stop requests in a long native-provider Work Room.

## 0.4.2-alpha.10 — 2026-08-16

Rolling-deployment fix for OIP endpoint discovery.

### Fixed

- Opt every Relay agent lookup and direct `/info` probe out of the browser HTTP
  cache, complementing the Host's `Cache-Control: no-store` response header.
- Prevent a stale endpoint or protocol descriptor from being replayed after a
  frontend or Host deployment and driving a client into a reconnect loop.
- Cover all four discovery calls used by `resolveEndpoint()` and
  `fetchAgentInfo()` with exact request-option assertions.

### Release boundary

- This is a reader-first, additive client change and remains compatible with
  descriptor-less OIP 0.1 Hosts during the bounded rolling window.
- Publish under the npm `alpha` dist-tag; stable `latest` remains `0.4.1`.
- O Chat must pin `0.4.2-alpha.10` exactly before the next Host preview and can
  roll back to `0.4.2-alpha.9` without changing the OIP 0.1 wire contract.

## 0.4.2-alpha.7 — 2026-08-16

Production recovery for relay sessions whose browser socket remains open after
the Host has lost its authentication context.

### Fixed

- Treat the explicit Host response `authenticate first (send CONNECT)` as proof
  that the rejected INPUT was not accepted, reconnect, and resend that INPUT
  exactly once.
- Keep the original input promise and optimistic transcript item across that
  recovery, so the UI neither reports a false terminal error nor duplicates the
  user turn.
- Stop after one automatic recovery attempt; a second authentication rejection
  remains visible and retryable instead of looping.

### Release boundary

- OIP remains the sole browser transport.
- Publish under the npm `alpha` dist-tag; stable `latest` remains `0.4.1`.
- O Chat must pin `0.4.2-alpha.7` exactly and repeat the live first-input and
  Codex Work Room acceptance against production.

## 0.4.2-alpha.6 — 2026-08-16

Production-blocker follow-up for the OIP browser lifecycle and interactive
coding-agent Work Rooms.

### Fixed

- Commit authenticated connection state before resolving `CONNECTED` or
  notifying route subscribers, closing the landing-to-session handoff race that
  could send the first post-onboarding input before the session was ready.
- Remove optimistic thinking state on terminal Host errors so consumers cannot
  remain visibly busy after an error.
- Add `retry()` to resend a failed turn without appending a duplicate user
  transcript item.

### Release boundary

- OIP remains the sole browser protocol; this release adds no alternate
  transport or compatibility path.
- Publish under the npm `alpha` dist-tag; stable `latest` remains `0.4.1`.
- O Chat must pin `0.4.2-alpha.6` exactly and verify invite → first input,
  terminal errors, Codex cards, and desktop/mobile Work Rooms before production.

## 0.4.2-alpha.3 — 2026-08-14

Security and consumer follow-up for React-owned identity and Turbopack
route-module isolation.

### Security

- Replace the default clear-text browser private-key record with a
  non-extractable Ed25519 `CryptoKey` persisted through IndexedDB.
- Migrate a validated legacy `localStorage['connectonion_keys']` identity to the
  same address, deleting the old record only after the secure write signs and
  verifies successfully.
- Return recovery material only from the first create/migrate caller. Recovery
  phrases and raw private keys are never persisted by the new API.
- Restore the previous stored identity when an explicit create/import
  replacement fails verification or legacy cleanup.
- Route legacy WebSocket, native ACP ticket admission, onboarding, and
  transcription through one async signer boundary.

### Fixed

- Share one versioned live-agent registry across browser module evaluations, so
  landing and session routes reuse the same warmed agent and native ACP session.
- Keep SSR and incompatible global values module-local instead of sharing state
  across requests or trusting a foreign registry shape.
- Preserve the bounded LRU, explicit drop/clear behavior, and a non-overwritable
  browser registry property.
- Expose explicit ESM runtime exports for modern bundlers and use a browser-native
  BIP39 implementation that does not require Node `Buffer`.

### Compatibility

- `generateBrowser`, `signBrowser`, and `createSignedPayloadBrowser` remain
  explicit in-memory raw-key helpers. Unsafe synchronous `saveBrowser` and
  `loadBrowser` exports are removed.
- `signOnboard()` is asynchronous because a non-extractable WebCrypto key signs
  through `SubtleCrypto`.

### Release boundary

- Publish under the npm `alpha` dist-tag; stable `latest` remains `0.4.1`.
- O Chat should pin `0.4.2-alpha.3` exactly and validate both Turbopack development
  and production builds before release.
- Rollback remains an exact dependency change to `0.4.2-alpha.2` or stable
  `0.4.1`; the retired standalone TypeScript SDK remains outside the browser path.

## 0.4.2-alpha.2 — 2026-08-13

Consumer-validated follow-up for route handoff and connection recovery.

### Fixed

- Preserve the newest `useAgentForHuman` subscription when an older overlapping
  route owner unmounts.
- Keep `checkSessionStatus()` observational so polling cannot silently reconnect
  the owned transport or hide an explicit disconnected state.

### Release boundary

- Publish under the npm `alpha` dist-tag; stable `latest` remains `0.4.1`.
- O Chat should pin `0.4.2-alpha.2` exactly after publication.
- Rollback remains an exact dependency change to `0.4.1`; the retired standalone
  TypeScript SDK remains outside the browser path.

## 0.4.2-alpha.1 — 2026-08-13

Follow-up preview that completes the native ACP permission-tool lifecycle.

### Fixed

- Track every permission tool created during one prompt, so sequential approval
  requests cannot leave an earlier card permanently `running`.
- Preserve an official Host terminal tool update; otherwise fail each unresolved
  permission tool closed at successful, cancelled, and failed prompt boundaries.
- Clear stale transport errors after a successful reconnect and propagate the
  cleared state through `useAgentForHuman`.

### Release boundary

- Publish under the npm `alpha` dist-tag; stable `latest` remains `0.4.1`.
- O Chat should pin `0.4.2-alpha.1` exactly after publication.
- Rollback remains an exact dependency change to `0.4.1`; the retired standalone
  TypeScript SDK remains outside the browser path.

## 0.4.2-alpha.0 — 2026-08-13

Alpha preview of the React-owned authenticated native ACP browser lifecycle.

### Added

- Exact, non-cacheable `/info` transport discovery followed by signed browser
  ticket admission and the official ACP SDK WebSocket transport.
- ACP initialize, session create/resume/close, prompt streaming, permission,
  cancellation, and acknowledged permission-mode transactions.
- Browser-safe native session persistence with virtual `cwd: "/"`, no Host
  paths, and `mcpServers: []`.
- Text, image, and embedded-file prompt conversion based on negotiated Agent
  capabilities.
- Invite/payment onboarding that pauses and resumes the original prompt once,
  plus stable message/thought chunk accumulation.

### Fixed

- Bind captured browser `fetch` to the real global receiver so Chromium can
  complete signed native admission without an `Illegal invocation` error.
- Create or reuse the stable running tool card when native ACP sends a
  permission request before its tool update, keeping O Chat's inline approval
  controls visible without adding protocol logic to the product UI.
- Fail an unresolved permission tool card at the prompt boundary instead of
  claiming success or leaving the consumer UI permanently running.

### Security and compatibility

- Native ACP is selected only from the exact supported discovery descriptor.
  Admission, TLS, Origin, initialize, session, and prompt failures fail closed
  and never open the legacy transport.
- Only a non-cacheable JSON `403 forbidden:` response can enter the retryable
  onboarding gate. Tickets, connection IDs, session IDs, and ACP metadata never
  grant authority.
- Modern ESM imports register native ACP. Existing CommonJS `require()`
  consumers retain the bounded legacy compatibility path. Exact descriptor
  absence remains the direct legacy signal during this preview.
- Publish this version under the npm `alpha` dist-tag; stable `latest` remains
  `0.4.1`. O Chat should pin `0.4.2-alpha.0` exactly while validating it.
- Rollback changes only the consumer dependency back to `0.4.1`; the retired
  standalone TypeScript SDK is not part of either path.

## 0.4.1 — 2026-08-12

- Separate Codex-aligned `default` / `plan` collaboration modes from Host
  permission profiles `:read-only`, `:workspace`, and
  `:danger-full-access`.
- Add explicit `setCollaborationMode()` and acknowledged
  `setPermissionProfile()` APIs. The deprecated synchronous `setMode()` can no
  longer fabricate permission state or write the legacy Host frame.
- Keep the standalone TypeScript SDK retired; React remains the browser
  protocol owner and accepts previous IDs only at its compatibility reader.

## 0.4.0 — 2026-08-12

This release makes `@connectonion/react` the browser's ACP ownership boundary. The
standalone TypeScript SDK is not required by React consumers.

### Added

- Versioned ACP agent-message and tool-call notification decoding.
- Host permission requests with exact request/session correlation and duplicate safety.
- Host-advertised session modes through `availableModes`.
- Acknowledged `setSessionMode` transactions and `modeChangePending` UI state.
- ACP cancellation when the Host advertises it.
- Host-supplied thoughts normalized as stable `thinking` items. The ConnectOnion
  Host profile publishes only persisted, already-visible application thoughts;
  React cannot classify text supplied by third-party Hosts.
- Session-scoped, complete-replacement ACP plan state through
  `useAgentForHuman().plan`, including reconnect persistence and empty clearing.

### Security and compatibility

- The Host's permission request identity remains authoritative; display labels cannot
  rewrite the value returned over ACP.
- Mode changes fail closed on unsupported modes, Host rejection, malformed responses,
  wrong-session responses, timeout, and disconnect.
- `plan` remains available only in the legacy product `ApprovalMode`; it is excluded from
  `ServerApprovalMode` and is never serialized as ACP policy.
- Legacy `setMode` remains deprecated for source compatibility. New consumers should use
  `setSessionMode` and must not author ACP frames themselves.
- ACP plan state is read-only progress information. It is separate from interactive
  `plan_review` approval and cannot authorize implementation.

Publication remains tag-driven: merging release metadata alone does not publish the
package.
