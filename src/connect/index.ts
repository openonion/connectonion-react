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
  ACPNotificationFrame,
  ACPPermissionRequest,
  ApprovalRejectMode,
} from './wire-events';
export { fetchAgentInfo } from './endpoint';
export { RemoteAgent } from './remote-agent';

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
 * // Multi-turn conversation
 * const r1 = await agent.input("Book a flight to NYC");
 * if (!r1.done) {
 *   const r2 = await agent.input("Tomorrow at 10am");
 * }
 *
 * // With signing (for strict trust agents)
 * import { address } from '@connectonion/react';
 * const keys = address.load('.co');
 * const agent = connect("0x3d4017c3...", { keys });
 * ```
 */
export function connect(
  agentAddress: string,
  options: ConnectOptions = {}
): RemoteAgent {
  return new RemoteAgent(agentAddress, options);
}
