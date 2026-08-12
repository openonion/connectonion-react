/** One-window readers for approval state written before the canonical vocabulary. */

import type {
  ApprovalMode,
  ChatItem,
  ServerApprovalMode,
  SessionState,
} from './types';

const CANONICAL_SERVER_MODES = new Set<ServerApprovalMode>([
  'default',
  'auto_approve',
  'full_access',
]);

const PREVIOUS_SERVER_MODES: Record<string, ServerApprovalMode> = {
  safe: 'default',
  accept_edits: 'auto_approve',
  ulw: 'full_access',
};

export function isCanonicalServerApprovalMode(
  value: unknown,
): value is ServerApprovalMode {
  return typeof value === 'string'
    && CANONICAL_SERVER_MODES.has(value as ServerApprovalMode);
}

export function normalizeServerApprovalMode(
  value: unknown,
): ServerApprovalMode | null {
  if (isCanonicalServerApprovalMode(value)) return value;
  return typeof value === 'string' ? PREVIOUS_SERVER_MODES[value] ?? null : null;
}

function normalizeApprovalMode(value: unknown): ApprovalMode | undefined {
  if (value === 'plan') return 'plan';
  return normalizeServerApprovalMode(value) ?? undefined;
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && typeof value === 'number' && value >= 0;
}

function positiveInteger(value: unknown): value is number {
  return nonNegativeInteger(value) && value > 0;
}

export interface FullAccessCheckpointFrame {
  turnsUsed: number;
  maxTurns: number;
}

/** Read the canonical checkpoint event or its one-window predecessor. */
export function normalizeFullAccessCheckpointFrame(
  value: unknown,
): FullAccessCheckpointFrame | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (
    raw.type !== 'full_access_checkpoint'
    && raw.type !== 'ulw_turns_reached'
  ) return null;
  if (
    !nonNegativeInteger(raw.turns_used)
    || !positiveInteger(raw.max_turns)
    || raw.turns_used > raw.max_turns
  ) {
    return null;
  }
  return { turnsUsed: raw.turns_used, maxTurns: raw.max_turns };
}

/** Normalize untrusted Host or localStorage state before it enters public state. */
export function normalizeSessionState(value: unknown): SessionState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const normalized = { ...raw } as Record<string, unknown>;

  const mode = Object.prototype.hasOwnProperty.call(raw, 'mode')
    ? normalizeApprovalMode(raw.mode) ?? 'default'
    : undefined;
  if (mode) normalized.mode = mode;

  if (
    normalized.full_access_turns == null
    && positiveInteger(raw.ulw_turns)
  ) normalized.full_access_turns = raw.ulw_turns;
  if (
    normalized.full_access_turns_used == null
    && nonNegativeInteger(raw.ulw_turns_used)
  ) normalized.full_access_turns_used = raw.ulw_turns_used;

  delete normalized.ulw_turns;
  delete normalized.ulw_turns_used;
  delete normalized.ulw_prompt;

  const turns = normalized.full_access_turns;
  const used = normalized.full_access_turns_used;
  const validFullAccess = mode === 'full_access'
    && positiveInteger(turns)
    && nonNegativeInteger(used)
    && used < turns;
  if (!validFullAccess) {
    delete normalized.full_access_turns;
    delete normalized.full_access_turns_used;
    if (mode === 'full_access') normalized.mode = 'default';
  }
  return normalized as SessionState;
}

/** Normalize checkpoint cards restored from an older Host or localStorage. */
export function normalizeChatItems(value: unknown): ChatItem[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    if (
      candidate
      && typeof candidate === 'object'
      && !Array.isArray(candidate)
      && (
        (candidate as Record<string, unknown>).type === 'ulw_turns_reached'
        || (candidate as Record<string, unknown>).type === 'full_access_checkpoint'
      )
    ) {
      const checkpoint = normalizeFullAccessCheckpointFrame(candidate);
      if (!checkpoint) return [];
      return [{
        ...(candidate as Record<string, unknown>),
        type: 'full_access_checkpoint',
      } as ChatItem];
    }
    return [candidate as ChatItem];
  });
}
