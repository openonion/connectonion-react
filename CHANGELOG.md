# Changelog

## Unreleased

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
