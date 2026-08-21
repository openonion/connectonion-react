/** Validation and normalization for ConnectOnion's OIP WebSocket events. */

import type { Mode, PlanEntry } from './types';
import { isMode, validatedModeState } from './mode';

const PLAN_PRIORITIES = new Set<PlanEntry['priority']>(['high', 'medium', 'low']);
const PLAN_STATUSES = new Set<PlanEntry['status']>([
  'pending',
  'in_progress',
  'completed',
]);

export interface HostSessionMode {
  id: Mode;
  name: string;
  description?: string;
  recommended?: boolean;
  dangerous?: boolean;
  bound?: string;
}

export interface HostSessionModeState {
  currentModeId: Mode;
  turnsLeft: number | null;
  availableModes: HostSessionMode[];
}

export interface OIPPlanUpdate {
  sessionId: string;
  entries: PlanEntry[];
}

export type ApprovalRejectMode =
  | 'reject_soft'
  | 'reject_hard'
  | 'reject_explain';

/** Parse exact authoritative mode state from an OIP CONNECTED frame. */
export function hostSessionModeState(
  connected: Record<string, unknown>,
): HostSessionModeState | null {
  const state = record(connected.session_modes);
  if (!state || !Array.isArray(state.availableModes)) return null;
  const current = validatedModeState(state.currentModeId, state.turnsLeft ?? null);
  if (!current) return null;

  const availableModes: HostSessionMode[] = [];
  const seen = new Set<Mode>();
  for (const candidate of state.availableModes) {
    const mode = record(candidate);
    const id = isMode(mode?.id) ? mode.id : null;
    if (!id || seen.has(id) || !nonEmpty(mode?.name)) return null;
    if (mode.description != null && typeof mode.description !== 'string') return null;
    seen.add(id);
    availableModes.push({
      id,
      name: mode.name,
      ...(typeof mode.description === 'string' ? { description: mode.description } : {}),
      ...(typeof mode.recommended === 'boolean' ? { recommended: mode.recommended } : {}),
      ...(typeof mode.dangerous === 'boolean' ? { dangerous: mode.dangerous } : {}),
      ...(typeof mode.bound === 'string' ? { bound: mode.bound } : {}),
    });
  }
  return seen.has(current.mode) ? {
    currentModeId: current.mode,
    turnsLeft: current.turnsLeft,
    availableModes,
  } : null;
}

/** Decode one full-replacement OIP plan event for a session. */
export function decodeLegacyPlanUpdate(frame: unknown): OIPPlanUpdate | null {
  const event = record(frame);
  if (event?.type !== 'plan' || !nonEmpty(event.session_id)) return null;
  const entries = normalizePlanEntries(event.entries);
  return entries ? { sessionId: event.session_id, entries } : null;
}

/** Validate a plan atomically and detach it from untrusted wire data. */
export function normalizePlanEntries(value: unknown): PlanEntry[] | null {
  if (!Array.isArray(value)) return null;
  const entries: PlanEntry[] = [];
  for (const candidate of value) {
    const entry = record(candidate);
    if (
      !entry
      || !nonEmpty(entry.content)
      || typeof entry.priority !== 'string'
      || !PLAN_PRIORITIES.has(entry.priority as PlanEntry['priority'])
      || typeof entry.status !== 'string'
      || !PLAN_STATUSES.has(entry.status as PlanEntry['status'])
    ) return null;
    entries.push({
      content: entry.content,
      priority: entry.priority as PlanEntry['priority'],
      status: entry.status as PlanEntry['status'],
    });
  }
  return entries;
}

/** Normalize terminal tool results into the existing incremental event shape. */
export function decodeIncomingEvent(
  event: Record<string, unknown>,
): Record<string, unknown> {
  if (event.type === 'tool_result') {
    return {
      ...event,
      type: 'tool_call_update',
      status: event.status ?? 'unknown_terminal',
    };
  }
  return event;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
