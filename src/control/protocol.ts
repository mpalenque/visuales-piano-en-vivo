import type { SystemStatus } from '../types';

export const PROTOCOL_VERSION = 1;
export const VISUAL_HEARTBEAT_MS = 1000;
export const VISUAL_TIMEOUT_MS = 3000;

export type ControlRole = 'visual' | 'panel';
export type TelemetryStatus = Omit<SystemStatus, 'config'>;

interface Envelope {
  version: number;
  sourceId: string;
  role: ControlRole;
  sequence: number;
}

export type ControlMessage =
  | (Envelope & { kind: 'hello' | 'heartbeat' | 'goodbye' })
  | (Envelope & { kind: 'action'; action: unknown })
  | (Envelope & { kind: 'request-snapshot' })
  | (Envelope & { kind: 'snapshot'; status: SystemStatus })
  | (Envelope & { kind: 'telemetry'; telemetry: TelemetryStatus });

export interface VisualConnection {
  hostCount: number;
  authorityId: string | null;
  state: 'connected' | 'disconnected' | 'multiple';
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Reject malformed or incompatible BroadcastChannel payloads before touching UI state. */
export function isControlMessage(value: unknown): value is ControlMessage {
  if (!isRecord(value)) return false;
  if (value.version !== PROTOCOL_VERSION || typeof value.sourceId !== 'string' || !value.sourceId || !['visual', 'panel'].includes(String(value.role))) return false;
  if (!Number.isInteger(value.sequence) || Number(value.sequence) < 1 || typeof value.kind !== 'string') return false;
  if (value.kind === 'hello' || value.kind === 'heartbeat' || value.kind === 'goodbye' || value.kind === 'request-snapshot') return true;
  if (value.kind === 'action') return isRecord(value.action) && typeof value.action.type === 'string';
  if (value.kind === 'snapshot') return isRecord(value.status) && typeof value.status.revision === 'number' && isRecord(value.status.config);
  if (value.kind === 'telemetry') return isRecord(value.telemetry) && typeof value.telemetry.revision === 'number';
  return false;
}

export function visualConnection(hostIds: readonly string[]): VisualConnection {
  const sorted = [...new Set(hostIds)].sort();
  const hostCount = sorted.length;
  return {
    hostCount,
    authorityId: sorted[0] ?? null,
    state: hostCount === 0 ? 'disconnected' : hostCount === 1 ? 'connected' : 'multiple',
  };
}
