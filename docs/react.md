# ConnectOnion React

React hooks for connecting to remote AI agents with real-time UI updates.

## Installation

```bash
npm install @connectonion/react connectonion
```

`react` (17+) and `connectonion` are peer dependencies — install them alongside this package.

## Quick Start

```tsx
import { useAgentForHuman } from '@connectonion/react';

function ChatBot({ sessionId }: { sessionId: string }) {
  const { ui, status, input, isProcessing } = useAgentForHuman('0x123abc', { sessionId });

  const handleSubmit = async (text: string) => {
    await input(text);
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
  sessionId,      // string - the session ID you passed in
  input,          // (prompt: string) => Promise<Response>
  reset,          // () => void - start fresh
  isProcessing,   // boolean - true when status !== 'idle'
  error,          // Error | null - last error
  respond,        // (answer: string | string[]) => void - answer ask_user
  respondToApproval, // (approved: boolean, ...) => void
  connect,        // () => void - open the socket without sending input
  dashboardHtml,  // string | null - the agent's Home page, if it has one
} = useAgentForHuman(address, options);
```

### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `address` | `string` | Agent's public address (0x...) |
| `options` | `UseAgentForHumanOptions` | Options with required `sessionId` |

### Options

```tsx
interface UseAgentForHumanOptions extends ConnectOptions {
  sessionId: string;         // Required - unique ID for this conversation
}

// ConnectOptions (passed to connect())
interface ConnectOptions {
  keys?: AddressData;        // Signing keys for strict trust
  relayUrl?: string;         // Custom relay URL
  enablePolling?: boolean;   // Polling fallback (default: true)
}
```

## UI Events

The `ui` array contains events for rendering the conversation. Each event has:
- `id`: Unique identifier
- `type`: Event type

### Event Types

| Type | Description | Properties |
|------|-------------|------------|
| `user` | User message | `content: string` |
| `agent` | Agent response | `content: string` |
| `thinking` | Thinking indicator | - |
| `tool_call` | Tool execution | `name`, `args`, `status`, `result` |
| `ask_user` | Agent question | `text: string` |

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

## Response Object

The `input()` function returns a `Response`:

```tsx
interface Response {
  text: string;  // Agent's response or question
  done: boolean; // true = complete, false = needs more input
}
```

### Handling Follow-up Questions

When `done: false`, the agent is asking for more information:

```tsx
const handleSubmit = async (text: string) => {
  const response = await input(text);

  if (!response.done) {
    // Agent asked a follow-up question
    // The question is in response.text and also in ui as 'ask_user' event
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
const { input, reset } = useAgentForHuman('0x123abc', { sessionId });

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
const { dashboardHtml, connect } = useAgentForHuman(address, { sessionId });

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
  const { ui, input, isProcessing, reset } = useAgentForHuman('0x123abc', { sessionId });
  const [text, setText] = useState('');

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim() || isProcessing) return;

    const prompt = text;
    setText('');
    await input(prompt);
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

### With Signing Keys (Strict Trust)

```tsx
import { useAgentForHuman } from '@connectonion/react';
import { address } from 'connectonion';

function SecureAgent({ sessionId }: { sessionId: string }) {
  // Generate or load keys
  const [keys] = useState(() => address.generate());

  const { input } = useAgentForHuman('0x123abc', { sessionId, keys });

  // Your public address for the agent to verify
  console.log('My address:', keys.address);

  return <div>...</div>;
}
```

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
  ConnectOptions,
  UseAgentForHumanOptions,
  UseAgentForHumanReturn,
} from '@connectonion/react';
```

## Server-Side Rendering (SSR)

The hook is safe for SSR - it initializes with empty state and only connects on the client:

```tsx
// Works in Next.js, Remix, etc.
function Page() {
  const { ui, input } = useAgentForHuman('0x123abc', { sessionId: 'my-session' });

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
