/**
 * @llm-note
 *   Dependencies: imports from [src/connect/types, src/connect/remote-agent, src/connect/endpoint] | imported by [src/index.ts, src/react/]
 *   Data flow: connect(agentAddress, options?) → new RemoteAgent(agentAddress, options)
 *   State/Effects: pure factory, no state
 *   Integration: barrel for connect subsystem — re-exports types, RemoteAgent, fetchAgentInfo
 */
import { ConnectOptions } from './types';
import { RemoteAgent } from './remote-agent';

export * from './types';
export type {
  HostSessionModeState,
  ApprovalRejectMode,
} from './wire-events';
export { fetchAgentInfo } from './endpoint';
export {
  OIP_PROTOCOL,
  OIP_REQUESTED_EXTENSIONS,
  SESSION_SYNC_EXTENSION,
  SESSION_SYNC_VERSION,
  OipCompatibilityError,
  supportsOip,
  supportsSessionSync,
} from './protocol';
export { RemoteAgent, SessionSyncError } from './remote-agent';

/**
 * Connect to a remote agent.
 *
 * Two connection modes:
 * 1. Via relay (default): Uses agent address, routes through relay server
 * 2. Direct: Uses directUrl option, connects directly to deployed agent
 *
 * @param agentAddress Agent public key (0x...) - used for relay routing and signing
 * @param options Connection options
 *
 * @example
 * ```typescript
 * // Via relay (default) - uses agent address
 * const agent = connect("0x3d4017c3...");
 * const response = await agent.input("Hello");
 *
 * // Direct to deployed agent (bypasses relay)
 * const agent = connect("agent-name", {
 *   directUrl: "https://my-agent.agents.openonion.ai"
 * });
 * const response = await agent.input("Hello");
 *
 * // Access UI events for rendering
 * console.log(agent.ui);       // Array of UI events
 * console.log(agent.status);   // 'idle' | 'working' | 'waiting'
 *
 * // Interactive runs stay pending while the agent waits for a human.
 * agent.onMessage = () => {
 *   const question = [...agent.ui].reverse().find(
 *     item => item.type === 'ask_user' && !item.answered
 *   );
 *   if (question?.type === 'ask_user') {
 *     agent.send({ type: 'ASK_USER_RESPONSE', answer: 'Tomorrow at 10am' });
 *   }
 * };
 * const response = await agent.input("Book a flight to NYC");
 *
 * // With browser signing (for strict trust agents)
 * import { generateBrowser } from '@connectonion/react';
 * const keys = generateBrowser();
 * const agent = connect("0x3d4017c3...", { keys });
 * ```
 */
export function connect(
  agentAddress: string,
  options: ConnectOptions = {}
): RemoteAgent {
  return new RemoteAgent(agentAddress, options);
}
