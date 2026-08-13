/** One-window readers for permission state written before Codex alignment. */

import type {
  ChatItem,
  CollaborationMode,
  PermissionProfile,
  SessionState,
} from './types';

const CANONICAL_PERMISSION_PROFILES = new Set<PermissionProfile>([
  ':read-only',
  ':workspace',
  ':danger-full-access',
]);

const PREVIOUS_PERMISSION_PROFILES: Record<string, PermissionProfile> = {
  safe: ':read-only',
  default: ':read-only',
  accept_edits: ':workspace',
  auto_approve: ':workspace',
  ulw: ':danger-full-access',
  full_access: ':danger-full-access',
};

export function isCanonicalPermissionProfile(
  value: unknown,
): value is PermissionProfile {
  return typeof value === 'string'
    && CANONICAL_PERMISSION_PROFILES.has(value as PermissionProfile);
}

export function normalizePermissionProfile(
  value: unknown,
): PermissionProfile | null {
  if (isCanonicalPermissionProfile(value)) return value;
  return typeof value === 'string'
    ? PREVIOUS_PERMISSION_PROFILES[value] ?? null
    : null;
}

export function normalizeCollaborationMode(
  value: unknown,
): CollaborationMode | null {
  return value === 'default' || value === 'plan' ? value : null;
}

/** @deprecated Use isCanonicalPermissionProfile. */
export const isCanonicalServerApprovalMode = isCanonicalPermissionProfile;
/** @deprecated Use normalizePermissionProfile. */
export const normalizeServerApprovalMode = normalizePermissionProfile;

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
  ) return null;
  return { turnsUsed: raw.turns_used, maxTurns: raw.max_turns };
}

/** Normalize untrusted Host or localStorage state before public exposure. */
export function normalizeSessionState(value: unknown): SessionState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const normalized = { ...raw } as Record<string, unknown>;

  if (
    typeof raw.acp_session_id !== 'string'
    || raw.acp_session_id.length === 0
    || raw.acp_session_id.length > 256
  ) delete normalized.acp_session_id;

  const legacyPlan = raw.mode === 'plan';
  const profile = Object.prototype.hasOwnProperty.call(raw, 'mode')
    ? normalizePermissionProfile(raw.mode) ?? ':read-only'
    : undefined;
  if (profile) normalized.mode = profile;
  const collaborationMode = normalizeCollaborationMode(raw.collaboration_mode)
    ?? (legacyPlan ? 'plan' : undefined);
  if (collaborationMode) normalized.collaboration_mode = collaborationMode;

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
  const validFullAccess = profile === ':danger-full-access'
    && positiveInteger(turns)
    && nonNegativeInteger(used)
    && used < turns;
  if (!validFullAccess) {
    delete normalized.full_access_turns;
    delete normalized.full_access_turns_used;
    if (profile === ':danger-full-access') normalized.mode = ':read-only';
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
