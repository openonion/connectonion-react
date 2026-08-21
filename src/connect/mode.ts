/** Exact ConnectOnion 1.7 mode-state validation. No authority aliases. */

import type { ChatItem, Mode, SessionState } from './types';

export const MODES: readonly Mode[] = ['read-only', 'auto', 'full-access'];
export const DEFAULT_MODE: Mode = 'auto';

export function isMode(value: unknown): value is Mode {
  return typeof value === 'string' && (MODES as readonly string[]).includes(value);
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

export function validatedModeState(
  mode: unknown,
  turnsLeft: unknown,
): { mode: Mode; turnsLeft: number | null } | null {
  if (!isMode(mode)) return null;
  if (mode === 'full-access') {
    return positiveInteger(turnsLeft) ? { mode, turnsLeft } : null;
  }
  return turnsLeft == null ? { mode, turnsLeft: null } : null;
}

/** Normalize persisted, untrusted state; unknown authority always becomes Auto. */
export function normalizeSessionState(value: unknown): SessionState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const normalized = { ...raw } as Record<string, unknown>;
  const state = validatedModeState(raw.mode ?? DEFAULT_MODE, raw.turns_left ?? null);

  for (const key of [
    'approval_profile',
    'collaboration_mode',
    'full_access_prompt',
    'full_access_turns',
    'full_access_turns_used',
    'permission_profile',
    'skip_tool_approval',
    'ulw_prompt',
    'ulw_turns',
    'ulw_turns_used',
    'workflow_mode',
  ]) delete normalized[key];

  normalized.mode = state?.mode ?? DEFAULT_MODE;
  delete normalized.turns_left;
  if (state?.turnsLeft != null) normalized.turns_left = state.turnsLeft;
  return normalized as SessionState;
}

/** Chat progress is data, never mode authority. */
export function normalizeChatItems(value: unknown): ChatItem[] {
  if (!Array.isArray(value)) return [];
  return value.filter((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return true;
    const type = (candidate as Record<string, unknown>).type;
    return type !== 'ulw_turns_reached' && type !== 'full_access_checkpoint';
  }) as ChatItem[];
}
