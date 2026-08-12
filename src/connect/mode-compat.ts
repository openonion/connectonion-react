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
  if (typeof raw.turns_used !== 'number' || typeof raw.max_turns !== 'number') {
    return null;
  }
  return { turnsUsed: raw.turns_used, maxTurns: raw.max_turns };
}

/** Normalize untrusted Host or localStorage state before it enters public state. */
export function normalizeSessionState(value: unknown): SessionState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const normalized = { ...raw } as Record<string, unknown>;

  if (Object.prototype.hasOwnProperty.call(raw, 'mode')) {
    const mode = normalizeApprovalMode(raw.mode);
    if (mode) normalized.mode = mode;
    else delete normalized.mode;
  }

  if (
    normalized.full_access_turns == null
    && typeof raw.ulw_turns === 'number'
  ) normalized.full_access_turns = raw.ulw_turns;
  if (
    normalized.full_access_turns_used == null
    && typeof raw.ulw_turns_used === 'number'
  ) normalized.full_access_turns_used = raw.ulw_turns_used;

  delete normalized.ulw_turns;
  delete normalized.ulw_turns_used;
  delete normalized.ulw_prompt;
  return normalized as SessionState;
}

/** Normalize checkpoint cards restored from an older Host or localStorage. */
export function normalizeChatItems(value: unknown): ChatItem[] {
  if (!Array.isArray(value)) return [];
  return value.map((candidate) => {
    if (
      candidate
      && typeof candidate === 'object'
      && !Array.isArray(candidate)
      && (candidate as Record<string, unknown>).type === 'ulw_turns_reached'
    ) {
      return {
        ...(candidate as Record<string, unknown>),
        type: 'full_access_checkpoint',
      } as ChatItem;
    }
    return candidate as ChatItem;
  });
}
