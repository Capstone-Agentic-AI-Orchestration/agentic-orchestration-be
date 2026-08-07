import type { Request } from 'express';
import type { RuntimeMachine } from '@prisma/client';

/** Header the companion daemon authenticates with. It sends no `Authorization` and no cookies. */
export const RUNTIME_TOKEN_HEADER = 'x-runtime-token';

/** The provider CLIs the companion probes for. Text, not an enum, to match the wire contract. */
export const RUNTIME_ADAPTER_KINDS = [
  'CLAUDE_CODE',
  'CODEX_CLI',
  'COPILOT_CLI',
  'OPENCODE_CLI',
  'ANTIGRAVITY_CLI',
  'HERMES_CLI',
  'REASONIX_CLI',
  'GEMINI_CLI',
] as const;
export type RuntimeAdapterKind = (typeof RUNTIME_ADAPTER_KINDS)[number];

/**
 * Kinds DevFlow can actually hand work to.
 *
 * Detection is deliberately broader than execution: the companion reports every CLI it finds, but
 * only these have a verified headless invocation in the companion's task runner. Dispatching to
 * anything else would burn a lease and return unusable output, so the split is enforced here on the
 * server rather than trusted to the client.
 */
export const DISPATCHABLE_ADAPTER_KINDS: readonly RuntimeAdapterKind[] = [
  'CLAUDE_CODE',
  'CODEX_CLI',
];

export function isDispatchableKind(kind: string): boolean {
  return (DISPATCHABLE_ADAPTER_KINDS as readonly string[]).includes(kind);
}

/**
 * How long a machine may stay silent before it reads as offline.
 *
 * The daemon heartbeats every 30s, so this is three missed beats — long enough that one slow
 * request or a brief network drop does not make a working machine flicker offline in the UI.
 */
export const MACHINE_ONLINE_WINDOW_MS = 90_000;

/** Grace period during which a rotated-away token still authenticates. See `RuntimeMachine`. */
export const TOKEN_ROTATION_GRACE_MS = 10 * 60_000;

export interface MachineAuthenticatedRequest extends Request {
  machine: RuntimeMachine;
}
