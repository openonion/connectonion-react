# ConnectOnion React

React hooks for connecting to remote AI agents with real-time UI updates.

## Installation

```bash
npm install @connectonion/react
```

`react` (17+) is the only peer dependency. The browser connection layer is included in
`@connectonion/react`; do not install the legacy TypeScript core just to use these hooks.

## Quick Start

```tsx
import { useAgentForHuman } from '@connectonion/react';

function ChatBot({ sessionId }: { sessionId: string }) {
  const { ui, status, input, isProcessing } = useAgentForHuman('0x123abc', sessionId);

  const handleSubmit = (text: string) => {
    input(text);
  };

  return (
    <div>
      {/* Render UI events */}
      {ui.map(event => (
        <UIEvent key={event.id} event={event} />
      ))}

      {/* Show status */}
      {isProcessing && <div>Processing...</div>}

      {/* Input form */}
      <ChatInput onSubmit={handleSubmit} disabled={isProcessing} />
    </div>
  );
}
```

## The `useAgentForHuman` Hook

```tsx
const {
  status,         // 'idle' | 'working' | 'waiting'
  ui,             // ChatItem[] - events for rendering
  plan,           // readonly PlanEntry[] - latest complete plan snapshot
  sessionId,      // string - the session ID you passed in
  input,          // (prompt: string) => void - reactive, fire-and-forget
  reset,          // () => void - start fresh
  isProcessing,   // boolean - true when status !== 'idle'
  error,          // Error | null - last error
  sendMessage,    // (message: OutgoingMessage) => void - answer ask_user, etc.
  respondToApproval, // (approved: boolean, ...) => void
  connect,        // () => void - open the socket without sending input
  dashboardHtml,  // string | null - the agent's Home page, if it has one
} = useAgentForHuman(address, sessionId);
```

### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `address` | `string` | Agent's public address (0x...) |
| `sessionId` | `string` | Required unique ID for this conversation |

## Native ACP transport selection

Modern ESM imports of `@connectonion/react` register the official ACP SDK driver. Before a
prompt, the hook performs non-cacheable `/info` discovery and chooses exactly one path:

- an exact ConnectOnion ACP descriptor selects direct native ACP;
- a successful matching response with the descriptor genuinely absent selects legacy
  compatibility;
- malformed discovery and every native admission, initialize, session, resume, or prompt
  failure fail closed without opening `/ws`.

CommonJS `require('@connectonion/react')` remains legacy-compatible. Components do not need to
import the low-level native module and must not construct JSON-RPC frames.

The native client sends `cwd: "/"`, `mcpServers: []`, and no Host path. It stores the
server-issued ACP session ID separately from the application `sessionId`; resume restores
private Agent continuation while the persisted `ui` array remains the rendering source.
Images and embedded files use the capabilities and content blocks negotiated through ACP.

If the authenticated Host requires onboarding, the original `connect()` or `input()` remains
pending. A signed invite/payment submission retries admission and then continues that exact
attempt, so the first prompt is neither lost nor sent twice. Payment is addressed to the exact
Agent identity already matched during discovery; the Host independently verifies the transfer.
An invalid submission keeps one retryable `onboard_required` state. Reset cancels the waiter.

## UI Events

The `ui` array contains events for rendering the conversation. Each event has:
- `id`: Unique identifier
- `type`: Event type

### Event Types

| Type | Description | Properties |
|------|-------------|------------|
| `user` | User message | `content: string` |
| `agent` | Agent response | `content: string` |
| `thinking` | Host-supplied thought or running indicator | `status`, optional `content`, optional `kind` |
| `tool_call` | Tool execution | `name`, `args`, `status`, `result` |
| `ask_user` | Agent question | `text: string` |
| `approval_needed` | Tool requires a decision | `tool`, `arguments`, `description?`, `answered?` |
| `onboard_required` | Host admission needs invite/payment | `methods`, `paymentAmount?`, `paymentAddress?` |
| `onboard_success` | Admission completed | `level`, `message` |

A ConnectOnion Host may deliver its public, application-authored thought text through ACP
`agent_thought_chunk`; the SDK normalizes it to `thinking` and de-duplicates it
with legacy/replayed events by persisted ID. The ConnectOnion Host profile sends one
complete recorded thought per ID and does not claim provider token streaming. React
decodes text explicitly sent in the frame and cannot classify its origin. The profile maps only
persisted, already-visible application `thinking` events—not provider diagnostics or
hidden model fields—to this update; third-party Hosts define their own privacy contract.

### Tool approvals

Render one approval item and answer it through the hook. The React package owns
ACP request IDs, Host session correlation, legacy fallback, and duplicate
suppression; components should not construct protocol frames.

Native ACP may deliver `session/request_permission` before a separate tool
update. React therefore creates or reuses one `tool_call` with the request's
stable `toolCallId` before appending `approval_needed`. Components can always
render the decision inline with that running tool card without parsing ACP or
inventing a second correlation rule.

At the prompt boundary, every permission tool card that still lacks an official
terminal update becomes `error`. React does not manufacture success from a
selected permission, and stale `running` cards cannot keep a restored UI
permanently active, including when one prompt requests permission more than once.

```tsx
const { ui, respondToApproval } = useAgentForHuman(address, sessionId);
const approval = ui.find(item =>
  item.type === 'approval_needed' && !item.answered
);

if (approval) {
  return (
    <>
      <button onClick={() => respondToApproval(true, 'once')}>Allow once</button>
      <button onClick={() => respondToApproval(true, 'session')}>Allow session</button>
      <button onClick={() => respondToApproval(false, 'once', 'reject_hard')}>
        Reject
      </button>
    </>
  );
}
```

`reject_soft`, `reject_hard`, and `reject_explain` are the supported rejection
modes. An optional fourth argument carries explanatory feedback on a rejection.
Calling the method twice for the same card sends only one response, including
after a reconnect replay.

### Collaboration modes and Host permission profiles

Codex collaboration intent is component/session workflow state. Permission is
an authenticated Host capability. The hook exposes both axes separately:

```tsx
const {
  collaborationMode,             // 'default' | 'plan'
  permissionProfile,              // ':read-only' | ':workspace' | ':danger-full-access'
  availablePermissionProfiles,    // Host-advertised SessionMode[]
  permissionProfileChangePending,
  setCollaborationMode,
  setPermissionProfile,
} = useAgentForHuman(address, sessionId)

function planFirst() {
  setCollaborationMode('plan')
}

async function allowWorkspaceEdits() {
  await setPermissionProfile(':workspace')
}
```

The deprecated synchronous `setMode()` accepts only the local `default` and
`plan` collaboration values. It rejects permission profiles because only an
acknowledged `setPermissionProfile()` transaction may change Host authority.

Do not render a profile absent from `availablePermissionProfiles`. Disable
permission controls and new prompt submission while
`permissionProfileChangePending` is true. The promise resolves only for a
matching Host acknowledgement; a rejection, malformed response, timeout, or disconnect
leaves `permissionProfile` unchanged. Reconnect before retrying an unknown
timeout/disconnect outcome.

Plan is deliberately excluded from `PermissionProfile` and must never be sent
as Host `session/set_mode` authority.

### Current plan

The hook exposes the latest complete plan snapshot separately from the chat transcript:

```tsx
const { plan } = useAgentForHuman(address, sessionId)
```

Each entry has `content`, `priority` (`high | medium | low`), and `status`
(`pending | in_progress | completed`). Every ACP plan update replaces the whole list;
an empty list clears it. The snapshot persists with its session and is restored on
reconnect. It is read-only progress state, not an approval surface: keep interactive
`plan_review` handling separate and never use `plan` to authorize implementation.

### Tool Call Status

Tool calls have a `status` field:
- `'running'`: Tool is executing
- `'done'`: Tool completed successfully
- `'error'`: Tool failed

When a tool completes, its result is merged into the existing event (no duplicates).

### Type-Safe Event Rendering

```tsx
import { isEventType, UIEvent } from '@connectonion/react';

function EventRenderer({ event }: { event: UIEvent }) {
  if (isEventType(event, 'user')) {
    return <UserMessage>{event.content}</UserMessage>;
  }

  if (isEventType(event, 'agent')) {
    return <AgentMessage>{event.content}</AgentMessage>;
  }

  if (isEventType(event, 'thinking')) {
    return <ThinkingIndicator />;
  }

  if (isEventType(event, 'tool_call')) {
    return (
      <ToolCard
        name={event.name}
        status={event.status}
        result={event.result}
      />
    );
  }

  if (isEventType(event, 'ask_user')) {
    return <Question>{event.text}</Question>;
  }

  return null;
}
```

## Low-Level Response Object

The React hook's `input()` is fire-and-forget; watch `ui`, `status`, and `error` for
reactive results. The low-level agent returned by `connect()` instead resolves a
`Response`:

```tsx
interface Response {
  text: string;  // Final agent response
  done: boolean; // true for final OUTPUT; ask_user does not resolve input()
}
```

### Handling Follow-up Questions

An `ask_user` event pauses the run without resolving `input()`. Observe the
low-level agent's reactive state, send the answer on the same connection, and
then await the original promise for the final response:

```tsx
import { connect } from '@connectonion/react/connect'

const agent = connect(address)
agent.onMessage = () => {
  const question = [...agent.ui].reverse().find(
    item => item.type === 'ask_user' && !item.answered
  )
  if (question?.type === 'ask_user') {
    const answer = window.prompt(question.text)
    if (answer !== null) {
      agent.send({ type: 'ASK_USER_RESPONSE', answer })
    }
  }
}

const handleSubmit = async (text: string) => {
  const response = await agent.input(text);
  console.log('Final response:', response.text);
};
```

## Session Persistence

The `useAgentForHuman` hook automatically persists session state to `localStorage` via Zustand. This means:

- **Survives browser refresh**: If the user refreshes mid-conversation, the session is restored
- **Client is source of truth**: Server sends session state with every streaming event, the hook saves it locally
- **Application controls lifecycle**: The SDK saves sessions, your app decides when to create new ones or clean up old ones

### How It Works

1. Each `sessionId` gets its own localStorage key: `co:agent:{address}:session:{sessionId}`
2. On every streaming event from the server, the hook syncs `agent.currentSession` to the store
3. On mount (or page refresh), the hook restores the session from localStorage back to the agent
4. The agent sends the restored session to the server on the next `input()`, so the server can continue the conversation

### Session Lifecycle

```tsx
// Your app generates the sessionId (e.g., from URL params)
const sessionId = crypto.randomUUID();

// Pass it to the hook - session auto-persists
const { input, reset } = useAgentForHuman('0x123abc', sessionId);

// reset() clears the Zustand store for this sessionId
// To start a NEW conversation, navigate to a new sessionId
```

### What Gets Persisted

| Field | Persisted | Description |
|-------|-----------|-------------|
| `messages` | Yes | Conversation history |
| `ui` | Yes | Chat items for rendering |
| `session` | Yes | Full SessionState from server |
| `status` | No | Always starts as 'idle' |
| `error` | No | Transient, not persisted |

### Base RemoteAgent vs React Hook

The base `RemoteAgent` (from `connect()`) keeps session **in memory only**. Only the React hook adds localStorage persistence. This separation means:

- **Node.js / non-React**: Session lives in memory, lost on process restart
- **React (useAgentForHuman)**: Session auto-persists to localStorage

## The Agent's Home Page

An agent can publish a Home page — a `dashboard.html` in its project root — which the
host pushes over the same WebSocket the chat uses. `dashboardHtml` holds the latest
copy, or `null` if the agent doesn't have one.

```tsx
const { dashboardHtml, connect } = useAgentForHuman(address, sessionId);

// Warm the connection so Home paints before the user's first message
useEffect(() => { connect() }, [connect]);

if (!dashboardHtml) return <Chat />;          // agent has no Home page
return <Home html={dashboardHtml} />;
```

The host sends it on connect and again after any run that changed the file, so
`dashboardHtml` updates on its own — no polling, no refetch. An unchanged page arrives
as the identical string, so React bails out of the state update and nothing re-renders.

`connect()` opens the socket without sending a prompt, which is what lets a landing or
draft view receive that on-connect push before any `input()`. It's idempotent, safe to
call concurrently, and stable across renders, so it can go in an effect's dependency
array.

### Rendering it safely

**The HTML is agent-authored and untrusted.** Never put it in `dangerouslySetInnerHTML`
or in an iframe that can reach your origin. Render it in a sandboxed iframe:

```tsx
<iframe sandbox="allow-scripts" srcDoc={wrapped} />
```

`sandbox="allow-scripts"` without `allow-same-origin` gives the frame an opaque origin,
so it can't touch your `localStorage`, keys, or parent DOM. Pair it with a
Content-Security-Policy — `default-src 'none'` plus a per-render nonce for your own
script — so the agent's scripts don't run and the page can't reach the network.

Build that wrapper by **wrapping** the agent's HTML in a document you control, not by
injecting into theirs. String-matching `<head>` to find an insertion point is
defeatable: a `<head>` inside a comment moves your CSP into that comment and drops the
policy entirely. Emit your own `<head>` first and put the agent's markup in the body —
browsers discard a nested `<html>`/`<head>`/`<body>` and keep the children, so a full
agent document renders unchanged.

If you expose action buttons from the page, treat every message it posts as untrusted
intent: validate against the skills the agent actually published, and fail closed while
that list is still loading. See the reference implementation in
[oo-chat](https://github.com/openonion/oo-chat)'s `components/dashboard/`.

## Examples

### Basic Chat Interface

```tsx
import { useAgentForHuman } from '@connectonion/react';

function Chat({ sessionId }: { sessionId: string }) {
  const { ui, input, isProcessing, reset } = useAgentForHuman('0x123abc', sessionId);
  const [text, setText] = useState('');

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim() || isProcessing) return;

    const prompt = text;
    setText('');
    input(prompt);
  };

  return (
    <div className="chat">
      <button onClick={reset}>New Chat</button>

      <div className="messages">
        {ui.map(event => (
          <Message key={event.id} event={event} />
        ))}
      </div>

      <form onSubmit={handleSubmit}>
        <input
          value={text}
          onChange={e => setText(e.target.value)}
          disabled={isProcessing}
          placeholder="Type a message..."
        />
        <button type="submit" disabled={isProcessing}>
          Send
        </button>
      </form>
    </div>
  );
}
```

### With a secure browser identity (Low-Level API)

```tsx
import { initializeBrowserIdentity } from '@connectonion/react';
import { connect } from '@connectonion/react/connect';

const { identity, recovery } = await initializeBrowserIdentity();
if (recovery) showRecoveryOnce(recovery.value);
const agent = connect('0x123abc', { signer: identity });
const response = await agent.input('Hello');
```

`useAgentForHuman` owns the normal browser connection for React applications and accepts
only `address` and `sessionId`. Use the low-level `connect()` API when you need custom
connection options such as an explicit signer or a direct URL.

## Browser identity and recovery

Browser identity belongs to `@connectonion/react`, not to the application UI or
the retired standalone TypeScript SDK. The default connection, native ACP
admission, onboarding, and transcription all use the same async signer.

```tsx
import {
  initializeBrowserIdentity,
  createBrowserIdentity,
  importBrowserIdentity,
  claimPendingBrowserRecovery,
} from '@connectonion/react'

// Load, securely migrate, or create the one browser identity.
const initialized = await initializeBrowserIdentity()
const recovery = initialized.recovery ?? claimPendingBrowserRecovery()

// Explicit replacement: returns a new phrase once.
const replacement = await createBrowserIdentity()

// Recovery import accepts a valid BIP39 phrase or legacy private-key hex.
const recovered = await importBrowserIdentity(words)
```

The private Ed25519 key is a non-extractable WebCrypto `CryptoKey` stored via
IndexedDB structured clone. Only public address metadata sits beside it. A new
or migrated recovery value is returned to one caller and never persisted; after
the user dismisses it, the SDK cannot reveal it again.

Legacy `localStorage['connectonion_keys']` data is validated for matching
address/public/private fields, written to IndexedDB, reloaded, and proved by a
signature before deletion. A failed write, corrupt record, or conflicting
identity fails closed without generating a replacement address. Browsers that
lack WebCrypto Ed25519 or IndexedDB receive an actionable error; the SDK never
falls back to clear-text persistence.

Explicit create/import replacements also fail closed: the SDK restores the
previous stored identity if candidate verification or legacy cleanup fails, and
never returns a replacement until the complete operation succeeds.

This protects raw key material at rest and from bulk Web Storage exfiltration.
It cannot stop injected same-origin JavaScript from asking the non-extractable
key to sign while the origin is compromised. CSP, trusted dependencies, and
isolated untrusted content remain required defenses.

`generateBrowser()`, `signBrowser()`, and
`createSignedPayloadBrowser()` remain for explicit ephemeral/raw-key use. They
do not persist anything. The old synchronous `saveBrowser()` and
`loadBrowser()` APIs are removed.

See [Browser identity: non-extractable WebCrypto keys](./browser-identity.md) for
the threat model, alternatives, migration invariants, and revisit conditions.

### Tool Execution Visualization

```tsx
function ToolCard({ event }: { event: ToolCallUIEvent }) {
  return (
    <div className={`tool-card status-${event.status}`}>
      <div className="tool-name">{event.name}</div>

      {event.status === 'running' && (
        <div className="spinner">Running...</div>
      )}

      {event.status === 'done' && (
        <div className="result">{event.result}</div>
      )}

      {event.status === 'error' && (
        <div className="error">{event.result}</div>
      )}
    </div>
  );
}
```

## TypeScript Types

All types are exported for convenience:

```tsx
import type {
  Response,
  ChatItem,
  ChatItemType,
  AgentStatus,
  PlanEntry,
  UseAgentForHumanReturn,
} from '@connectonion/react';

import type { ConnectOptions } from '@connectonion/react/connect';
```

## Server-Side Rendering (SSR)

The hook is safe for SSR - it initializes with empty state and only connects on the client:

```tsx
// Works in Next.js, Remix, etc.
function Page() {
  const { ui, input } = useAgentForHuman('0x123abc', 'my-session');

  // ui is [] on server, populated on client
  return <div>{ui.map(...)}</div>;
}
```

## Comparison with Low-Level API

| Feature | `useAgentForHuman()` | `connect()` |
|---------|--------------|-------------|
| Reactive updates | Automatic | You wire `onMessage` |
| State management | Built-in (Zustand) | You manage |
| Session persistence | localStorage (automatic) | In-memory only |
| SSR safe | Yes | Yes |
| Framework | React only | Any JS |

Use `useAgentForHuman()` for React apps. Use `connect()` for Node.js, Vue, Svelte, or custom implementations.

## See Also

- [connect.md](./connect.md) - Low-level connection API
- [getting-started.md](./getting-started.md) - General setup
- [examples.md](./examples.md) - More examples
