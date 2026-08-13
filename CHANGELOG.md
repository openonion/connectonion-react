# Changelog

## 0.4.2-alpha.1 — 2026-08-13

Follow-up preview that completes the native ACP permission-tool lifecycle.

### Fixed

- Track every permission tool created during one prompt, so sequential approval
  requests cannot leave an earlier card permanently `running`.
- Preserve an official Host terminal tool update; otherwise fail each unresolved
  permission tool closed at successful, cancelled, and failed prompt boundaries.

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
