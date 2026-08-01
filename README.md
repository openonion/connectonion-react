# @connectonion/react

React hooks for [ConnectOnion](https://docs.connectonion.com) agents.

```bash
npm install @connectonion/react connectonion
```

`connectonion` and `react` are peer dependencies — you install them yourself, so this
package can never pull in a second copy of either.

## Why it is a separate package

The hooks used to live at `connectonion/react`. That forced a `react` peer, a `zustand`
runtime dependency, and jsdom/testing-library devDependencies onto every consumer of the
SDK — including Node and Electron apps that never render a component. It also tied the two
to one release cadence: a hook fix meant republishing the whole SDK.

Split, the core package stays runtime-agnostic and the hooks ship on their own schedule.

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
| `useAgentForHuman(address, sessionId?)` | the live WebSocket conversation — `ui`, `input`, `sendMessage`, `setMode`, `reconnect`, `reset`, `profile`, `status`, `error` |
| `useVoiceInput(options?)` | microphone capture → transcription |
| `fetchAgentInfo(address)` | one-shot public agent info (re-exported from the core package) |
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

The API is unchanged. `connectonion/react` still works in the 0.2.x line and is removed in 0.3.0.

## License

MIT
