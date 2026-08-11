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
| `useAgentForHuman(address, sessionId)` | the live WebSocket conversation — `ui`, read-only `plan`, `input`, `respondToApproval`, acknowledged `setSessionMode`, legacy `setMode`, `availableModes`, `modeChangePending`, `reconnect`, `reset`, `profile`, `status`, `error` |
| `useVoiceInput(options?)` | microphone capture → transcription |
| `isChatItemType` / `isEventType` | type guards that narrow a `ChatItem` by its `type` |
| `fetchAgentInfo(address)` | one-shot public agent info |
| `connect(address, options?)` from `@connectonion/react/connect` | low-level connection API |
| `generateBrowser` / `saveBrowser` / `loadBrowser` / `signBrowser` / `createSignedPayloadBrowser` | Ed25519 browser identity |
| types | `ChatItem`, `AgentInfo`, `SkillInfo`, `ApprovalMode`, `Message`, `Response`, … |

## Session modes

The authenticated Host advertises the complete policy set. Render only
`availableModes`, keep controls disabled while `modeChangePending` is true, and await
`setSessionMode` before presenting the new policy:

```tsx
const {
  mode,
  availableModes,
  modeChangePending,
  setSessionMode,
} = useAgentForHuman(address, sessionId)

await setSessionMode('accept_edits')
```

`setSessionMode` owns ACP request IDs, session correlation, acknowledgement validation,
timeouts, and disconnect handling. It rejects without changing `mode` when the Host
refuses or the outcome is unknown. `plan` is not a server policy and is never accepted by
this API; products may layer a Plan workflow over an acknowledged Host `safe` mode.

The old `setMode(mode, { turns })` remains temporarily for source compatibility but is
optimistic and deprecated. New React applications must not use it or construct ACP frames.

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

## License

MIT
