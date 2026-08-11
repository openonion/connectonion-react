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
  respond,        // (answer: string | string[]) => void - answer ask_user
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

### Host session modes

Policy is an authenticated Host capability, not component state. The hook exposes the
Host's exact advertised choices and an acknowledged setter:

```tsx
const {
  mode,               // 'safe' | 'accept_edits' | 'ulw'
  availableModes,     // Host-advertised SessionMode[]
  modeChangePending,
  setSessionMode,
} = useAgentForHuman(address, sessionId)

async function choose(modeId: 'safe' | 'accept_edits' | 'ulw') {
  await setSessionMode(modeId)
}
```

Do not render a mode that is absent from `availableModes`. Disable policy controls and
new prompt submission while `modeChangePending` is true. The promise resolves only for a
matching Host acknowledgement; a rejection, malformed response, timeout, or disconnect
leaves `mode` unchanged. Reconnect before retrying an unknown timeout/disconnect outcome.

Plan is product workflow state over an acknowledged `safe` policy. It is deliberately
excluded from `ServerApprovalMode` and must never be sent as `session/set_mode`.

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
  text: string;  // Agent's response or question
  done: boolean; // true = complete, false = needs more input
}
```

### Handling Follow-up Questions

When `done: false`, the agent is asking for more information:

```tsx
import { connect } from '@connectonion/react/connect'

const agent = connect(address)

const handleSubmit = async (text: string) => {
  const response = await agent.input(text);

  if (!response.done) {
    // Agent asked a follow-up question
    // The question is in response.text and agent.ui also contains ask_user.
    console.log('Agent asks:', response.text);
  }
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

### With Signing Keys (Low-Level API)

```tsx
import { generateBrowser } from '@connectonion/react';
import { connect } from '@connectonion/react/connect';

const keys = generateBrowser();
const agent = connect('0x123abc', { keys });
const response = await agent.input('Hello');
```

`useAgentForHuman` owns the normal browser connection for React applications and accepts
only `address` and `sessionId`. Use the low-level `connect()` API when you need custom
connection options such as explicit signing keys or a direct URL.

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
  ConnectOptions,
  UseAgentForHumanReturn,
} from '@connectonion/react';
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
| Reactive updates | Automatic | Manual polling |
| State management | Built-in (Zustand) | You manage |
| Session persistence | localStorage (automatic) | In-memory only |
| SSR safe | Yes | Yes |
| Framework | React only | Any JS |

Use `useAgentForHuman()` for React apps. Use `connect()` for Node.js, Vue, Svelte, or custom implementations.

## See Also

- [connect.md](./connect.md) - Low-level connection API
- [getting-started.md](./getting-started.md) - General setup
- [examples.md](./examples.md) - More examples
