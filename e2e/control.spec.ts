import { expect, test, type BrowserContext, type Page } from '@playwright/test';

async function openShow(context: BrowserContext): Promise<{ visual: Page; panel: Page }> {
  const visual = await context.newPage();
  const panel = await context.newPage();
  await visual.goto('/');
  await panel.goto('/?mode=panel');
  await expect(panel.locator('[data-status="visual"]')).toHaveText('CONECTADO');
  return { visual, panel };
}

test('un host visual sincroniza escenas, parámetros, blackout y calidad con un panel remoto', async ({ browser }) => {
  const context = await browser.newContext();
  const consoleErrors: string[] = [];
  const { visual, panel } = await openShow(context);
  for (const page of [visual, panel]) page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });

  await expect(panel.getByRole('button', { name: 'Micrófono en vista visual' })).toBeDisabled();
  await expect(panel.locator('[data-mic-remote-hint]')).toContainText('vista visual');
  await expect(panel.locator('[data-impulse]')).toHaveCount(10);
  await expect(panel.locator('[data-impulse="1"]')).toHaveClass(/active/);
  await expect(panel.locator('[data-impulse="2"]')).toBeEnabled();
  await expect(panel.locator('[data-impulse="3"]')).toBeEnabled();
  await expect(panel.locator('[data-impulse="4"]')).toBeEnabled();
  await expect(panel.locator('[data-impulse="5"]')).toBeEnabled();
  await panel.locator('[data-impulse="1"]').click();
  await expect(visual.locator('[data-impulse="1"]')).toHaveClass(/active/);
  await panel.locator('[data-action="test-note"]').click();
  await expect(visual.locator('[data-note-impulse-count]')).toHaveText('1');
  await panel.locator('[data-impulse="3"]').click();
  await expect(visual.locator('[data-impulse="3"]')).toHaveClass(/active/);
  await panel.locator('[data-action="test-note"]').click();
  await expect(visual.locator('[data-note-impulse-count]')).toHaveText('1');
  await expect(panel.locator('[data-note-pitches]')).toContainText('C4');
  await panel.locator('[data-impulse="2"]').click();
  await expect(visual.locator('[data-impulse="2"]')).toHaveClass(/active/);
  await panel.locator('[data-action="test-note"]').click();
  await expect(visual.locator('[data-note-impulse-count]')).toHaveText('1');
  await panel.locator('[data-impulse="4"]').click();
  await expect(visual.locator('[data-impulse="4"]')).toHaveClass(/active/);
  await expect(panel.locator('[data-voronoi-cells]')).toHaveText('5');
  await panel.locator('[data-test-midi="84"]').click();
  await expect(panel.locator('[data-voronoi-cells]')).toHaveText('6');
  await expect(panel.locator('[data-note-pitches]')).toContainText('C6');
  await panel.locator('[data-test-midi="48"]').click();
  await expect(panel.locator('[data-voronoi-cells]')).toHaveText('5');
  await expect(panel.locator('[data-note-pitches]')).toContainText('C3');
  await panel.locator('[data-impulse="5"]').click();
  await expect(visual.locator('[data-impulse="5"]')).toHaveClass(/active/);
  await expect(panel.getByRole('button', { name: 'Grave · 3 lados' })).toBeEnabled();
  await expect(panel.getByRole('button', { name: 'Media · 5 lados' })).toBeEnabled();
  await expect(panel.getByRole('button', { name: 'Aguda · 8 lados' })).toBeEnabled();
  await panel.locator('[data-action="test-chord"]').click();
  await expect(panel.locator('[data-impulse-hint-text]')).toContainText('Gravedad OFF');

  for (let scene = 1; scene <= 6; scene += 1) {
    await panel.locator(`[data-scene="${scene}"]`).click();
    await expect(visual.locator(`[data-scene="${scene}"]`)).toHaveClass(/active/);
    await expect(panel.locator(`[data-scene="${scene}"]`)).toHaveClass(/active/);
  }
  await visual.keyboard.press('3');
  await expect(panel.locator('[data-scene="3"]')).toHaveClass(/active/);

  await panel.locator('[data-scene="2"]').click();
  await panel.locator('[data-freeze="fader-carga"]').click();
  await expect(visual.locator('[data-freeze="fader-carga"]')).toHaveText('Descongelar');
  await panel.locator('[data-scene="3"]').click();
  await panel.locator('[data-scene="2"]').click();
  await expect(panel.locator('[data-freeze="fader-carga"]')).toHaveText('Congelar');

  await panel.locator('[data-override-enabled="tension"]').check();
  await expect(visual.locator('[data-override-enabled="tension"]')).toBeChecked();
  await panel.locator('[data-wire="0"]').selectOption('density');
  await expect(visual.locator('[data-wire="0"]')).toHaveValue('density');

  const panelFader = panel.locator('[data-param-gesture="fader-carga"][data-param-key="fuga"]');
  await panelFader.fill('0.33');
  await expect(visual.locator('[data-param-gesture="fader-carga"][data-param-key="fuga"]')).toHaveValue('0.33');
  await panel.locator('[data-action="save"]').click();
  await visual.reload();
  await expect(visual.locator('[data-scene="1"]')).toHaveClass(/active/);
  await panel.locator('[data-scene="2"]').click();
  await expect(visual.locator('[data-param-gesture="fader-carga"][data-param-key="fuga"]')).toHaveValue('0.33');
  await expect(panel.locator('[data-param-gesture="fader-carga"][data-param-key="fuga"]')).toHaveValue('0.33');

  const exported = panel.waitForEvent('download');
  await panel.locator('[data-action="export"]').click();
  const exportFile = await exported;
  expect(exportFile.suggestedFilename()).toBe('piano-visuales-show-config-v2.json');
  const exportPath = await exportFile.path();
  expect(exportPath).not.toBeNull();
  if (!exportPath) throw new Error('No se pudo leer el preset exportado.');
  await panel.locator('#import-file').setInputFiles(exportPath);
  await expect(visual.locator('.notice')).toContainText('Preset importado');
  await expect(visual.locator('[data-scene="1"]')).toHaveClass(/active/);
  await panel.locator('[data-scene="2"]').click();
  await expect(panelFader).toHaveValue('0.33');

  const invalidImport = panel.waitForEvent('dialog');
  await panel.locator('#import-file').setInputFiles({
    name: 'preset-roto.json',
    mimeType: 'application/json',
    buffer: Buffer.from('{no es json'),
  });
  const dialog = await invalidImport;
  expect(dialog.message()).not.toBe('');
  await dialog.dismiss();
  await expect(panelFader).toHaveValue('0.33');

  await panel.locator('[data-action="blackout"]').click();
  await expect(visual.locator('[data-action="blackout"]')).toHaveText('RESTAURAR');
  await panel.getByRole('button', { name: 'Modo seguro' }).click();
  await expect(visual.locator('[data-status="webgl-detail"]')).toContainText('safe');
  await expect(panel.locator('[data-status="webgl-detail"]')).toContainText('safe');

  expect(consoleErrors).toEqual([]);
  await context.close();
});

test('el renderer informa pérdida y restauración de contexto WebGL', async ({ browser }) => {
  const context = await browser.newContext();
  const { visual, panel } = await openShow(context);
  const contextExtensionAvailable = await visual.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('#visual-canvas');
    const gl = canvas?.getContext('webgl2') ?? canvas?.getContext('webgl');
    const extension = gl?.getExtension('WEBGL_lose_context');
    if (!extension) return false;
    extension.loseContext();
    window.setTimeout(() => extension.restoreContext(), 200);
    return true;
  });
  test.skip(!contextExtensionAvailable, 'Chrome no expone WEBGL_lose_context en esta GPU.');
  await expect(panel.locator('[data-status="webgl"]')).toHaveText('PERDIDO');
  await expect(panel.locator('[data-status="webgl"]')).toHaveText('OK', { timeout: 5_000 });
  await context.close();
});

test('el transcriptor polifónico carga en un Worker antes de usar el micrófono', async ({ browser }) => {
  const context = await browser.newContext();
  const visual = await context.newPage();
  const consoleErrors: string[] = [];
  visual.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  await visual.goto('/');
  await expect(visual.locator('[data-status="transcriber"]')).toHaveText('LISTA', { timeout: 30_000 });
  expect(consoleErrors).toEqual([]);
  await context.close();
});

test('el transcriptor recibe los buffers de audio que le envía la vista', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { PolyphonicNoteTranscriber } = await import('/src/audio/polyphonic-transcriber.ts');
    const transcriber = new PolyphonicNoteTranscriber();
    const statuses: string[] = [];
    const unsubscribeStatusLog = transcriber.subscribeStatus((status, error) => statuses.push(`${status}${error ? `:${error}` : ''}`));
    const ready = await new Promise<boolean>((resolve) => {
      const timeout = window.setTimeout(() => resolve(false), 10_000);
      const unsubscribe = transcriber.subscribeStatus((status) => {
        if (status !== 'ready') return;
        window.clearTimeout(timeout);
        unsubscribe();
        resolve(true);
      });
    });
    if (!ready) {
      transcriber.dispose();
      return { ready, notes: [] as number[], statuses, telemetry: transcriber.getTelemetry() };
    }
    const sampleRate = 22_050;
    const samples = new Float32Array(sampleRate * 2);
    for (let index = 0; index < samples.length; index += 1) {
      const time = index / sampleRate;
      const envelope = time < 0.35 ? 0 : Math.min(1, (time - 0.35) / 0.018) * Math.exp(-(time - 0.35) * 1.8);
      samples[index] = envelope * (
        0.56 * Math.sin(2 * Math.PI * 261.63 * time)
        + 0.24 * Math.sin(2 * Math.PI * 523.25 * time)
        + 0.12 * Math.sin(2 * Math.PI * 784.88 * time)
      );
    }
    for (let offset = 0; offset < samples.length; offset += 2048) transcriber.push(samples.slice(offset, offset + 2048), sampleRate);
    await new Promise((resolve) => window.setTimeout(resolve, 200));
    unsubscribeStatusLog();
    const telemetry = transcriber.getTelemetry();
    transcriber.dispose();
    return { ready, statuses, telemetry };
  });
  expect(result.ready).toBe(true);
  expect(result.telemetry.inputChunks).toBeGreaterThanOrEqual(22);
  expect(result.telemetry.receivedSamples).toBe(44_100);
  await context.close();
});

test('el panel alerta tanto hosts visuales duplicados como desconexión', async ({ browser }) => {
  const context = await browser.newContext();
  const { visual, panel } = await openShow(context);
  const duplicate = await context.newPage();
  await duplicate.goto('/');
  await expect(panel.locator('[data-status="visual"]')).toHaveText('DUPLICADO');
  await expect(panel.locator('[data-status="visual-detail"]')).toContainText('2 hosts');

  await duplicate.close();
  await expect(panel.locator('[data-status="visual"]')).toHaveText('CONECTADO');
  await visual.close();
  await expect(panel.locator('[data-status="visual"]')).toHaveText('DESCONECTADO', { timeout: 5_000 });
  await context.close();
});
