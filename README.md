# @connectonion/react

React hooks and browser primitives for ConnectOnion agents over OIP.

The package owns the browser connection end to end: OIP endpoint discovery,
the authenticated `/ws` session, browser identity, reconnect and onboarding,
permission-profile acknowledgements, event normalization, and the Zustand-backed
React session store. It has no dependency on the retired `connectonion-ts`
package and uses OIP exclusively.

## Install

```bash
npm install @connectonion/react
```

React 17 or newer is required as a peer dependency.

## React hook

```tsx
import { useAgentForHuman } from '@connectonion/react'

export function AgentChat({ address }: { address: string }) {
  const agent = useAgentForHuman(address)

  return (
    <form onSubmit={(event) => {
      event.preventDefault()
      const data = new FormData(event.currentTarget)
      agent.input(String(data.get('message') ?? ''))
    }}>
      {agent.ui.map((item) => (
        <pre key={item.id}>{JSON.stringify(item, null, 2)}</pre>
      ))}
      <input name="message" />
      <button disabled={agent.isProcessing}>Send</button>
    </form>
  )
}
```

`useAgentForHuman` exposes the conversation `ui`, connection and processing
state, the current OIP plan, authenticated agent profile and dashboard, plus
actions for prompts, onboarding, approvals, interruption, reconnect, and
permission-profile changes.

Onboarding pauses the original CONNECT attempt. Submit the signed invite or
payment assertion through `signOnboard` and `sendMessage`; after verification,
the Host completes that same connection so the original prompt is not run twice.

## Low-level connection

```ts
import { RemoteAgent } from '@connectonion/react/connect'

const agent = new RemoteAgent('0x...')
const result = await agent.input('Summarize this repository')
console.log(result.text)
```

By default the client discovers a browser-reachable OIP endpoint through the
OpenOnion relay and falls back to the relay OIP socket when HTTPS mixed-content
rules make a local endpoint unreachable. A trusted direct deployment can be
selected explicitly:

```ts
const agent = new RemoteAgent('0x...', {
  directUrl: 'https://my-agent.example',
})
```

When a host advertises its protocol in `CONNECTED`, the client accepts OIP 0.1
and reports a clear error for an unsupported protocol or version.

## Permission and collaboration state

Permission profiles are Host authority:

- `:read-only`
- `:workspace`
- `:danger-full-access`

Call and await `setPermissionProfile()`. The client sends an OIP `mode_change`
and changes local authority only after the matching `mode_changed` response.
Collaboration mode (`default` or `plan`) is a separate product preference.

Codex and Claude Code child activity arrives as ordinary OIP
`provider_invocation`, `tool_call`, and `tool_result` events. The package nests
that activity under one provider card without requiring another transport.

## Browser identity

`initializeBrowserIdentity()` stores a non-extractable Ed25519 key in IndexedDB.
`createBrowserIdentity()`, `importBrowserIdentity()`, and
`claimPendingBrowserRecovery()` cover explicit replacement and recovery flows.
The raw in-memory helpers `generateBrowser`, `signBrowser`, and
`createSignedPayloadBrowser` never persist keys.

## Development

```bash
npm ci
npm run typecheck
npm test
npm run build
```

Releases are created only by the protected GitHub tag workflow. A tag must match
`package.json` and point at the current reviewed `main` commit; npm publishing
uses Trusted Publishing with provenance.
