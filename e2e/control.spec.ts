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
  test.setTimeout(60_000);
  const context = await browser.newContext();
  const consoleErrors: string[] = [];
  const { visual, panel } = await openShow(context);
  for (const page of [visual, panel]) page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  // CI renders WebGL through software. Exercise the same transport contract at
  // 512² so the behavioural assertions are not dominated by 1024² raster time.
  await panel.getByRole('button', { name: 'Modo seguro' }).click();
  await expect(visual.locator('[data-status="webgl-detail"]')).toContainText('safe');
  await expect(panel.locator('[data-status="webgl-detail"]')).toContainText('safe');

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
  await panel.locator('[data-scene="8"]').click();
  await expect(visual.locator('[data-scene="8"]')).toHaveClass(/active/);
  await expect(panel.locator('[data-impulse-hint-text]')).toContainText('Fluido viscoelástico');
  await expect(panel.locator('[data-status="webgl-detail"]')).toContainText('fluido 650 partículas');
  await panel.locator('[data-action="test-note"]').click();
  await panel.locator('[data-scene="9"]').click();
  await expect(visual.locator('[data-scene="9"]')).toHaveClass(/active/);
  await expect(panel.locator('[data-impulse-hint-text]')).toContainText('HRC');
  await expect(panel.locator('[data-status="webgl-detail"]')).toContainText('HRC 512²');
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
  await expect(panel.locator('[data-status="webgl-detail"]')).toContainText('high');
  await panel.getByRole('button', { name: 'Modo seguro' }).click();
  await expect(visual.locator('[data-status="webgl-detail"]')).toContainText('safe');
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

  expect(consoleErrors).toEqual([]);
  await context.close();
});

test('los bloques controlan gravedad, giro y escala iluminada con Q, W y E', async ({ browser }) => {
  const context = await browser.newContext();
  const { visual, panel } = await openShow(context);
  await panel.getByRole('button', { name: 'Modo seguro' }).click();
  await expect(visual.locator('[data-status="webgl-detail"]')).toContainText('safe');
  await panel.locator('[data-impulse="3"]').click();
  await panel.locator('[data-action="test-note"]').click();
  await expect(panel.locator('[data-note-pitches]')).toContainText('C4');

  await expect(panel.locator('[data-impulse-hint-text]')).toContainText('Q gravedad ON');
  await visual.keyboard.press('q');
  await expect(panel.locator('[data-impulse-hint-text]')).toContainText('Q gravedad OFF');
  await visual.waitForTimeout(6_500);
  await expect(panel.locator('[data-impulse-hint-text]')).toContainText('W gira 90° (0°)');

  await visual.keyboard.press('w');
  await expect(panel.locator('.notice:not(.mic-remote-hint)')).toContainText('Giro manual de 90° iniciado');

  await visual.keyboard.press('e');
  await expect(panel.locator('.notice:not(.mic-remote-hint)')).toContainText('crecerá hasta 3× en 10 segundos');
  await expect(panel.locator('[data-impulse-hint-text]')).toContainText('crece a 3×');
  await visual.waitForTimeout(5_000);
  const midpointHint = await panel.locator('[data-impulse-hint-text]').innerText();
  const midpointScale = Number(midpointHint.match(/E emisores ([\d.]+)×/)?.[1]);
  const midpointPhysicsScale = Number(midpointHint.match(/física ([\d.]+)×/)?.[1]);
  const midpointMassScale = Number(midpointHint.match(/masa ([\d.]+)×/)?.[1]);
  expect(midpointScale).toBeGreaterThan(1.6);
  expect(midpointScale).toBeLessThan(2.2);
  expect(midpointPhysicsScale).toBeGreaterThan(1.6);
  expect(Math.abs(midpointPhysicsScale - midpointScale)).toBeLessThan(0.08);
  expect(midpointMassScale).toBeGreaterThan(2.5);
  expect(Math.abs(midpointMassScale - midpointPhysicsScale ** 2)).toBeLessThan(0.25);
  expect(midpointHint).toContain('W gira 90° (90°)');
  await visual.waitForTimeout(5_500);
  const expandedHint = await panel.locator('[data-impulse-hint-text]').innerText();
  const expandedScale = Number(expandedHint.match(/E emisores ([\d.]+)×/)?.[1]);
  const expandedPhysicsScale = Number(expandedHint.match(/física ([\d.]+)×/)?.[1]);
  const expandedMassScale = Number(expandedHint.match(/masa ([\d.]+)×/)?.[1]);
  expect(expandedScale).toBeGreaterThan(2.85);
  expect(expandedPhysicsScale).toBeGreaterThan(2.85);
  expect(expandedMassScale).toBeGreaterThan(8);
  await visual.keyboard.press('e');
  await expect(panel.locator('.notice:not(.mic-remote-hint)')).toContainText('volverá a 1× en 10 segundos');
  await expect(panel.locator('[data-impulse-hint-text]')).toContainText('vuelve a 1×');

  await context.close();
});

test('la escena 10 responde suavemente a A–G y limita sus emisores', async ({ browser }) => {
  const context = await browser.newContext();
  const { visual, panel } = await openShow(context);
  await panel.getByRole('button', { name: 'Modo seguro' }).click();
  await expect(visual.locator('[data-status="webgl-detail"]')).toContainText('safe');

  await visual.keyboard.press('0');
  const sceneButton = panel.locator('[data-scene="10"]');
  await expect(sceneButton).toHaveClass(/active/);
  await expect(sceneButton).toContainText('Órbita de Penumbra');

  const controls = panel.locator('[data-radiance-control]');
  await expect(controls).toHaveCount(5);
  await expect(panel.locator('[data-radiance-control="a"]')).toContainText('Apariencia');
  await expect(panel.locator('[data-radiance-control="s"]')).toContainText('Escala');
  await expect(panel.locator('[data-radiance-control="d"]')).toContainText('Desplazamiento');
  await expect(panel.locator('[data-radiance-control="f"]')).toContainText('Foco luminoso');
  await expect(panel.locator('[data-radiance-control="g"]')).toContainText('Gama');

  const form = panel.locator('[data-radiance-form]');
  const scaleTarget = panel.locator('[data-radiance-scale]');
  const scaleLive = panel.locator('[data-radiance-scale-live]');
  const layout = panel.locator('[data-radiance-layout]');
  const focus = panel.locator('[data-radiance-focus]');
  const palette = panel.locator('[data-radiance-palette]');
  const emitterCount = panel.locator('[data-radiance-emitter-count]');
  const numericScale = async (locator: typeof scaleLive): Promise<number> => (
    Number((await locator.textContent())?.replace('×', '').trim())
  );

  const initialForm = await form.innerText();
  await visual.keyboard.press('a');
  await expect(form).not.toHaveText(initialForm);
  const changedForm = await form.innerText();

  const initialScale = await numericScale(scaleLive);
  const initialScaleTarget = await scaleTarget.innerText();
  await visual.keyboard.press('s');
  await expect(scaleTarget).not.toHaveText(initialScaleTarget);
  const targetScale = await numericScale(scaleTarget);
  await expect.poll(() => numericScale(scaleLive), { timeout: 2_500 }).toBeGreaterThan(
    Math.min(initialScale, targetScale) + 0.005,
  );
  const intermediateScale = await numericScale(scaleLive);
  expect(intermediateScale).toBeLessThan(Math.max(initialScale, targetScale) - 0.005);

  const initialLayout = await layout.innerText();
  await visual.keyboard.press('d');
  await expect(layout).not.toHaveText(initialLayout);

  const initialPalette = await palette.innerText();
  await visual.keyboard.press('g');
  await expect(palette).not.toHaveText(initialPalette);

  const initialFocus = await focus.innerText();
  await visual.keyboard.press('f');
  await expect(focus).not.toHaveText(initialFocus);
  for (let index = 0; index < 8; index += 1) {
    await visual.keyboard.press('f');
    await visual.waitForTimeout(55);
  }
  for (let sample = 0; sample < 24; sample += 1) {
    expect(Number(await emitterCount.innerText())).toBeGreaterThanOrEqual(1);
    expect(Number(await emitterCount.innerText())).toBeLessThanOrEqual(2);
    await visual.waitForTimeout(80);
  }

  await visual.keyboard.press('3');
  await expect(panel.locator('[data-scene="3"]')).toHaveClass(/active/);
  await visual.keyboard.press('a');
  await visual.keyboard.press('0');
  await expect(sceneButton).toHaveClass(/active/);
  await expect(form).toHaveText(changedForm);

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

test('la óptica forward se reporta sin reemplazar el HRC', async ({ browser }) => {
  const context = await browser.newContext();
  const visual = await context.newPage();
  const consoleErrors: string[] = [];
  visual.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  await visual.goto('/');
  const rendererDetail = visual.locator('[data-status="webgl-detail"]');
  await expect(rendererDetail).toContainText('DPR 1.5');
  await expect(rendererDetail).toContainText('HRC 1024²');
  await visual.getByRole('button', { name: 'Modo seguro' }).click();
  await expect(rendererDetail).toContainText('DPR 1.0');
  await expect(rendererDetail).toContainText('HRC 512²');
  await visual.locator('[data-impulse="3"]').click();
  for (let index = 0; index < 9; index += 1) {
    await visual.locator('[data-action="test-note"]').click();
    await visual.waitForTimeout(70);
  }

  await expect(rendererDetail).toContainText(/óptica (high|safe|off)/);
  expect(consoleErrors).toEqual([]);
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
