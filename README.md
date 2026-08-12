# @connectonion/react

React hooks for [ConnectOnion](https://docs.connectonion.com) agents.

```bash
npm install @connectonion/react
```

`react` is the only peer dependency. Since `@connectonion/react@0.3.0`, the browser
connection and protocol implementation ship in this package; React applications do not
need the legacy `connectonion` TypeScript core package.

## Why it is a separate package

The hooks used to live at `connectonion/react`. They moved to a dedicated React package in
the 0.2.x line, and `@connectonion/react@0.3.0` then absorbed the browser connection layer.
That leaves React users with one supported package and one release cadence.

## Quick start

```tsx
import { useAgentForHuman } from '@connectonion/react'

function Chat({ address, sessionId }: { address: string; sessionId: string }) {
  const { ui, input, status, profile } = useAgentForHuman(address, sessionId)

  return (
    <>
      {ui.map((item, i) => <div key={i}>{item.type}: {JSON.stringify(item)}</div>)}
      <button onClick={() => input('hello')} disabled={status !== 'idle'}>send</button>
    </>
  )
}
```

## What's exported

| | |
|---|---|
| `useAgentForHuman(address, sessionId)` | the live WebSocket conversation — `ui`, `plan`, `collaborationMode`, `permissionProfile`, `setCollaborationMode`, acknowledged `setPermissionProfile`, `availablePermissionProfiles`, `permissionProfileChangePending`, `input`, `reconnect`, `reset`, `profile`, `status`, `error` |
| `useVoiceInput(options?)` | microphone capture → transcription |
| `isChatItemType` / `isEventType` | type guards that narrow a `ChatItem` by its `type` |
| `fetchAgentInfo(address)` | one-shot public agent info |
| `connect(address, options?)` from `@connectonion/react/connect` | low-level connection API |
| `createAuthenticatedACPStream(options)` from `@connectonion/react/experimental/native-acp` | preview ESM-only native ACP admission + official WebSocket stream; not yet selected by `connect()` |
| `generateBrowser` / `saveBrowser` / `loadBrowser` / `signBrowser` / `createSignedPayloadBrowser` | Ed25519 browser identity |
| types | `ChatItem`, `AgentInfo`, `SkillInfo`, `CollaborationMode`, `PermissionProfile`, `Message`, `Response`, … |

The experimental native ACP entry accepts an exact DD-046 transport descriptor and never
falls back after admission starts. Existing `connect()` and React hooks still use the legacy
transport until discovery, initialization, session lifecycle, and reconnect can switch as one
atomic change. Application UIs should continue using the hook rather than importing this
preview directly.

## Codex-style collaboration and permissions

Collaboration intent and Host permission authority are independent. Default
and Plan are local collaboration modes; Read only, Auto, and Full access are
authenticated Host permission profiles:

```tsx
const {
  collaborationMode,
  permissionProfile,
  availablePermissionProfiles,
  permissionProfileChangePending,
  setCollaborationMode,
  setPermissionProfile,
} = useAgentForHuman(address, sessionId)

setCollaborationMode('plan')
await setPermissionProfile(':workspace')
```

Render only `availablePermissionProfiles`, disable prompts while
`permissionProfileChangePending` is true, and await `setPermissionProfile`
before presenting new authority. It owns ACP request IDs, session correlation,
acknowledgement validation, timeouts, and disconnect handling. A Host refusal
or unknown outcome leaves `permissionProfile` unchanged. Plan never enters the
Host permission transaction.

`setSessionMode`, `availableModes`, and `modeChangePending` remain temporarily
as deprecated aliases. The deprecated synchronous `setMode` accepts only local
`default` / `plan`; permission values throw instead of fabricating Host state.
New applications should use the separate APIs and must not construct ACP
frames.

## Current plan

`plan` is the latest complete ACP plan snapshot for this session. It is separate from the
append-only `ui` transcript and from interactive `plan_review` approval:

```tsx
const { plan } = useAgentForHuman(address, sessionId)

return plan.length ? (
  <ol>
    {plan.map((entry, index) => (
      <li key={index}>
        {entry.content} — {entry.priority} — {entry.status}
      </li>
    ))}
  </ol>
) : null
```

Every update replaces the complete list; an empty list clears it. Entries have
`high | medium | low` priority and `pending | in_progress | completed` status. The
state is observational only: rendering it must not approve tools or authorize work.

## Sessions and storage

`useAgentForHuman` persists each session under `localStorage['co:agent:{address}:session:{id}']`,
capped at 20 sessions. Base64 data URLs are stripped before writing — images stay in memory for
the current render but never reach localStorage. When the quota is full it evicts other sessions
oldest-first and retries; if a single session still won't fit it falls back to memory-only rather
than throwing. Keys outside the `co:agent:` prefix are never touched.

## Migrating from `connectonion/react`

```diff
- import { useAgentForHuman } from 'connectonion/react'
+ import { useAgentForHuman } from '@connectonion/react'
```

The API is unchanged — same hooks, same signatures, same `localStorage` keys, so existing
sessions carry over. `connectonion/react` worked through the 0.2.x line and was removed in
`connectonion@0.3.0`.

Full hook surface: [`docs/react.md`](docs/react.md).

## Tool approvals

`respondToApproval(approved, scope, mode?, feedback?)` answers the one pending
approval. The SDK owns ACP request correlation, legacy fallback, and duplicate
suppression; React applications should not build `ACP_RESPONSE` frames or keep
JSON-RPC request IDs in component state. During a rolling upgrade, paired ACP
and legacy Host requests render as one normalized `approval_needed` item.

The same browser boundary normalizes ACP `agent_thought_chunk` updates to
`thinking` items and de-duplicates them with legacy and replayed events by their
persisted ID. The ConnectOnion Host profile sends one complete recorded thought per
message ID; it does not claim provider token streaming. The SDK decodes text explicitly
sent by the connected Host; it cannot
classify that text's origin. The ConnectOnion Host profile separately promises to map
only persisted, already-visible application `thinking` events—not provider diagnostics
or hidden model fields—to this update.

## Development

```bash
npm install
npx tsc --noEmit
npm test
npm run build
```

The test suite exercises the connection implementation bundled in this package, including
the React hooks, protocol mapping, trust checks, and browser-safe endpoint selection.
`npm run build` also imports the emitted ESM preview through the real official ACP SDK and
verifies that exactly one `/acp` socket receives the one-use ticket only as a subprotocol.

## License

MIT
