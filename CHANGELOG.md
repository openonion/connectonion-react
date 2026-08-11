# Changelog

## 0.4.0 — unreleased

This release makes `@connectonion/react` the browser's ACP ownership boundary. The
standalone TypeScript SDK is not required by React consumers.

### Added

- Versioned ACP agent-message and tool-call notification decoding.
- Host permission requests with exact request/session correlation and duplicate safety.
- Host-advertised session modes through `availableModes`.
- Acknowledged `setSessionMode` transactions and `modeChangePending` UI state.
- ACP cancellation when the Host advertises it.

### Security and compatibility

- The Host's permission request identity remains authoritative; display labels cannot
  rewrite the value returned over ACP.
- Mode changes fail closed on unsupported modes, Host rejection, malformed responses,
  wrong-session responses, timeout, and disconnect.
- `plan` remains available only in the legacy product `ApprovalMode`; it is excluded from
  `ServerApprovalMode` and is never serialized as ACP policy.
- Legacy `setMode` remains deprecated for source compatibility. New consumers should use
  `setSessionMode` and must not author ACP frames themselves.

Publication is intentionally separate: merging the release-preparation PR does not tag or
publish the package.
