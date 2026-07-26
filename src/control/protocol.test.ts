import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, isControlMessage, visualConnection } from './protocol';

describe('protocolo de control', () => {
  it('acepta solo envelopes versionados y con payload consistente', () => {
    expect(isControlMessage({ version: PROTOCOL_VERSION, sourceId: 'panel-a', role: 'panel', sequence: 1, kind: 'request-snapshot' })).toBe(true);
    expect(isControlMessage({ version: PROTOCOL_VERSION + 1, sourceId: 'panel-a', role: 'panel', sequence: 1, kind: 'request-snapshot' })).toBe(false);
    expect(isControlMessage({ version: PROTOCOL_VERSION, sourceId: '', role: 'panel', sequence: 1, kind: 'request-snapshot' })).toBe(false);
    expect(isControlMessage({ version: PROTOCOL_VERSION, sourceId: 'panel-a', role: 'panel', sequence: 0, kind: 'action', action: { type: 'scene' } })).toBe(false);
    expect(isControlMessage({ version: PROTOCOL_VERSION, sourceId: 'panel-a', role: 'panel', sequence: 1, kind: 'action', action: { type: 'scene' } })).toBe(true);
    expect(isControlMessage({ version: PROTOCOL_VERSION, sourceId: 'panel-a', role: 'other', sequence: 1, kind: 'heartbeat' })).toBe(false);
    expect(isControlMessage({ version: PROTOCOL_VERSION, sourceId: 'panel-a', role: 'panel', sequence: 1, kind: 'snapshot', status: { revision: 'old', config: {} } })).toBe(false);
    expect(isControlMessage({ version: PROTOCOL_VERSION, sourceId: 'panel-a', role: 'panel', sequence: 1, kind: 'telemetry', telemetry: { revision: 1 } })).toBe(true);
  });

  it('elige una autoridad estable y hace visible cualquier duplicado', () => {
    expect(visualConnection([])).toEqual({ hostCount: 0, authorityId: null, state: 'disconnected' });
    expect(visualConnection(['visual-b'])).toEqual({ hostCount: 1, authorityId: 'visual-b', state: 'connected' });
    expect(visualConnection(['visual-b', 'visual-a', 'visual-a'])).toEqual({ hostCount: 2, authorityId: 'visual-a', state: 'multiple' });
  });
});
