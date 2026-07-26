import type { ImpulseMode, ShowConfig, SystemStatus } from '../types';
import { PROTOCOL_VERSION, VISUAL_HEARTBEAT_MS, VISUAL_TIMEOUT_MS, isControlMessage, type ControlMessage, type ControlRole, type TelemetryStatus, type VisualConnection, visualConnection } from './protocol';

export type ControlAction =
  | { type: 'scene'; id: number }
  | { type: 'force-event'; event: 'estalla' | 'climax' | 'pulso' }
  | { type: 'freeze'; gestureId: string; frozen: boolean }
  | { type: 'gesture-param'; gestureId: string; key: string; value: number }
  | { type: 'override'; target: string; value: number | null }
  | { type: 'wire-target'; index: number; target: string }
  | { type: 'blackout'; value: boolean }
  | { type: 'impulse-mode'; mode: ImpulseMode }
  | { type: 'test-note'; midi?: number }
  | { type: 'test-chord' }
  | { type: 'reset-packing' }
  | { type: 'recalibrate' }
  | { type: 'start-audio' }
  | { type: 'save-config' }
  | { type: 'render-quality'; quality: 'high' | 'safe' }
  | { type: 'replace-config'; config: ShowConfig };

type OutboundMessage =
  | { kind: 'hello' | 'heartbeat' | 'goodbye' | 'request-snapshot' }
  | { kind: 'action'; action: ControlAction }
  | { kind: 'snapshot'; status: SystemStatus }
  | { kind: 'telemetry'; telemetry: TelemetryStatus };

const makeSourceId = (role: ControlRole): string => {
  const key = `piano-visuales-control-v2-${role}-source-id`;
  try {
    const existing = sessionStorage.getItem(key);
    if (existing) return existing;
    const sourceId = crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    sessionStorage.setItem(key, sourceId);
    return sourceId;
  } catch {
    return crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
};

/**
 * Same-tab callbacks plus a versioned BroadcastChannel protocol. A deterministic
 * source-id election prevents two visual windows from both becoming authority.
 */
export class ControlBus {
  private readonly channel = 'BroadcastChannel' in window ? new BroadcastChannel('piano-visuales-control-v2') : null;
  private readonly sourceId: string;
  private sequence = 0;
  private readonly actionListeners = new Set<(action: ControlAction) => void>();
  private readonly statusListeners = new Set<(status: SystemStatus) => void>();
  private readonly requestListeners = new Set<() => void>();
  private readonly connectionListeners = new Set<(connection: VisualConnection) => void>();
  private readonly visualSeenAt = new Map<string, number>();
  private readonly lastRevision = new Map<string, number>();
  private latestSnapshot: SystemStatus | null = null;
  private lastConnectionKey = '';
  private disposed = false;
  private readonly heartbeatTimer: number;
  private readonly sweepTimer: number;

  constructor(private readonly role: ControlRole) {
    this.sourceId = makeSourceId(role);
    this.channel?.addEventListener('message', this.onMessage);
    this.send({ kind: 'hello' });
    this.heartbeatTimer = window.setInterval(() => {
      if (this.role === 'visual') this.send({ kind: 'heartbeat' });
    }, VISUAL_HEARTBEAT_MS);
    this.sweepTimer = window.setInterval(() => this.emitConnection(), Math.min(500, VISUAL_TIMEOUT_MS));
    this.emitConnection(true);
  }

  onAction(listener: (action: ControlAction) => void): () => void {
    this.actionListeners.add(listener);
    return () => this.actionListeners.delete(listener);
  }

  onStatus(listener: (status: SystemStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  onStatusRequest(listener: () => void): () => void {
    this.requestListeners.add(listener);
    return () => this.requestListeners.delete(listener);
  }

  onVisualConnection(listener: (connection: VisualConnection) => void): () => void {
    this.connectionListeners.add(listener);
    listener(this.connection());
    return () => this.connectionListeners.delete(listener);
  }

  isAuthoritativeVisual(): boolean {
    return this.role === 'visual' && this.connection().authorityId === this.sourceId;
  }

  dispatch(action: ControlAction, relay = true): void {
    if (this.role !== 'visual' || this.isAuthoritativeVisual()) this.actionListeners.forEach((listener) => listener(action));
    if (relay) this.send({ kind: 'action', action });
  }

  /** Full configuration only when a client connects or a revision changes. */
  publishSnapshot(status: SystemStatus): void {
    if (this.role === 'visual' && !this.isAuthoritativeVisual()) return;
    this.latestSnapshot = status;
    this.statusListeners.forEach((listener) => listener(status));
    this.send({ kind: 'snapshot', status });
  }

  /** Fast changing outputs travel without serializing the scene configuration. */
  publishTelemetry(status: SystemStatus): void {
    if (this.role === 'visual' && !this.isAuthoritativeVisual()) return;
    this.latestSnapshot = status;
    this.statusListeners.forEach((listener) => listener(status));
    const telemetry = Object.fromEntries(Object.entries(status).filter(([key]) => key !== 'config')) as TelemetryStatus;
    this.send({ kind: 'telemetry', telemetry });
  }

  requestStatus(): void {
    this.requestListeners.forEach((listener) => listener());
    this.send({ kind: 'request-snapshot' });
  }

  dispose(): void {
    if (this.disposed) return;
    this.send({ kind: 'goodbye' });
    this.disposed = true;
    window.clearInterval(this.heartbeatTimer);
    window.clearInterval(this.sweepTimer);
    this.channel?.removeEventListener('message', this.onMessage);
    this.channel?.close();
  }

  private connection(): VisualConnection {
    this.pruneVisualHosts();
    const ids = this.role === 'visual' ? [this.sourceId, ...this.visualSeenAt.keys()] : [...this.visualSeenAt.keys()];
    return visualConnection(ids);
  }

  private emitConnection(force = false): void {
    const connection = this.connection();
    const key = `${connection.state}:${connection.hostCount}:${connection.authorityId ?? ''}`;
    if (!force && key === this.lastConnectionKey) return;
    this.lastConnectionKey = key;
    this.connectionListeners.forEach((listener) => listener(connection));
  }

  private markVisual(sourceId: string): void {
    if (sourceId === this.sourceId) return;
    this.visualSeenAt.set(sourceId, performance.now());
    this.emitConnection();
  }

  private pruneVisualHosts(): void {
    const now = performance.now();
    for (const [sourceId, seenAt] of this.visualSeenAt) {
      if (now - seenAt > VISUAL_TIMEOUT_MS) this.visualSeenAt.delete(sourceId);
    }
  }

  private send(payload: OutboundMessage): void {
    if (this.disposed) return;
    const message = { ...payload, version: PROTOCOL_VERSION, sourceId: this.sourceId, role: this.role, sequence: ++this.sequence } as ControlMessage;
    this.channel?.postMessage(message);
  }

  private onMessage = ({ data }: MessageEvent<unknown>): void => {
    if (!isControlMessage(data) || data.sourceId === this.sourceId) return;
    if (data.role === 'visual') this.markVisual(data.sourceId);
    // A restarted visual host has a new source id. Request a complete snapshot
    // immediately instead of letting a panel export an old cached config.
    if (data.kind === 'hello' && data.role === 'visual') {
      this.lastRevision.delete(data.sourceId);
      if (this.role === 'panel') this.requestStatus();
    }
    if (data.kind === 'goodbye') {
      this.visualSeenAt.delete(data.sourceId);
      this.emitConnection();
      return;
    }
    if (data.kind === 'action') {
      if (this.role !== 'visual' || this.isAuthoritativeVisual()) this.actionListeners.forEach((listener) => listener(data.action as ControlAction));
      return;
    }
    if (data.kind === 'request-snapshot') {
      if (this.role === 'visual' && this.isAuthoritativeVisual()) this.requestListeners.forEach((listener) => listener());
      return;
    }
    if (data.kind === 'snapshot') this.receiveSnapshot(data);
    if (data.kind === 'telemetry') this.receiveTelemetry(data);
  };

  private receiveSnapshot(message: Extract<ControlMessage, { kind: 'snapshot' }>): void {
    if (message.role !== 'visual' || message.sourceId !== this.connection().authorityId) return;
    const previous = this.lastRevision.get(message.sourceId) ?? -1;
    if (message.status.revision < previous) return;
    this.lastRevision.set(message.sourceId, message.status.revision);
    this.latestSnapshot = message.status;
    this.statusListeners.forEach((listener) => listener(message.status));
  }

  private receiveTelemetry(message: Extract<ControlMessage, { kind: 'telemetry' }>): void {
    if (message.role !== 'visual' || message.sourceId !== this.connection().authorityId || !this.latestSnapshot) return;
    const previous = this.lastRevision.get(message.sourceId) ?? -1;
    if (message.telemetry.revision < previous) return;
    this.lastRevision.set(message.sourceId, message.telemetry.revision);
    const status: SystemStatus = { ...this.latestSnapshot, ...(message.telemetry as TelemetryStatus) };
    this.latestSnapshot = status;
    this.statusListeners.forEach((listener) => listener(status));
  }
}
