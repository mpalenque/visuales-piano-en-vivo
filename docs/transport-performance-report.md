# Reporte de performance del transporte HRC y óptico

## Estado

Implementación corregida y A/B/A corto aprobado en el Chrome visible de la
máquina objetivo. La campaña sostenida de 45 minutos sigue siendo un gate de
operación previo al show, no un bloqueo de la implementación.

- Commit de referencia: `f295940`.
- Candidato: worktree posterior a ese checkpoint.
- Estado automatizado del candidato: 86 tests unitarios y 7 E2E pasan; el
  benchmark manual adicional queda omitido salvo `TRANSPORT_PERF=1`.
- Telemetría GPU: integrada de forma opt-in con
  `?transportTelemetry=1`; sin esa query no se crea el timer ni se agrega
  trabajo al loop de vivo.
- Decisión del gate corto: **GO** para HRC + transparencia + espejo + vidrio.
- Decisión de estreno: condicionada al soak sostenido documentado abajo.

## Entorno a completar

| Campo | Valor |
|---|---|
| Fecha y hora | 2026-07-25, America/Argentina/Buenos_Aires |
| Máquina | MacBook Pro, Apple M4 Pro, 24 GB |
| GPU y driver | Apple M4 Pro, 16 cores GPU, Metal 3 |
| Sistema operativo | macOS 15.7.7 |
| Chrome | 150.0.7871.184 |
| Resolución del canvas | 1512 × 801, DPR 1 |
| Resolución/refresco del display | 3024 × 1964 Retina, objetivo 120 Hz |
| Estado de energía | No registrado; repetir el soak conectado a corriente |
| Interfaz de audio/sample rate | Pendiente |
| Build/commit verificado | candidato local sobre `f295940` |

## Perfiles configurados

### HRC

| Perfil manual | Resolución | Frustums por frame | Cuerpos máximos |
|---|---:|---:|---:|
| Alta | `512²` | 2 | 48 |
| Segura | `256²` | 1 | 48 |

Memoria calculada a partir del layout actual:

- alta: aproximadamente 67.98 MB;
- segura: aproximadamente 15.99 MB.

La frecuencia real de actualización HRC debe medirse; no se infiere sólo a
partir de esta configuración.

### Campo direccional

| Tier | Resolución | Direcciones | Pasos/tramo | Actualización | Materiales |
|---:|---:|---:|---:|---:|---|
| T0 | `128²` | 4 | 28 | cada ciclo HRC | vidrio + espejo |
| T1 | `128²` | 2 | 28 | cada ciclo HRC | vidrio + espejo |
| T2 | `64²` | 2 | 28 | cada ciclo HRC | vidrio + espejo |
| T3 | `64²` | 2 | 28 | cada 2 ciclos HRC | vidrio + espejo |
| T4 | `64²` | 2 | 28 | cada 2 ciclos HRC | sólo espejo |
| T5 | off | 0 | 0 | off | off |

Otros límites configurados:

- máximo de 32 pasos dentro de un vidrio;
- dos draw calls por actualización óptica: escena MRT y march dirigido;
- sin resolve espacial, blur, bloom, history ni denoise;
- targets half-float calculados en 491,520 bytes (`0.46875 MiB`);
- seis texturas si se asignan simultáneamente los targets `128²` y `64²`;
- asignación lazy: transparencia simple no solicita estos targets.

Alta comienza en T0 y segura en T2. El controlador óptico degrada su propio
tier; no debe modificar resolución, frustums ni cadencia del HRC. Si un acorde
activa el primer material óptico antes de cerrar la ventana nominal de 250 ms,
el controlador congela el p95 parcial de los frames pre-ópticos y conserva
desde ese primer uso el límite relativo de `+5% / +1 ms`.

## Métricas a registrar

### Frame y CPU

- FPS promedio;
- frame time p50, p95, p99 y máximo;
- porcentaje de frames que exceden uno y dos intervalos de display;
- CPU p50/p95/p99 de selección y copia de cuerpos;
- CPU p50/p95/p99 de scheduling HRC y óptico;
- frecuencia efectiva de física;
- long tasks mayores de 50 ms;
- hitch de primera activación y cambio de tier;
- underruns o pérdida de buffers de audio.

### GPU

El timer opt-in mide por separado:

- escena/MRT HRC;
- propagación HRC completa;
- escena/MRT óptica;
- march direccional;
- composición/render final.

Registrar p50, p95 y p99 por pasada. Las consultas deben ser asíncronas mediante
`EXT_disjoint_timer_query_webgl2`; una muestra `disjoint` se descarta. No usar
`readPixels` en el loop de vivo.

### Recursos y cadencia

- Hz HRC y Hz ópticos efectivos;
- draw calls HRC, ópticos y totales;
- cantidad de cuerpos seleccionados;
- resolución, direcciones, pasos y tier;
- texturas y memoria estimada de render targets;
- queries descartadas por disjoint;
- mediciones omitidas por pool lleno;
- transiciones de degradación/recuperación;
- pérdidas y restauraciones de contexto.

## Matriz mínima

Ejecutar el protocolo en:

- modos 3 y 5;
- alta y segura;
- fixture estático determinista;
- escena dinámica típica;
- peor caso de 48 cuerpos;
- HRC solo, transparencia, espejo y vidrio;
- audio sintético repetible y audio real de sala como validación posterior.

Cada variante debe usar el mismo seed, cuerpos, cámara, eventos y duración en sus
tres segmentos.

## Protocolo A/B/A

1. Conectar el equipo a corriente, fijar resolución/refresco, cerrar procesos no
   necesarios y no abrir DevTools durante la captura.
2. Cargar el build de `f295940`, precalentar shaders y dejar estabilizar la
   escena durante 60 segundos.
3. Ejecutar **A0** durante 60 segundos:
   - HRC activo;
   - transporte direccional apagado;
   - misma calidad y fixture que se usarán en B.
4. Sin cambiar seed ni escena, ejecutar **B** durante 60 segundos:
   - transparencia, espejo o vidrio según la fila de la matriz;
   - registrar también la activación inicial por separado.
5. Volver a **A1** durante 60 segundos:
   - óptica apagada;
   - verificar que p95, Hz, draw calls y recursos regresen al baseline.
6. Repetir la secuencia tres veces. Alternar el orden de las variantes B para
   reducir sesgo térmico.
7. Invalidar una corrida si:
   - cambia la visibilidad de la pestaña;
   - el contexto se pierde;
   - una query GPU informa disjoint durante una porción material;
   - cambian energía, resolución o refresco;
   - A0 y A1 difieren más de 3% sin una causa identificada.
8. Guardar JSON/CSV de métricas y capturas con commit, entorno, seed, modo,
   calidad y tier.

La campaña sostenida final debe repetir después una escena representativa
durante 45 minutos, con 100 cambios entre modos/escenas, audio, física, cámara,
tab hide/show y context restore.

## Budgets de aceptación

Comparar B contra el promedio robusto de A0/A1:

| Métrica | Gate |
|---|---|
| FPS promedio | caída máxima de 2% |
| Frame p95 | aumento máximo de `min(1 ms, baseline × 5%)` |
| Frame p99 | aumento máximo de `min(2 ms, baseline × 10%)` |
| Resolución/frustums/Hz HRC | sin degradación atribuible a óptica |
| Física | 120 Hz sostenidos |
| Transparencia simple | 0 targets y 0 draw calls ópticos |
| Transporte direccional | máximo 2 draw calls por actualización |
| Memoria óptica | máximo 0.50 MiB; actual 0.46875 MiB |
| Texturas ópticas | máximo 6, sin crecimiento entre toggles |
| Errores GLSL/WebGL, NaN/Inf | cero |

Si el baseline de la máquina sostiene 120 FPS, conservar ese comportamiento es
el gate; un piso genérico de 50/60 FPS no reemplaza la comparación relativa.

## Resultados

### A/B/A corto en Chrome visible

Cada segmento precalentó 1.2 s, reinició la ventana de timing y midió 2.6 s.
El control usa exactamente la geometría del fixture `mirror-law`, pero cambia
su material a difuso; así mantiene HRC y cantidad de cuerpos sin solicitar
targets ópticos.

| Variante | A1 FPS / p95 | B FPS / p95 | A2 FPS / p95 | HRC en B | Óptica en B | Resultado |
|---|---:|---:|---:|---|---|---|
| Espejo | 120.000 / 9.2 ms | 120.000 / 8.9 ms | 119.992 / 9.2 ms | 512², 2F | T0, 2 calls, 6T, 491,520 B | GO |
| Vidrio | 119.960 / 9.0 ms | 120.000 / 8.5 ms | 120.000 / 9.0 ms | 512², 2F | T0, 2 calls, 6T, 491,520 B | GO |

Contra el promedio A1/A2:

- espejo: no hubo caída medible de FPS; p95 bajó 0.3 ms;
- vidrio: no hubo caída medible de FPS; p95 bajó 0.5 ms;
- HRC permaneció en alta, `512²`, dos frustums por frame;
- desactivar óptica volvió a T5 y cero draw calls ópticos;
- los seis targets permanecen asignados después del primer uso, por diseño,
  pero sin trabajo residual; no crecen en toggles sucesivos.

Como smoke dinámico adicional, modo 5 con 30 notas, dos transparentes, un
espejo y un vidrio se estabilizó en 119.96 FPS / p95 8.7 ms, con HRC y óptica a
60 Hz, HRC `512²/2F` y óptica T0 `128²/4D/2 calls`.

La corrida automatizada headless no representa la máquina del show: el
software rasterizado cayó a 14–39 FPS y el controlador degradó correctamente
HRC a `256²/1F`. Esa corrida fue invalidada por el propio protocolo y no se usa
como resultado. El test manual reproducible queda en
`e2e/transport-performance.spec.ts` y exige explícitamente `TRANSPORT_PERF=1`.

### Calidad del campo

Los fixtures GPU de espejo y vidrio verifican:

- energía finita y positiva;
- `phase4Score < 0.05`;
- máximo spike de autocorrelación en lags 2, 4 y 8 `< 0.05`;
- clipping `0`;
- fuga fuera del receptor analítico `≤ 1e-5`;
- máximo cuatro componentes conexos;
- cambio de energía y desplazamiento normalizado del centroide `> 0.01` al
  variar IOR;
- caída fuerte de energía al usar el ángulo de espejo incorrecto;
- transparencia simple: cero targets y cero draw calls ópticos.

### Pendiente operativo

No se registraron percentiles GPU en el Chrome visible durante esta pasada.
El timer quedó listo para la campaña sostenida. También faltan las filas
modo 5, calidad segura y peor caso de 48 cuerpos durante 45 minutos.

## Criterio de decisión

- **GO:** funcionalidad correcta, todos los budgets cumplidos y A1 vuelve al
  baseline sin leaks ni trabajo óptico residual.
- **GO reducido:** HRC + transparencia + espejo cumplen, pero vidrio/caústicas
  no; se difiere vidrio sin degradar HRC.
- **NO-GO:** T5/off no recupera baseline, el HRC baja calidad para financiar
  óptica, aparecen errores/NaN, o el efecto sólo es legible aumentando
  resolución, pasos o postproceso fuera del presupuesto.
