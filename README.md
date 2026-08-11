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

function Chat({ address }: { address: string }) {
  const { ui, input, status, profile } = useAgentForHuman(address)

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
| `useAgentForHuman(address, sessionId?)` | the live WebSocket conversation — `ui`, `input`, `respondToApproval`, acknowledged `setSessionMode`, legacy `setMode`, `availableModes`, `modeChangePending`, `reconnect`, `reset`, `profile`, `status`, `error` |
| `useVoiceInput(options?)` | microphone capture → transcription |
| `isChatItemType` / `isEventType` | type guards that narrow a `ChatItem` by its `type` |
| `fetchAgentInfo(address)` | one-shot public agent info |
| `connect(address, options?)` from `@connectonion/react/connect` | low-level connection API |
| `generateBrowser` / `saveBrowser` / `loadBrowser` / `signBrowser` / `createSignedPayloadBrowser` | Ed25519 browser identity |
| types | `ChatItem`, `AgentInfo`, `SkillInfo`, `ApprovalMode`, `Message`, `Response`, … |

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
