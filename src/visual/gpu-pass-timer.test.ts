import { describe, expect, it } from 'vitest';
import {
  GpuPassTimer,
  type GpuPassTimerContext,
} from './gpu-pass-timer';

interface MockQueryState {
  available: boolean;
  elapsedNanoseconds: number;
}

class MockGpuTimerContext implements GpuPassTimerContext {
  readonly QUERY_RESULT = 0x8866;
  readonly QUERY_RESULT_AVAILABLE = 0x8867;
  readonly TIME_ELAPSED_EXT = 0x88bf;
  readonly GPU_DISJOINT_EXT = 0x8fbb;
  readonly queries = new Map<WebGLQuery, MockQueryState>();
  readonly endedQueries: WebGLQuery[] = [];
  availabilityReads = 0;
  resultReads = 0;
  deletedQueries = 0;
  disjoint = false;
  private activeQuery: WebGLQuery | null = null;
  private nextQueryId = 1;

  constructor(private readonly extensionAvailable = true) {}

  getExtension(name: string): unknown {
    if (!this.extensionAvailable || name !== 'EXT_disjoint_timer_query_webgl2') {
      return null;
    }
    return {
      TIME_ELAPSED_EXT: this.TIME_ELAPSED_EXT,
      GPU_DISJOINT_EXT: this.GPU_DISJOINT_EXT,
    };
  }

  createQuery(): WebGLQuery {
    const query = { id: this.nextQueryId } as unknown as WebGLQuery;
    this.nextQueryId += 1;
    this.queries.set(query, {
      available: false,
      elapsedNanoseconds: 0,
    });
    return query;
  }

  deleteQuery(query: WebGLQuery | null): void {
    if (!query) return;
    this.queries.delete(query);
    this.deletedQueries += 1;
  }

  beginQuery(target: number, query: WebGLQuery): void {
    if (target !== this.TIME_ELAPSED_EXT || this.activeQuery) {
      throw new Error('Invalid mock beginQuery');
    }
    this.activeQuery = query;
    const state = this.queries.get(query);
    if (!state) throw new Error('Unknown mock query');
    state.available = false;
    state.elapsedNanoseconds = 0;
  }

  endQuery(target: number): void {
    if (target !== this.TIME_ELAPSED_EXT || !this.activeQuery) {
      throw new Error('Invalid mock endQuery');
    }
    this.endedQueries.push(this.activeQuery);
    this.activeQuery = null;
  }

  getQueryParameter(query: WebGLQuery, parameter: number): unknown {
    const state = this.queries.get(query);
    if (!state) throw new Error('Unknown mock query');
    if (parameter === this.QUERY_RESULT_AVAILABLE) {
      this.availabilityReads += 1;
      return state.available;
    }
    if (parameter === this.QUERY_RESULT) {
      this.resultReads += 1;
      return state.elapsedNanoseconds;
    }
    throw new Error('Unknown mock query parameter');
  }

  getParameter(parameter: number): unknown {
    if (parameter !== this.GPU_DISJOINT_EXT) {
      throw new Error('Unknown mock context parameter');
    }
    return this.disjoint;
  }

  completeLast(milliseconds: number): void {
    const query = this.endedQueries.at(-1);
    if (!query) throw new Error('No ended query to complete');
    this.complete(query, milliseconds);
  }

  complete(query: WebGLQuery, milliseconds: number): void {
    const state = this.queries.get(query);
    if (!state) throw new Error('Unknown mock query');
    state.elapsedNanoseconds = milliseconds * 1_000_000;
    state.available = true;
  }
}

const recordSample = (
  context: MockGpuTimerContext,
  timer: GpuPassTimer,
  passName: string,
  milliseconds: number,
): void => {
  const token = timer.beginPass(passName);
  expect(token).not.toBeNull();
  expect(timer.endPass(token)).toBe(true);
  context.completeLast(milliseconds);
  expect(timer.poll()).toBe(1);
};

describe('GpuPassTimer', () => {
  it('falls back to a clean no-op when the extension is unavailable', () => {
    const context = new MockGpuTimerContext(false);
    const timer = new GpuPassTimer(context);
    let operationCalls = 0;

    expect(timer.supported).toBe(false);
    expect(timer.beginPass('hrc')).toBeNull();
    timer.measure('hrc', () => {
      operationCalls += 1;
    });

    expect(operationCalls).toBe(1);
    expect(timer.poll()).toBe(0);
    expect(timer.snapshot).toMatchObject({
      supported: false,
      pendingQueries: 0,
      allocatedQueries: 0,
      passes: [],
    });
  });

  it('never reads QUERY_RESULT before the asynchronous result is available', () => {
    const context = new MockGpuTimerContext();
    const timer = new GpuPassTimer(context);
    const token = timer.beginPass('optical-march');

    expect(timer.endPass(token)).toBe(true);
    expect(timer.poll()).toBe(0);
    expect(context.availabilityReads).toBeGreaterThan(0);
    expect(context.resultReads).toBe(0);
    expect(timer.snapshot.pendingQueries).toBe(1);

    context.completeLast(1.25);
    expect(timer.poll()).toBe(1);
    expect(context.resultReads).toBe(1);
    expect(timer.getPassStats('optical-march')).toMatchObject({
      sampleCount: 1,
      totalSamples: 1,
      latestMs: 1.25,
      p50Ms: 1.25,
      p95Ms: 1.25,
      p99Ms: 1.25,
    });
  });

  it('keeps a bounded sample ring and exposes p50, p95 and p99 per pass', () => {
    const context = new MockGpuTimerContext();
    const timer = new GpuPassTimer(context, { maxSamplesPerPass: 4 });

    for (const milliseconds of [1, 2, 3, 4, 5]) {
      recordSample(context, timer, 'hrc-propagation', milliseconds);
    }
    recordSample(context, timer, 'optical-resolve', 0.2);

    expect(timer.getPassStats('hrc-propagation')).toMatchObject({
      sampleCount: 4,
      totalSamples: 5,
      latestMs: 5,
      p50Ms: 3.5,
    });
    expect(timer.getPassStats('hrc-propagation')?.p95Ms).toBeCloseTo(4.85);
    expect(timer.getPassStats('hrc-propagation')?.p99Ms).toBeCloseTo(4.97);
    expect(timer.getAllPassStats().map((stats) => stats.passName)).toEqual([
      'hrc-propagation',
      'optical-resolve',
    ]);
  });

  it('discards completed queries from a disjoint GPU interval', () => {
    const context = new MockGpuTimerContext();
    const timer = new GpuPassTimer(context);
    const token = timer.beginPass('glass');

    expect(timer.endPass(token)).toBe(true);
    context.completeLast(2.5);
    context.disjoint = true;

    expect(timer.poll()).toBe(0);
    expect(context.resultReads).toBe(0);
    expect(timer.getPassStats('glass')).toBeNull();
    expect(timer.snapshot.discardedDisjointQueries).toBe(1);

    context.disjoint = false;
    recordSample(context, timer, 'glass', 1.5);
    expect(timer.getPassStats('glass')?.latestMs).toBe(1.5);
  });

  it('drops telemetry instead of waiting when every query slot is pending', () => {
    const context = new MockGpuTimerContext();
    const timer = new GpuPassTimer(context, { maxPendingQueries: 2 });
    const firstToken = timer.beginPass('first');
    expect(timer.endPass(firstToken)).toBe(true);
    const firstQuery = context.endedQueries.at(-1)!;
    const secondToken = timer.beginPass('second');
    expect(timer.endPass(secondToken)).toBe(true);
    const secondQuery = context.endedQueries.at(-1)!;

    expect(timer.beginPass('third')).toBeNull();
    expect(timer.snapshot).toMatchObject({
      pendingQueries: 2,
      allocatedQueries: 2,
      droppedPasses: 1,
    });
    expect(context.resultReads).toBe(0);

    context.complete(firstQuery, 1);
    context.complete(secondQuery, 2);
    expect(timer.poll()).toBe(2);
    expect(timer.snapshot.pendingQueries).toBe(0);
  });

  it('does not mix a pending result into a new sample window', () => {
    const context = new MockGpuTimerContext();
    const timer = new GpuPassTimer(context);
    const staleToken = timer.beginPass('optical-march');

    expect(timer.endPass(staleToken)).toBe(true);
    timer.clearSamples();
    context.completeLast(4);

    expect(timer.poll()).toBe(0);
    expect(timer.getPassStats('optical-march')).toBeNull();
    expect(timer.snapshot).toMatchObject({
      discardedDisjointQueries: 0,
      discardedInvalidResults: 0,
    });

    recordSample(context, timer, 'optical-march', 1);
    expect(timer.getPassStats('optical-march')).toMatchObject({
      sampleCount: 1,
      totalSamples: 1,
      latestMs: 1,
    });
  });

  it('reacquires clean query state after WebGL context restoration', () => {
    const context = new MockGpuTimerContext();
    const timer = new GpuPassTimer(context);
    const staleToken = timer.beginPass('hrc-seed');

    expect(timer.endPass(staleToken)).toBe(true);
    expect(timer.snapshot.pendingQueries).toBe(1);
    timer.restoreAfterContextLoss();
    expect(timer.snapshot).toMatchObject({
      supported: true,
      pendingQueries: 0,
      allocatedQueries: 0,
      passes: [],
    });

    recordSample(context, timer, 'hrc-seed', 0.75);
    expect(timer.getPassStats('hrc-seed')?.latestMs).toBe(0.75);
  });

  it('ends an active query and releases every allocated query on dispose', () => {
    const context = new MockGpuTimerContext();
    const timer = new GpuPassTimer(context);

    expect(timer.beginPass('active')).not.toBeNull();
    timer.dispose();

    expect(timer.supported).toBe(false);
    expect(timer.beginPass('after-dispose')).toBeNull();
    expect(context.deletedQueries).toBe(1);
  });
});
