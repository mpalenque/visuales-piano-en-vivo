# Plan maestro: corregir HRC y cerrar espejo, vidrio y caústicas sin postproceso

## Decisión ejecutiva

El trabajo es viable, pero no debe empezar reemplazando el HRC actual.

La auditoría estática contra `Yaazarai/Volumetric-HRC`, commit
`ed153d18f284acce9515880614b1091e9669adcf`, muestra que el núcleo actual ya
coincide semánticamente con la variante correcta:

- `HolographicRadianceCascades/Shd_FrustumSeed`;
- `HolographicRadianceCascades/Shd_Extensions`;
- `HolographicRadianceCascades/Shd_MergingCones`;
- `HolographicRadianceCascades/Shd_FluenceSum`.

Seed, ray extensions, merge de planos pares/impares y suma de cuatro frustums ya
siguen la misma estructura. Por eso:

1. Yaazarai se usará como **oráculo de paridad**, no como reemplazo ciego.
2. Se corregirá solamente una divergencia demostrada con fixtures y readback.
3. `reflect` y `refract` seguirán fuera del HRC, en un transporte direccional
   separado y limitado.
4. Se eliminará el muestreo óptico periódico actual y se intentará retirar su
   resolve de cinco taps.
5. La óptica se degradará o apagará antes de tocar resolución, cadencia o calidad
   del HRC.

Este documento reemplaza como plan operativo a
`11-plan-port-volumetric-hrc-terra.md` y
`12-plan-materiales-direccionales-reflexion-refraccion-causticas.md`. Esos
documentos quedan como historial técnico.

## Resultado buscado

- HRC difuso estable, sin cuadrados de probes visibles.
- Transparencia simple sin costo direccional.
- Espejo que obedece la ley de reflexión.
- Vidrio con entrada, salida, Snell, Fresnel y absorción.
- Caústica 2D producida por refracción real sobre receptores difusos.
- Ninguna energía óptica dibujada en aire o fondo vacío.
- Sin bloom, blur, glow, history, denoise ni filtro full-screen nuevo.
- Performance equivalente al baseline actual.

## Fuera de alcance

- Path tracing general.
- Reflexiones fotográficas 3D.
- Más de un cuerpo óptico por camino.
- Bifurcar reflexión y refracción en dos caminos por muestra.
- Photon mapping, dispersión RGB o múltiples rebotes.
- Cambiar audio, detección de notas, física o lógica musical.
- Aumentar el límite de 48 cuerpos sin un perfil independiente.

## Definición de “sin postproceso”

No se permite:

- bloom;
- Gaussian blur;
- denoise espacial o temporal;
- history para esconder ruido;
- un pase full-screen que invente o expanda luz;
- subir contraste o exposición para ocultar una geometría incorrecta.

Sí se permite:

- el merge de conos y fluencia propio del HRC;
- filtrado lineal al presentar una textura low-res;
- tone mapping ya existente;
- reconstrucción matemática interna al estimador, solamente si tiene una
  justificación medible.

El objetivo de este plan es retirar el resolve óptico de cinco taps actual. Si el
nuevo estimador no funciona sin ese filtro, se detiene y se replantea; no se lo
esconde con más pases.

## Arquitectura objetivo

```text
PackingBlock[] / snapshot estable de hasta 48 cuerpos
                    |
                    +--> HRC scene MRT 512²/256²
                    |       |
                    |       +--> ray extensions desde c0
                    |       +--> merge de conos
                    |       +--> 4 frustums escalonados
                    |       +--> diffuseField lineal
                    |
                    +--> optical scene MRT lazy 128²/64²
                            |
                            +--> IDs/SDF/materiales
                            +--> muestreo dirigido, 4/2 caminos globales
                            +--> reflect o refract
                            +--> directionalField lineal

fondo/aire ---------------------------> sólo diffuseField
receptores difusos -------------------> diffuseField + directionalField
espejo/vidrio visible ----------------> shader del mesh, sin pase adicional
emisores -----------------------------> sin doble iluminación direccional
```

Pipeline óptico objetivo:

- 1 draw call para SDF/materiales;
- 1 draw call para transporte;
- 6 texturas contando targets high y safe;
- no más de `0.50 MB`;
- sin target raw + target resolved.

El HRC debe conservar exactamente sus draw calls, resolución y cadencia.

---

# Fase 0 — Proteger el estado y congelar el baseline

## Tareas

1. Registrar `git status --short`. El workspace aparece mayormente untracked, por
   lo que no existe rollback confiable hasta crear un checkpoint recuperable.
2. Revisar que no haya secretos y crear un snapshot/commit local de baseline
   antes de editar producción.
3. Fijar la referencia upstream:
   - repositorio;
   - commit exacto;
   - licencia Unlicense;
   - shaders y eventos GameMaker comparados.
4. Registrar versiones de:
   - Three.js;
   - Chrome/ANGLE;
   - GPU;
   - resolución/DPR/refresco;
   - extensiones WebGL disponibles.
5. Ejecutar:

   ```bash
   npm run check
   npm run test:e2e
   ```

6. Medir con óptica apagada:
   - modo 3 y modo 5;
   - high y safe;
   - escena vacía, típica y densa;
   - física quieta y dinámica.
7. Usar secuencia A/B/A para cada comparación:
   - HRC limpio;
   - feature;
   - HRC limpio nuevamente.

## Protocolo de medición

- calentamiento de 60 segundos;
- tres corridas de 60 segundos;
- mismo seed y escena;
- misma máquina, alimentación y ventana;
- no decidir si dos corridas A difieren más de 3%.

## Gate 0

- Build, lint, unit y E2E pasan.
- Cero errores GLSL/WebGL.
- Baseline reproducible.
- Existe rollback real.
- No se modificó ningún shader todavía.

---

# Fase 1 — Observabilidad y fixtures deterministas

No se ajusta ganancia, color ni filtros hasta poder separar HRC, óptica y
composición.

## Harness de desarrollo/test

Agregar, sólo detrás de una query de test:

```ts
setTransportFixture({
  scene,
  materialOverride,
  mirrorAngle,
  ior,
  receiver,
  occluder,
  emitterOffset,
  quality,
});

stepUntilHrcCycles(count);
stepUntilOpticalCycles(count);
readHrcField();
readOpticalField();
readReceiverMask();
```

Condiciones fijas:

- cámara sin roll;
- DPR `1`;
- física, morph, pulse y giro pausados;
- emisor blanco con fuerza `1`;
- exposición fija;
- tier fijo durante el test;
- `readPixels` sólo en desarrollo/E2E, nunca durante el show.

## Fixtures HRC

1. Campo vacío.
2. Emisor de un texel.
3. Emisor de 16 texels.
4. Emisor + pared vertical.
5. Emisores separados R/G/B.
6. Fuente en cada borde.
7. Rebote difuso con `bounceGain = 0` y `0.24`.
8. Escena densa que reproduzca la captura con cuadrados.

## Fixtures ópticos

### `mirror-law`

- emisor blanco pequeño en `(0, -3)`;
- espejo fino centrado, ángulo inicial `45°`;
- receptor vertical en `x = 3`;
- variantes `40°`, `45°`, `50°`;
- controles mirror→diffuse, emisor off y blocker on.

### `glass-prism`

- emisor en `(-3, 0)`;
- prisma triangular;
- receptor vertical en `x = 3`;
- IOR `1.0`, `1.33` y `1.5`;
- control glass→transparent.

### `glass-lens`

- polígono convexo/octágono;
- emisor y receptor fijos;
- se usa para demostrar focalización.

Un espejo plano puede producir un haz reflejado, pero no debe llamarse
“caústica”. Esa etiqueta se reserva para la concentración refractada del fixture
convexo.

## Métricas de readback

- suma, máximo, p95 y p99 de energía;
- píxeles no cero;
- bounding box;
- centroide;
- covarianza y eje principal;
- componentes conectados;
- energía dentro/fuera del receiver;
- cantidad de píxeles clipeados;
- score de fase periódica;
- autocorrelación en lags 2, 4 y 8.

Objetivos iniciales:

```text
outsideLeak <= 1%
phase4Score < 0.05
gridLagSpike < 0.05
sin emisor => energía <= 1e-5
```

## Gate 1

- Cada fixture es reproducible.
- HRC, óptica y composite se pueden inspeccionar por separado.
- Los hooks de test no agregan recursos ni ramas al loop productivo.

---

# Fase 2 — Identificar el origen de los cuadrados

## Árbol de diagnóstico

1. Poner óptica en T5 o convertir todos los materiales en diffuse.
   - Si el patrón continúa en la textura HRC: origen HRC/scene input.
2. HRC limpio y patrón presente en optical field:
   - origen del sampler direccional.
3. Ambos fields limpios y patrón sólo en composite:
   - UV, roll, filtrado, exposición o doble suma.
4. Cambiar únicamente HRC `512 → 256`.
   - Si el tamaño del patrón se duplica: artefacto HRC.
5. Cambiar únicamente óptica `128 → 64`.
   - Si el tamaño se duplica: artefacto óptico.
6. Apagar únicamente el feedback difuso.
   - Si desaparece: el problema está en `sceneFragmentShader`/realimentación, no
     en ray extensions.
7. Comparar 1, 2 y 4 frustums por step con escena congelada.
   - Deben terminar en el mismo field.

## Gate 2

- Existe evidencia de qué target introduce el primer patrón.
- No se continúa con tuning visual hasta identificar ese primer stage.
- No se atribuye automáticamente el defecto a Yaazarai ni a la caústica.

---

# Fase 3 — Paridad HRC contra Yaazarai

Fuente de verdad:

`HolographicRadianceCascades/` del commit fijado. Las variantes
`HRC_RayTraced`, `HRC-RayTraced (Optimal)` y `HRC_AxisAligned` se usan, como
máximo, como referencia visual; no son la base del port.

## 3.1 Matriz semántica

| Producción | Upstream | Verificar |
|---|---|---|
| `frustumSeedFragmentShader` | `Shd_FrustumSeed` | intervalo, 2 rays, half texel, rotaciones |
| `extensionFragmentShader` | `Shd_Extensions` | lower/upper, swap, defaults, near/far |
| `mergeConesFragmentShader` | `Shd_MergingCones` | cone weight, par/impar, merge→interpolate |
| `fluenceFragmentShader` | `Shd_FluenceSum` | offsets de 1 texel, swizzles, promedio |
| `allocateTargets()` | `Create_0.gml` | cascade count y anchos |
| `renderFrustum()` | `Draw_73.gml` | extensions ascendentes, merge descendente |

Clasificar cada diferencia como:

- equivalente;
- adaptación de plataforma;
- defecto candidato;
- extensión propia.

## 3.2 Oráculo CPU independiente

Crear:

- `src/visual/hrc-reference.ts`;
- `src/visual/hrc-reference.test.ts`.

Debe transliterar upstream sin importar helpers de producción:

- layout de cascadas;
- seed de cuatro frustums;
- nearest sampling;
- radiance fuera `0`;
- transmittance fuera `1`;
- extensions;
- cone merge;
- fluence;
- cuantización half-float por stage.

Fixture base `32²`:

```text
c0 64×32
c1 48×32
c2 40×32
c3 36×32
c4 34×32
merge 32×32
```

## 3.3 Harness GPU por etapas

Crear:

- `src/visual/hrc-audit-harness.ts`;
- `e2e/hrc-parity.spec.ts`.

Leer, sólo durante tests:

- scene emissivity/absorption;
- radiance/transmit por cascada;
- merge final;
- cuatro frustums;
- field final.

Alimentar el oráculo CPU con el scene MRT leído de GPU. Así se separa el core HRC
de la rasterización analítica de cajas/polígonos.

Tolerancias iniciales:

```text
RMSE normalizado <= 0.002
error máximo <= 0.01
HDR: error relativo <= 1%
sin NaN/Inf
soporte espacial idéntico salvo 1 texel de borde
```

## 3.4 Orden de corrección

Corregir exclusivamente el primer stage divergente:

1. layout;
2. seed;
3. extension por nivel;
4. merge superior;
5. descenso completo;
6. frustum copy;
7. fluence.

Un cambio lógico por commit y repetir la batería completa.

## Adaptaciones que se conservan

- Scene MRT lineal/HDR: no copiar `pow(rgb, 2.2)` del demo sRGB.
- RGBA16F: no pasar a RGBA8 mientras emisión pueda superar `1`.
- Dos merge targets ping-pong: equivalentes y más baratos que uno por nivel.
- Frustums `2+2` o `1+1+1+1`: conservar si el snapshot es idéntico.
- Field lineal hasta el tone mapping existente.
- Nearest en targets internos; linear sólo en presentación/upscale.

Si todos los stages pasan, no se modifica el core HRC. En ese caso se revisan:

- cobertura binaria/subpixel de los emisores analíticos;
- feedback difuso;
- orden de cuerpos;
- display/upscale.

Una corrección de cobertura analítica de un emisor es válida; desenfocar el field
final no lo es.

## Gate 3 — HRC limpio

- El core coincide con el oráculo.
- Fuente puntual, pared y movimiento no producen grid visible.
- El field congelado coincide con 1, 2 y 4 frustums por step.
- No hay seams extra entre frustums.
- Feedback `0.24` permanece finito.
- HRC conserva baseline de rendimiento.

No se empieza el rediseño óptico hasta cerrar este gate.

---

# Fase 4 — Semántica de receptores y composición

Antes de cambiar el sampler:

1. La textura direccional sólo puede tener energía sobre un receptor:
   - diffuse;
   - no emissive;
   - realmente cubierto por la geometría.
2. Aire, fondo, mirror, glass y emitter deben escribir cero.
3. El fondo muestra únicamente HRC.
4. Los meshes difusos combinan HRC + directional una sola vez.
5. Mirror/glass no reciben directional como luz difusa.
6. El receiver mask debe ser conservador hasta un texel para cuerpos finos.
7. El rayo inicial debe ignorar el ID del receptor sólo hasta escapar de él.
8. Normal, proyección y bias deben corresponder al body ID golpeado, no al
   gradiente de la unión SDF.
9. Display y meshes deben usar la misma transformación world→field y roll.

Tests:

- fixture sin receiver produce cero;
- energía fuera de `dilate(receiverMask, 1)` ≤1%;
- receptor fino no se auto-colisiona;
- ningún alpha casi opaco duplica la contribución;
- mover cámara/roll no desacopla HRC y óptica.

## Gate 4

- No existe luz direccional en aire.
- No hay doble aplicación.
- El receiver fino funciona.
- El screenshot ya no puede mostrar fans o cuadrados ópticos sobre todo el fondo.

---

# Fase 5 — Sustituir el sampler periódico

El sampler actual rota rayos con `(x + 2y) % 4` y después usa un resolve de cinco
taps. Esa fase puede convertir la falta de muestras en una grilla.

## Diseño recomendado: muestreo dirigido

1. La CPU empaqueta IDs del snapshot ya seleccionado:
   - hasta 2 mirrors;
   - hasta 1 glass;
   - emisores relevantes.
2. Usar presupuesto global:
   - high: 4 caminos por receptor;
   - safe: 2 caminos por receptor.
3. Selección estable con histéresis; no reordenar por pulsos instantáneos.
4. Confirmar mediante marcha que el primer material golpeado es el ID objetivo.
5. Mantener oclusión completa: nunca atravesar otro cuerpo para llegar al target.

### Espejo plano

Preferir image method:

1. reflejar el centro del emisor respecto del plano del espejo;
2. trazar receiver→emisor virtual;
3. intersectar el segmento real del espejo;
4. validar cara, body ID y obstáculos;
5. continuar hasta el emisor real.

Esto produce una dirección continua, obedece la ley `2θ` y evita depender de una
fase por texel.

### Vidrio

- Samplear 2/4 puntos low-discrepancy de la cara/silueta de entrada.
- Primera distribución: `[-0.75, -0.25, 0.25, 0.75]` sobre la tangente.
- Desplazar de forma continua según la coordenada proyectada del receptor.
- Usar finite emitter footprint si los puntos fijos generan bandas.
- Nunca convertir esa banda en blur posterior.

## Normalización

El muestreo dirigido es sesgado si se suma sin pesos. Se debe:

- normalizar por PDF/cobertura angular;
- estabilizar brillo entre 2 y 4 caminos;
- conservar energía al cambiar cantidad/tamaño de ópticos;
- limitar combinaciones mirror×emitter a 4/2 globales.

## Retiro del resolve

Cuando el sampler dirigido pase los tests:

- borrar phase index;
- borrar raw target;
- borrar shader/material de resolve;
- escribir directamente un único directional output;
- bajar de 3 a 2 draw calls;
- bajar de 8 a 6 texturas;
- actualizar memoria y telemetría.

Fallback experimental, no ruta principal:

- hash/blue-noise anclado a world space dentro del mismo pass.

No se acepta volver a una grilla temporal ni agregar history.

## Gate 5

- `phase4Score < 0.05`.
- Sin spikes de autocorrelación 2/4/8.
- Estabilidad estática:
  - variación de energía <0.1%;
  - deriva de centroide <0.002;
  - sin crawling.
- High/safe:
  - centroide <0.03 de diferencia;
  - eje principal <8°;
  - support IoU >0.45;
  - energía dentro de 30%.
- Pipeline óptico: 2 draw calls, 6 texturas, ≤0.50 MB.

---

# Fase 6 — Cerrar espejo

## Transporte

- Un cambio de dirección.
- Normal analítica del body ID exacto.
- Hit proyectado a la superficie.
- Bias limitado por texel y espesor.
- Transparencias simples pueden atravesarse hasta el límite existente.
- Sólo se acumula si después del espejo se llega a un emisor real.
- Camino directo a emisor queda exclusivamente en HRC.
- Obstáculos opacos terminan el camino.

## Gates geométricos

- Ángulos `40°`, `45°`, `50°`.
- Rotar espejo `+5°` mueve el haz aproximadamente `+10°`, tolerancia `±4°`.
- Blocker reduce energía al 10% o menos.
- Mirror→diffuse deja energía direccional en cero.
- Sin emisor produce cero.
- No hay crecimiento frame a frame.

## Gate de performance

Debe funcionar en:

- high `128²`, 4 caminos, 28 pasos;
- safe `64²`, 2 caminos, 28 pasos.

Si necesita más resolución, más caminos, blur o history para ser legible, se
detiene antes de vidrio.

---

# Fase 7 — Cerrar vidrio y caústica

## Vidrio

1. Detectar entrada aire→vidrio.
2. Aplicar `eta = 1 / ior`.
3. Marchar dentro del mismo body ID.
4. Detectar salida.
5. Aplicar `eta = ior`.
6. Resolver como máximo una reflexión interna total.
7. Aplicar Fresnel-Schlick.
8. Aplicar Beer–Lambert según distancia y tint.
9. No bifurcar ramas.
10. Limitar a un cuerpo glass por camino.

Rango:

```text
IOR 1.0–1.8
default 1.5
sin aberración cromática
```

## Caústica

No se agrega un pass de “caústica”. Es la concentración del mismo camino
refractado cuando llega a un receptor.

Para llamarla caústica real debe:

- desaparecer al volver glass→diffuse/transparent;
- aproximarse a transmisión recta con IOR `1`;
- desviarse monótonamente con IOR `1 → 1.33 → 1.5`;
- cambiar con forma y rotación;
- morir con blocker o emisor off;
- mantenerse sobre el receiver;
- conservar forma gruesa entre `64²` y `128²`;
- no alinearse con ejes, periodo 4 o potencias de dos.

Gate de focalización para `glass-lens`:

- menor segundo momento espacial o mayor relación peak/area que una placa;
- energía finita;
- ningún NaN/Inf/TIR inestable.

Si requiere dos ramas, varios vidrios o más pasos, el fallback de producto es
transparencia + espejo. No se degrada HRC para financiarlo.

---

# Fase 8 — Apariencia de materiales sin passes nuevos

La apariencia visible no debe depender de que exista una caústica.

## Mirror

- base chrome oscura;
- contraste usando HRC a ambos lados de la normal;
- borde o banda direccional en coordenadas locales;
- sin sumar directional sobre sí mismo.

## Glass

- HRC transmitido;
- offset barato por normal proporcional a `(ior - 1) × thickness`;
- Beer/tint;
- rim fino;
- opacity inicial `0.20–0.35`.

## Transparent

- transmisión casi recta;
- menor absorción HRC;
- cero targets y cero draw calls direccionales.

Gates:

- los cuatro materiales son distinguibles sin ver la caústica;
- mirror vs diffuse tiene diferencia media visible;
- glass conserva correlación con el fondo pero muestra offset/rim;
- ningún material requiere bloom.

---

# Fase 9 — Energía, color y performance

No ajustar color hasta pasar geometría.

## Energía

- Recalibrar con emisor blanco strength `1`.
- Reemplazar el factor viejo dependiente de direcciones por promedio/PDF.
- Ganancia inicial orientativa:
  - mirror `0.15`;
  - glass `0.12`.
- Preferir soft knee lineal antes del ACES a hard clamps planos.
- Recién después probar emisores rojo, azul y ámbar reales.

Gates visuales:

```text
fuera del receiver: delta lineal < 0.005
dentro del receiver: mediana delta luma >= 0.08
pixels finales >= 0.995: menos de 0.5%
```

## Instrumentación

Agregar queries GPU asíncronas cuando exista
`EXT_disjoint_timer_query_webgl2`:

- scene MRT HRC;
- propagación HRC;
- scene MRT óptico;
- transporte direccional;
- composición final.

Nunca esperar una query ni usar `readPixels` en vivo.

CPU:

- rAF p50/p95/p99;
- selección/copia de cuerpos;
- carga de uniforms;
- física efectiva;
- long tasks;
- hitches al crear primer mirror/glass;
- audio underruns.

## Budgets obligatorios

| Métrica | Gate |
|---|---|
| FPS promedio | caída ≤2% |
| Frame p95 | aumento ≤`min(1 ms, baseline × 5%)` |
| Frame p99 | aumento ≤`min(2 ms, baseline × 10%)` |
| CPU main p95 | aumento objetivo ≤0.25 ms |
| HRC resolución/frustums/Hz | sin degradación por óptica |
| Física | 120 Hz sostenidos |
| Draw calls HRC | exactamente baseline |
| Draw calls ópticos | 0 transparent; máximo 2 direccional |
| Memoria óptica | objetivo ≤0.50 MB; hard cap 1 MB |
| Texturas ópticas | máximo 6 objetivo |
| NaN/Inf/errores | cero |

“50 FPS” no es aceptación si el baseline está alrededor de 120 FPS.

## Ladder óptica

| Tier | Campo | Caminos | Cadencia | Materiales |
|---:|---:|---:|---:|---|
| T0 | `128²` | 4 | cada ciclo HRC | glass + mirror |
| T1 | `128²` | 2 | cada ciclo | glass + mirror |
| T2 | `64²` | 2 | cada ciclo | glass + mirror |
| T3 | `64²` | 2 | cada 2 ciclos | glass + mirror |
| T4 | `64²` | 2 | cada 2 ciclos | sólo mirror |
| T5 | off | 0 | off | HRC puro |

- high empieza T0;
- safe empieza T2;
- degradar después de 1.5 s fuera de budget;
- recuperar un escalón después de 5 s estables;
- nunca bajar HRC desde este controlador;
- T5 debe regresar al baseline en dos ventanas.

---

# Fase 10 — Tests, stress y release

## Unit tests

- layout HRC y oráculo CPU;
- defaults fuera del campo;
- rotaciones/frustum offsets;
- selección estable de cuerpos e IDs post-selección;
- SDF, signo y normales;
- receiver fino y auto-hit;
- reflexión y ley `2θ`;
- Snell, Fresnel, Beer–Lambert y TIR;
- 0/1/3/4 transparencias;
- normalización 2/4 caminos;
- histéresis de selección;
- quality ladder sin acceso a HRC;
- memoria, reset y dispose.

## E2E WebGL

El test actual de “energía > 0” no alcanza. Agregar:

- paridad HRC CPU/GPU por stages;
- mirror 40/45/50 con centroide/eje esperado;
- blocker reduce ≥90%;
- IOR `1`, `1.33`, `1.5` con desvío monótono;
- lens focaliza respecto de placa;
- sin emisor produce cero;
- receiver=false produce cero;
- phase/grid scores;
- high vs safe;
- 30 frames estáticos sin deriva;
- transparencia no crea targets;
- T0→T5→T0 sin cambiar HRC;
- context loss/restore;
- 100 cambios entre modos 3 y 5;
- dispose vuelve al conteo baseline.

## Prueba de show

- 45 minutos;
- audio real;
- física y gravedad;
- cámara y roll;
- escenas densas;
- cambios high/safe;
- tab hide/show;
- context restore;
- primer mirror/glass sin hitch;
- cero crecimiento de memoria;
- cero degradación progresiva.

## Release gate

Sólo declarar terminado cuando:

- no hay cuadrados visibles ni métricos;
- HRC pasa paridad;
- mirror pasa ley y oclusión;
- glass pasa IOR/TIR;
- caústica pasa focalización y causalidad;
- pipeline final no usa postproceso cosmético;
- performance cumple A/B/A en la máquina del show;
- lint, unit, build y E2E pasan;
- las capturas fueron aprobadas visualmente.

---

# Mapa de archivos previsto

| Archivo | Responsabilidad del plan |
|---|---|
| `src/visual/amitabha-radiance-field.ts` | Harness HRC, paridad, correcciones demostradas y contrato con óptica |
| `src/visual/hrc-reference.ts` | Oráculo CPU independiente |
| `src/visual/hrc-reference.test.ts` | Layout, extensions, merge y fluence |
| `src/visual/hrc-audit-harness.ts` | Readback por stage sólo para test |
| `src/visual/directional-material-field.ts` | Receiver mask, sampler dirigido, reflect/refract y retiro del resolve |
| `src/visual/optical-materials.ts` | Contratos, límites e IDs estables |
| `src/visual/optical-quality-controller.ts` | Ladder óptica sin control sobre HRC |
| `src/visual/renderer.ts` | Fixtures, composición y apariencia visible |
| `e2e/hrc-parity.spec.ts` | Paridad CPU/GPU |
| `e2e/optical-geometry.spec.ts` | Ley del espejo, IOR, oclusión, grid y high/safe |
| `docs/hrc-upstream-audit.md` | SHA, matriz semántica, evidencia y decisiones |
| `docs/transport-performance-report.md` | Baseline A/B/A y release gate |

# Entregables por hito

| Hito | Entregable demostrable |
|---|---|
| M0 | Baseline, rollback y upstream fijado |
| M1 | Fixtures y métricas que localizan el grid |
| M2 | Informe de paridad HRC; patch sólo si hubo divergencia |
| M3 | HRC limpio sin óptica |
| M4 | Transporte óptico sin fase ni resolve |
| M5 | Mirror geométricamente correcto y dentro de budget |
| M6 | Glass/caústica causal y estable |
| M7 | Materiales visibles, high/safe y stress de show |

Cada hito debe guardar:

- commit o patch identificable;
- capturas antes/después;
- métricas funcionales;
- diferencia de p95/GPU;
- decisión GO/NO-GO;
- rollback probado.

---

# Puntos de corte obligatorios

## Corte A — Después de HRC

Mostrar:

- target donde aparecía el grid;
- causa comprobada;
- antes/después;
- impacto de GPU.

Si el core pasa paridad y el grid persiste, no se reescribe Yaazarai: se corrige
scene input, feedback o composite.

## Corte B — Después de mirror

Si mirror no es legible en `128²/4` y `64²/2` o rompe el budget, detenerse. No
empezar glass ni agregar filtros.

## Corte C — Después de glass

Si pocos caminos dirigidos no alcanzan para una refracción estable, detenerse y
presentar:

- transparencia + mirror funcional;
- evidencia del fallo;
- costo estimado de ampliar muestras o rebotes.

## Corte D — Performance

Si T5 no vuelve al baseline, existe costo residual o leak. No compensarlo bajando
HRC.

## Cambio de arquitectura/modelo

No se espera necesitar un cambio para el audit HRC, composición, sampler dirigido
o mirror. Se debe parar y pedir decisión antes de:

- doblar rays dentro del HRC;
- introducir múltiples cuerpos ópticos por camino;
- agregar photon mapping;
- bifurcar reflection/refraction;
- aceptar postproceso como requisito;
- degradar HRC para financiar óptica.

## Orden de ejecución resumido

1. Baseline y rollback.
2. Fixtures/observabilidad.
3. Identificación objetiva del grid.
4. Paridad HRC por stages.
5. Corrección de receiver/composición.
6. Sampler dirigido sin fase y sin resolve.
7. Mirror.
8. Glass/caústica.
9. Materiales visibles.
10. Energía/color.
11. Perfil high/safe.
12. Stress y release.
