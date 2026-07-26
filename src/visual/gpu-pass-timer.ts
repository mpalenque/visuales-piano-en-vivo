const TIMER_QUERY_EXTENSION = 'EXT_disjoint_timer_query_webgl2';
const DEFAULT_MAX_PENDING_QUERIES = 16;
const DEFAULT_MAX_SAMPLES_PER_PASS = 240;
const NANOSECONDS_PER_MILLISECOND = 1_000_000;

interface DisjointTimerQueryExtension {
  readonly TIME_ELAPSED_EXT: number;
  readonly GPU_DISJOINT_EXT: number;
}

/**
 * The WebGL2 surface used by the timer. Keeping this interface narrow makes
 * the query lifecycle testable without constructing a browser WebGL context.
 */
export interface GpuPassTimerContext {
  readonly QUERY_RESULT: number;
  readonly QUERY_RESULT_AVAILABLE: number;
  getExtension(name: string): unknown;
  createQuery(): WebGLQuery | null;
  deleteQuery(query: WebGLQuery | null): void;
  beginQuery(target: number, query: WebGLQuery): void;
  endQuery(target: number): void;
  getQueryParameter(query: WebGLQuery, parameter: number): unknown;
  getParameter(parameter: number): unknown;
}

export interface GpuPassTimerOptions {
  /**
   * Maximum number of active or unresolved WebGL queries. When the pool is
   * exhausted the render pass still runs, but that timing sample is dropped.
   */
  maxPendingQueries?: number;
  /**
   * Bounded rolling window used to calculate each pass percentile.
   */
  maxSamplesPerPass?: number;
}

export interface GpuPassTimerToken {
  readonly id: number;
}

export interface GpuPassTimingStats {
  readonly passName: string;
  readonly sampleCount: number;
  readonly totalSamples: number;
  readonly latestMs: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
}

export interface GpuPassTimerSnapshot {
  readonly supported: boolean;
  readonly activePass: string | null;
  readonly pendingQueries: number;
  readonly allocatedQueries: number;
  readonly droppedPasses: number;
  readonly discardedDisjointQueries: number;
  readonly discardedInvalidResults: number;
  readonly passes: readonly GpuPassTimingStats[];
}

interface ActiveQuery {
  readonly query: WebGLQuery;
  readonly passName: string;
  readonly token: GpuPassTimerToken;
  readonly generation: number;
  invalidated: boolean;
}

interface PendingQuery {
  readonly query: WebGLQuery;
  readonly passName: string;
  readonly generation: number;
  invalidated: boolean;
}

interface PassSampleWindow {
  readonly values: number[];
  cursor: number;
  latestMs: number;
  totalSamples: number;
}

const positiveInteger = (value: number | undefined, fallback: number): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value));
};

const isDisjointTimerExtension = (
  value: unknown,
): value is DisjointTimerQueryExtension => {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as {
    TIME_ELAPSED_EXT?: unknown;
    GPU_DISJOINT_EXT?: unknown;
  };
  return typeof candidate.TIME_ELAPSED_EXT === 'number'
    && typeof candidate.GPU_DISJOINT_EXT === 'number';
};

const percentile = (sortedValues: readonly number[], quantile: number): number => {
  if (sortedValues.length === 0) return 0;
  const position = (sortedValues.length - 1) * quantile;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  const lower = sortedValues[lowerIndex];
  const upper = sortedValues[upperIndex];
  return lower + (upper - lower) * (position - lowerIndex);
};

/**
 * Non-blocking GPU pass telemetry for WebGL2.
 *
 * A query result is read only after QUERY_RESULT_AVAILABLE becomes true.
 * Pending queries are bounded, disjoint intervals are discarded, and lack of
 * extension support degrades to a no-op without affecting the measured pass.
 */
export class GpuPassTimer {
  private readonly context: GpuPassTimerContext | null;
  private extension: DisjointTimerQueryExtension | null;
  private readonly maxPendingQueries: number;
  private readonly maxSamplesPerPass: number;
  private readonly allocatedQuerySet = new Set<WebGLQuery>();
  private readonly freeQueries: WebGLQuery[] = [];
  private pendingQueries: PendingQuery[] = [];
  private readonly samplesByPass = new Map<string, PassSampleWindow>();
  private activeQuery: ActiveQuery | null = null;
  private sampleGeneration = 0;
  private nextTokenId = 1;
  private droppedPasses = 0;
  private discardedDisjointQueries = 0;
  private discardedInvalidResults = 0;
  private disposed = false;

  constructor(
    context: GpuPassTimerContext | null,
    options: GpuPassTimerOptions = {},
  ) {
    this.context = context;
    this.maxPendingQueries = positiveInteger(
      options.maxPendingQueries,
      DEFAULT_MAX_PENDING_QUERIES,
    );
    this.maxSamplesPerPass = positiveInteger(
      options.maxSamplesPerPass,
      DEFAULT_MAX_SAMPLES_PER_PASS,
    );

    let extension: DisjointTimerQueryExtension | null = null;
    if (context) {
      try {
        const candidate = context.getExtension(TIMER_QUERY_EXTENSION);
        if (isDisjointTimerExtension(candidate)) extension = candidate;
      } catch {
        // Context loss or an incomplete implementation is a clean no-op.
      }
    }
    this.extension = extension;
  }

  get supported(): boolean {
    return !this.disposed && this.context !== null && this.extension !== null;
  }

  /**
   * Starts one timer query. WebGL does not allow nested TIME_ELAPSED queries,
   * so a second begin while another pass is active is dropped.
   */
  beginPass(passName: string): GpuPassTimerToken | null {
    if (!this.supported) return null;
    this.poll();

    const normalizedName = passName.trim();
    if (normalizedName.length === 0 || this.activeQuery) {
      this.droppedPasses += 1;
      return null;
    }

    const query = this.acquireQuery();
    if (!query) {
      this.droppedPasses += 1;
      return null;
    }

    const token = Object.freeze({ id: this.nextTokenId });
    this.nextTokenId += 1;
    try {
      this.context!.beginQuery(this.extension!.TIME_ELAPSED_EXT, query);
    } catch {
      this.retireQuery(query);
      this.droppedPasses += 1;
      return null;
    }
    this.activeQuery = {
      query,
      passName: normalizedName,
      token,
      generation: this.sampleGeneration,
      invalidated: false,
    };
    return token;
  }

  /**
   * Ends the pass associated with the exact token returned by beginPass.
   */
  endPass(token: GpuPassTimerToken | null): boolean {
    if (!this.supported || !token || !this.activeQuery) return false;
    if (token !== this.activeQuery.token) return false;

    const completed = this.activeQuery;
    this.activeQuery = null;
    try {
      this.context!.endQuery(this.extension!.TIME_ELAPSED_EXT);
    } catch {
      this.retireQuery(completed.query);
      this.droppedPasses += 1;
      return false;
    }
    this.pendingQueries.push({
      query: completed.query,
      passName: completed.passName,
      generation: completed.generation,
      invalidated: completed.invalidated,
    });
    return true;
  }

  /**
   * Convenience wrapper for synchronous WebGL render calls.
   */
  measure<T>(passName: string, operation: () => T): T {
    const token = this.beginPass(passName);
    try {
      return operation();
    } finally {
      this.endPass(token);
    }
  }

  /**
   * Polls unresolved queries without waiting. QUERY_RESULT is never requested
   * before QUERY_RESULT_AVAILABLE reports completion.
   *
   * @returns number of valid samples recorded by this poll.
   */
  poll(): number {
    if (!this.supported || !this.context || !this.extension) return 0;

    let disjoint: boolean;
    try {
      disjoint = Boolean(
        this.context.getParameter(this.extension.GPU_DISJOINT_EXT),
      );
    } catch {
      return 0;
    }
    if (disjoint) {
      if (this.activeQuery) this.activeQuery.invalidated = true;
      for (const pending of this.pendingQueries) pending.invalidated = true;
    }

    let completedSamples = 0;
    const unresolved: PendingQuery[] = [];
    for (const pending of this.pendingQueries) {
      let available: boolean;
      try {
        available = Boolean(this.context.getQueryParameter(
          pending.query,
          this.context.QUERY_RESULT_AVAILABLE,
        ));
      } catch {
        this.retireQuery(pending.query);
        this.discardedInvalidResults += 1;
        continue;
      }
      if (!available) {
        unresolved.push(pending);
        continue;
      }

      if (pending.generation !== this.sampleGeneration) {
        this.releaseQuery(pending.query);
        continue;
      }

      if (pending.invalidated) {
        this.discardedDisjointQueries += 1;
        this.releaseQuery(pending.query);
        continue;
      }

      let elapsedNanoseconds: unknown;
      try {
        elapsedNanoseconds = this.context.getQueryParameter(
          pending.query,
          this.context.QUERY_RESULT,
        );
      } catch {
        this.retireQuery(pending.query);
        this.discardedInvalidResults += 1;
        continue;
      }
      if (
        typeof elapsedNanoseconds !== 'number'
        || !Number.isFinite(elapsedNanoseconds)
        || elapsedNanoseconds < 0
      ) {
        this.discardedInvalidResults += 1;
        this.releaseQuery(pending.query);
        continue;
      }

      this.recordSample(
        pending.passName,
        elapsedNanoseconds / NANOSECONDS_PER_MILLISECOND,
      );
      completedSamples += 1;
      this.releaseQuery(pending.query);
    }
    this.pendingQueries = unresolved;
    return completedSamples;
  }

  getPassStats(passName: string): GpuPassTimingStats | null {
    const normalizedName = passName.trim();
    const samples = this.samplesByPass.get(normalizedName);
    return samples ? this.makePassStats(normalizedName, samples) : null;
  }

  getAllPassStats(): readonly GpuPassTimingStats[] {
    return [...this.samplesByPass.entries()]
      .map(([passName, samples]) => this.makePassStats(passName, samples))
      .sort((left, right) => left.passName.localeCompare(right.passName));
  }

  get snapshot(): GpuPassTimerSnapshot {
    return {
      supported: this.supported,
      activePass: this.activeQuery?.passName ?? null,
      pendingQueries: this.pendingQueries.length,
      allocatedQueries: this.allocatedQuerySet.size,
      droppedPasses: this.droppedPasses,
      discardedDisjointQueries: this.discardedDisjointQueries,
      discardedInvalidResults: this.discardedInvalidResults,
      passes: this.getAllPassStats(),
    };
  }

  clearSamples(): void {
    this.sampleGeneration += 1;
    this.samplesByPass.clear();
    this.droppedPasses = 0;
    this.discardedDisjointQueries = 0;
    this.discardedInvalidResults = 0;
  }

  /**
   * WebGL query objects and extension handles become invalid across context
   * loss. Reacquire the extension on the restored context without trying to
   * delete handles that the browser has already discarded.
   */
  restoreAfterContextLoss(): void {
    if (this.disposed || !this.context) return;
    this.activeQuery = null;
    this.pendingQueries = [];
    this.freeQueries.length = 0;
    this.allocatedQuerySet.clear();
    this.clearSamples();

    this.extension = null;
    try {
      const candidate = this.context.getExtension(TIMER_QUERY_EXTENSION);
      if (isDisjointTimerExtension(candidate)) this.extension = candidate;
    } catch {
      // An unavailable extension keeps telemetry as a clean no-op.
    }
  }

  dispose(): void {
    if (this.disposed) return;
    if (this.activeQuery && this.context && this.extension) {
      try {
        this.context.endQuery(this.extension.TIME_ELAPSED_EXT);
      } catch {
        // The context may already be lost. Deleting remains best-effort.
      }
    }
    this.activeQuery = null;
    this.pendingQueries = [];
    this.freeQueries.length = 0;
    if (this.context) {
      for (const query of this.allocatedQuerySet) {
        try {
          this.context.deleteQuery(query);
        } catch {
          // The browser owns cleanup after a lost context.
        }
      }
    }
    this.allocatedQuerySet.clear();
    this.disposed = true;
  }

  private acquireQuery(): WebGLQuery | null {
    const pooled = this.freeQueries.pop();
    if (pooled) return pooled;
    if (
      !this.context
      || this.allocatedQuerySet.size >= this.maxPendingQueries
    ) return null;

    const query = this.context.createQuery();
    if (!query) return null;
    this.allocatedQuerySet.add(query);
    return query;
  }

  private releaseQuery(query: WebGLQuery): void {
    if (this.disposed || !this.allocatedQuerySet.has(query)) return;
    this.freeQueries.push(query);
  }

  private retireQuery(query: WebGLQuery): void {
    if (!this.allocatedQuerySet.delete(query) || !this.context) return;
    try {
      this.context.deleteQuery(query);
    } catch {
      // Query retirement is best-effort during context loss.
    }
  }

  private recordSample(passName: string, milliseconds: number): void {
    let samples = this.samplesByPass.get(passName);
    if (!samples) {
      samples = {
        values: [],
        cursor: 0,
        latestMs: milliseconds,
        totalSamples: 0,
      };
      this.samplesByPass.set(passName, samples);
    }

    samples.latestMs = milliseconds;
    samples.totalSamples += 1;
    if (samples.values.length < this.maxSamplesPerPass) {
      samples.values.push(milliseconds);
      return;
    }
    samples.values[samples.cursor] = milliseconds;
    samples.cursor = (samples.cursor + 1) % this.maxSamplesPerPass;
  }

  private makePassStats(
    passName: string,
    samples: PassSampleWindow,
  ): GpuPassTimingStats {
    const sorted = [...samples.values].sort((left, right) => left - right);
    return {
      passName,
      sampleCount: sorted.length,
      totalSamples: samples.totalSamples,
      latestMs: samples.latestMs,
      p50Ms: percentile(sorted, 0.5),
      p95Ms: percentile(sorted, 0.95),
      p99Ms: percentile(sorted, 0.99),
    };
  }
}
