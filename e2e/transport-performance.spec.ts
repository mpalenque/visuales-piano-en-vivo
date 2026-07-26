import { expect, test, type Page } from '@playwright/test';

interface PerformanceFixture {
  name: 'mirror-law';
  materialOverride?: 'diffuse';
}

interface FrameStatus {
  fpsAverage: number;
  frameTimeP95Ms: number;
  hrcResolution: number;
  hrcFrustumsPerFrame: number;
  opticalActive: boolean;
  opticalDrawCalls: number;
  opticalTargetTextureCount: number;
  opticalTargetMemoryBytes: number;
}

interface GpuPassStats {
  passName: string;
  sampleCount: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
}

interface GpuSnapshot {
  supported: boolean;
  droppedPasses: number;
  discardedDisjointQueries: number;
  discardedInvalidResults: number;
  passes: GpuPassStats[];
}

interface PerformanceSegment {
  label: string;
  status: FrameStatus;
  gpu: GpuSnapshot | null;
}

async function readStatus(page: Page): Promise<FrameStatus> {
  const status = await page.evaluate(() => (
    window as Window & {
      __PIANO_OPTICAL_TEST__?: { readStatus: () => FrameStatus };
    }
  ).__PIANO_OPTICAL_TEST__?.readStatus());
  if (!status) throw new Error('No se expuso el status del renderer.');
  return status;
}

async function measureSegment(
  page: Page,
  label: string,
  fixture: PerformanceFixture,
): Promise<PerformanceSegment> {
  await page.evaluate((nextFixture) => (
    window as Window & {
      __PIANO_OPTICAL_TEST__?: {
        setTransportFixture: (options: PerformanceFixture) => void;
      };
    }
  ).__PIANO_OPTICAL_TEST__?.setTransportFixture(nextFixture), fixture);

  // Shader compilation and lazy allocation are deliberately outside the
  // steady-state sample.
  await page.waitForTimeout(1_200);
  await page.evaluate(() => (
    window as Window & {
      __PIANO_OPTICAL_TEST__?: {
        resetPerformanceSample: () => void;
      };
    }
  ).__PIANO_OPTICAL_TEST__?.resetPerformanceSample());
  await page.waitForTimeout(2_500);

  const status = await readStatus(page);
  const gpu = await page.evaluate(() => (
    window as Window & {
      __PIANO_OPTICAL_TEST__?: {
        readGpuTiming: () => GpuSnapshot | null;
      };
    }
  ).__PIANO_OPTICAL_TEST__?.readGpuTiming()) ?? null;
  return { label, status, gpu };
}

test(
  'A/B/A mantiene HRC y el presupuesto de frame al activar espejo',
  async ({ browser }) => {
    test.skip(
      process.env.TRANSPORT_PERF !== '1',
      'Benchmark manual: ejecutar con TRANSPORT_PERF=1.',
    );
    test.setTimeout(60_000);
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto('/?opticalTest=1&transportTelemetry=1');
    await page.locator('[data-impulse="3"]').click();

    const control: PerformanceFixture = {
      name: 'mirror-law',
      materialOverride: 'diffuse',
    };
    const mirror: PerformanceFixture = { name: 'mirror-law' };
    const firstControl = await measureSegment(page, 'A1-control', control);
    const optical = await measureSegment(page, 'B-mirror', mirror);
    const secondControl = await measureSegment(page, 'A2-control', control);

    const controlFps = (
      firstControl.status.fpsAverage + secondControl.status.fpsAverage
    ) * 0.5;
    const controlP95 = (
      firstControl.status.frameTimeP95Ms
        + secondControl.status.frameTimeP95Ms
    ) * 0.5;
    const fpsDropRatio = (
      controlFps - optical.status.fpsAverage
    ) / Math.max(controlFps, 1e-6);
    const p95Increase = optical.status.frameTimeP95Ms - controlP95;
    const p95Budget = Math.min(1, controlP95 * 0.05);

    console.log(JSON.stringify({
      firstControl,
      optical,
      secondControl,
      result: {
        controlFps,
        controlP95,
        fpsDropRatio,
        p95Increase,
        p95Budget,
      },
    }));

    expect(firstControl.status.hrcResolution).toBe(512);
    expect(optical.status.hrcResolution).toBe(512);
    expect(secondControl.status.hrcResolution).toBe(512);
    expect(firstControl.status.hrcFrustumsPerFrame).toBe(2);
    expect(optical.status.hrcFrustumsPerFrame).toBe(2);
    expect(secondControl.status.hrcFrustumsPerFrame).toBe(2);
    expect(optical.status.opticalActive).toBe(true);
    expect(optical.status.opticalDrawCalls).toBe(2);
    expect(optical.status.opticalTargetTextureCount).toBe(6);
    expect(optical.status.opticalTargetMemoryBytes).toBe(491_520);
    expect(fpsDropRatio).toBeLessThanOrEqual(0.02);
    expect(p95Increase).toBeLessThanOrEqual(p95Budget);

    for (const segment of [firstControl, optical, secondControl]) {
      if (!segment.gpu?.supported) continue;
      expect(segment.gpu.droppedPasses).toBe(0);
      expect(segment.gpu.discardedDisjointQueries).toBe(0);
      expect(segment.gpu.discardedInvalidResults).toBe(0);
      expect(segment.gpu.passes.some(
        (pass) => pass.passName === 'hrc-propagation'
          && pass.sampleCount > 0,
      )).toBe(true);
    }

    await context.close();
  },
);
