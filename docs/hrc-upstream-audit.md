# Auditoría HRC contra Yaazarai/Volumetric-HRC

## Referencia congelada

- Repositorio: <https://github.com/Yaazarai/Volumetric-HRC>
- Commit auditado: `ed153d18f284acce9515880614b1091e9669adcf`
- Fecha del commit: 2026-07-23
- Licencia upstream: Unlicense
- Variante de referencia:
  `HolographicRadianceCascades/`

No se usan como referencia las carpetas `HRC_RayTraced`,
`HRC-RayTraced (Optimal)` ni `HRC_AxisAligned`: implementan transportes
distintos. La comparación se limita a la variante basada en ray extensions que
el port WebGL2 declara en `src/visual/amitabha-radiance-field.ts`.

Archivos upstream fijados:

- [`Shd_FrustumSeed.fsh`](https://github.com/Yaazarai/Volumetric-HRC/blob/ed153d18f284acce9515880614b1091e9669adcf/HolographicRadianceCascades/shaders/Shd_FrustumSeed/Shd_FrustumSeed.fsh)
- [`Shd_Extensions.fsh`](https://github.com/Yaazarai/Volumetric-HRC/blob/ed153d18f284acce9515880614b1091e9669adcf/HolographicRadianceCascades/shaders/Shd_Extensions/Shd_Extensions.fsh)
- [`Shd_MergingCones.fsh`](https://github.com/Yaazarai/Volumetric-HRC/blob/ed153d18f284acce9515880614b1091e9669adcf/HolographicRadianceCascades/shaders/Shd_MergingCones/Shd_MergingCones.fsh)
- [`Shd_FluenceSum.fsh`](https://github.com/Yaazarai/Volumetric-HRC/blob/ed153d18f284acce9515880614b1091e9669adcf/HolographicRadianceCascades/shaders/Shd_FluenceSum/Shd_FluenceSum.fsh)
- [`Create_0.gml`](https://github.com/Yaazarai/Volumetric-HRC/blob/ed153d18f284acce9515880614b1091e9669adcf/HolographicRadianceCascades/objects/Obj_HolographicRadianceCascades/Create_0.gml)
- [`Draw_73.gml`](https://github.com/Yaazarai/Volumetric-HRC/blob/ed153d18f284acce9515880614b1091e9669adcf/HolographicRadianceCascades/objects/Obj_HolographicRadianceCascades/Draw_73.gml)

Los tests no descargan ni ejecutan código upstream. `hrc-reference.ts` es una
transcripción CPU independiente y autocontenida de las ecuaciones congeladas.

## Alcance

La auditoría cubre exclusivamente el core de transporte:

```text
emissivity + absorption
          ↓
frustum seed c0
          ↓
ray extensions c1..cN
          ↓
cone merge cN..c0
          ↓
4 frustums
          ↓
fluence lineal
```

Quedan fuera de la comparación:

- rasterización analítica de cajas y polígonos;
- selección de los 48 cuerpos;
- feedback difuso mediante `uPreviousIrradiance`;
- materiales transparentes, espejo y vidrio;
- composición visual, exposición, ACES y gamma;
- controlador adaptativo y física.

Para comparar HRC de forma aislada, el futuro harness GPU debe usar
`uBounceGain = 0` y alimentar el oráculo CPU con los attachments de escena que
realmente produjo la GPU.

## Matriz semántica

| Etapa | Upstream congelado | Port WebGL2 | Clasificación | Decisión |
|---|---|---|---|---|
| Dominio | Cuadrado, power-of-two | Cuadrado, power-of-two | Equivalente | Conservar |
| Cantidad de cascadas | `ceil(log2(extent))` | `ceil(log2(fieldExtent))` | Equivalente | Conservar |
| Intervalo cN | `2^N` | `exp2(N)` / `2 ** N` | Equivalente | Conservar |
| Rays por probe | `interval + 1` | `interval + 1` | Equivalente | Conservar |
| Ancho de rays | `floor(N / interval) * (interval + 1)` | Misma fórmula | Equivalente | Conservar |
| Ancho de merge | `floor(N / interval) * interval`, igual a `N` | Dos targets de ancho `N` | Equivalente para power-of-two | Verificar ping-pong por test |
| Seed position | Centro de texel `+0.5` | Centro de texel `+0.5` | Equivalente | Conservar |
| Rotaciones seed | `uv`, `1-yx`, `1-uv`, `yx` | Mismas cuatro transformaciones | Equivalente | Conservar |
| Transferencia de entrada | `pow(rgb, 2.2)` sobre sprites sRGB | Scene MRT ya lineal, sin `pow` | Adaptación de plataforma | No portar el `pow` |
| Transmittance | `exp2(-absorption)` por canal | Misma ecuación | Equivalente | Conservar |
| Seed radiance | `(1 - transmit) * emissivity` | Misma ecuación | Equivalente | Conservar |
| Fuera del campo | Radiance `0`, transmit `1` mediante `floor(samplePos)` | Comparación explícita `<0` / `>=1` | Reformulación robusta | Conservar y testear |
| Segment merge | `nearR + farR * nearT` | Misma ecuación | Equivalente | Conservar |
| Segment transmit | `nearT * farT` | Misma ecuación | Equivalente | Conservar |
| Ray extension | Lower/upper y segundo camino intercambiado | Mismo swap | Equivalente | Conservar |
| Convergencia | `mix(lower, upper, 0.5)` | Mismo mix | Equivalente | Conservar |
| Cone weight | Mitad del span angular | Misma diferencia de `atan` | Equivalente | Conservar |
| Planos impares | Merge directo con el far cone | Misma rama | Equivalente | Conservar |
| Planos pares | Extender 2×, hacer ambos merges y recién después interpolar fluence | Mismo orden | Equivalente | No mover la interpolación |
| Descenso | cN → c0 | cN → c0 | Equivalente | Conservar |
| Storage de merge | Un target por nivel | Dos targets alternados | Optimización equivalente | Demostrar con snapshots |
| Frustum final | Copia de merge c0 | Copia de merge c0 | Equivalente | Conservar |
| Fluence offsets | Un texel hacia afuera por frustum | Mismos offsets | Equivalente | Conservar |
| Fluence rotations | Swizzles específicos por frustum | Mismos swizzles | Equivalente | Conservar |
| Fluence average | Suma de cuatro frustums `/ 4` | Suma `* 0.25` | Equivalente | Conservar |
| Transferencia de salida | `pow(rgb, 1/2.2)` a surface de display | Field lineal; tone mapping posterior | Adaptación de arquitectura | No portar gamma al field |
| Targets de rays | RGBA8 UNORM | RGBA16F | Adaptación HDR | No degradar a RGBA8 |
| Fluence target | RGBA8 UNORM | RGBA16F | Adaptación HDR/feedback | Conservar RGBA16F |
| Filtrado interno | Nearest | Nearest | Equivalente | Bloquear con test/configuración |
| Presentación final | Nearest en demo | Linear al ampliar field | Sólo presentación | No incluir en paridad del core |
| Scheduling | Cuatro frustums en un frame | 2+2 o 1+1+1+1 | Adaptación de performance | Exigir un único snapshot por ciclo |
| Scene inputs | Sprites separados y depth order | MRT analítico de dos attachments | Product-specific | Comparar desde el MRT, no desde bodies |
| Emissivity alpha | Sin contrato de transporte | Metadata de emisor real | Extensión segura | HRC debe leer sólo RGB |
| Bounce difuso | No existe | `uPreviousIrradiance * albedo * gain` | Extensión del producto | Desactivar en paridad upstream |

## Oráculo CPU

`src/visual/hrc-reference.ts` implementa:

- layout exacto de cascadas;
- texturas CPU RGBA;
- sampling nearest con defaults explícitos;
- seed de los cuatro frustums;
- ray extensions;
- cone merge par e impar;
- fluence final;
- cuantización opcional RGBA16F después de cada pasada;
- transferencias sRGB del demo upstream como opciones no predeterminadas.

La configuración predeterminada representa al port:

```ts
{
  quantizeHalf: true,
  inputTransfer: 'linear',
  outputTransfer: 'linear',
}
```

Esto evita dos falsos positivos frecuentes:

1. comparar el scene MRT lineal contra sprites sRGB del demo;
2. comparar el field HDR lineal contra la surface RGBA8 ya gamma-corrected.

## Invariantes que debe preservar DirectionalMaterialField

La reflexión y la refracción no se integran dentro de ray extensions.

`mergeRadiance(near, far)` presupone dos segmentos rectos, colineales y
componibles dentro del mismo frustum. Cambiar dirección entre ambos rompe:

- el índice angular lower/upper;
- la convergencia de extensions;
- el peso del cono;
- la relación espacial entre planos pares e impares.

Por eso:

- HRC conserva exactamente emissivity y absorption como inputs;
- scene, ray, merge, frustum y field targets HRC no reciben escrituras ópticas;
- el MRT óptico lazy permanece separado y puede trabajar a 128²/64²;
- `reflect`/`refract` sólo viven en `DirectionalMaterialField`;
- la textura direccional se suma al field HRC después del transporte;
- la contribución direccional no entra en `uPreviousIrradiance`;
- un camino directo emisor→receptor sigue perteneciendo exclusivamente a HRC;
- ambos transportes capturan el mismo snapshot al abrir un ciclo;
- degradar o apagar óptica no cambia layout, frecuencia ni calidad HRC.

## Qué no portar

- DDA o ray tracing de las otras variantes del repositorio.
- Inicio de extensions en cascade 3; esta variante extiende desde c0.
- La propuesta del README de reducir probes a la mitad: no está implementada.
- RGBA8 sin rediseñar primero todo el rango HDR.
- Gamma de entrada o salida dentro del field lineal.
- Cuatro frustums obligatoriamente en un mismo frame.
- Un target permanente por nivel de merge.
- Sprites, UI, mouse, GameMaker surfaces o su escena de prueba.
- `render_index` para mostrar cascadas parciales.
- Blur, bloom o denoise.
- `reflect` o `refract` dentro de seed, extensions, merge o fluence.

## Gates

### Gate CPU

- Layout de 8², 16² y 32² correcto.
- Campo vacío: radiance y fluence RGB exactamente cero.
- Fuera del campo: radiance cero y transmit uno.
- Sin absorption, un pixel emissive no produce seed radiance.
- Una pared absorbente reduce fluence detrás de ella.
- Rotar escena 90° rota fluence con error máximo ≤ 0.01 fuera del borde de dos
  texels.
- Ningún target contiene NaN o infinito.

### Gate GPU posterior

- Leer scene MRT real y usarlo como input del oráculo.
- Comparar seed, cada extension, cada merge, frustums y field en ese orden.
- No corregir una etapa downstream mientras la anterior diverja.
- Energía normalizada: RMSE ≤ 0.002 y error máximo ≤ 0.01.
- HDR: error relativo ≤ 1% y error máximo absoluto ≤ 0.05.
- `frustaPerStep = 1`, `2` y `4` producen el mismo field para escena congelada.
- Si todas las etapas pasan, cerrar la auditoría sin modificar shaders.
