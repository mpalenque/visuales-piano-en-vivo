# 07 — Escenas y mapeos (máquina de estados + matriz de cableado)

El show son **6 escenas**. Cada escena define: un mundo visual, qué gestos están activos, y cómo se cablea cada gesto a cada parámetro visual. El director cambia de escena en vivo (`06`).

> Las 6 escenas concretas todavía no están definidas (dependen de la música y de tu dirección visual). Este archivo da la **estructura** y una **plantilla por escena** para que la llenes. Abajo hay 2 ejemplos completos para mostrar la idea.

---

## Máquina de estados de escenas

```
        [1] ──▶ [2] ──▶ [3] ──▶ [4] ──▶ [5] ──▶ [6]
         ▲                                        │
         └──────────── (salto libre) ─────────────┘
```

- El director puede ir en orden o **saltar a cualquier escena** (para ensayo, o si la música lo pide).
- Cada transición: corte seco o crossfade de N segundos (config por transición).
- Al entrar a una escena: se cargan sus gestos activos, sus presets de params y su matriz de cableado.
- Estado guardado por escena, así volver a una escena la restaura como estaba.

```ts
interface Scene {
  id: number;
  nombre: string;
  visualScene: number;         // qué VisualScene usa (ver 05)
  gestosActivos: string[];     // ids de gestos que corren en esta escena
  presets: Record<string,object>; // preset de params por gesto
  wires: Wire[];               // el cableado (ver 02, Contrato 3)
  transicionEntrada: { tipo:'corte'|'crossfade', seg:number };
}
```

---

## Plantilla por escena (copiá esto 6 veces y completá)

```
### Escena N — [nombre]
- Momento musical: [qué parte del show / carácter]
- Mundo visual: [descripción corta de la VisualScene]
- Gestos activos: [ej. fader-carga, densidad, color-armonico]
- Cableado:
  | Gesto            | Salida   | → Parámetro visual | Curva   | Rango     |
  |------------------|----------|--------------------|---------|-----------|
  | fader-carga      | value    | tension_particulas | exp     | 0 → 1     |
  | fader-carga      | estalla  | flash + expansión  | —       | —         |
  | densidad         | value    | turbulencia        | sCurve  | 0 → 0.8   |
  | color-armonico   | value    | hue_paleta         | linear  | 180 → 260 |
- Presets de params: [nombre del preset por gesto]
- Notas de dirección: [lo que querés que pase visualmente]
```

---

## Ejemplo 1 — Escena de tensión que estalla

```
### Escena 2 — "Pólvora"
- Momento musical: build de swarm que descarga en un golpe.
- Mundo visual: campo de partículas que se comprime y revienta.
- Gestos activos: fader-carga (preset "pólvora"), densidad, textura-brillo
- Cableado:
  | Gesto         | Salida  | → Parámetro visual     | Curva | Rango      |
  |---------------|---------|------------------------|-------|------------|
  | fader-carga   | value   | compresion_particulas  | exp   | 0 → 1      |
  | fader-carga   | estalla | flash_bloom + explosion| —     | intensity  |
  | densidad      | value   | cantidad_particulas    | linear| 500 → 8000 |
  | textura-brillo| brillo  | color_temperatura      | linear| frío → cálido |
- Notas: la carga se siente como aire que se junta; el estallido es seco y total.
```

## Ejemplo 2 — Escena contemplativa por color

```
### Escena 5 — "Marea armónica"
- Momento musical: pasaje lento, armónicamente rico, rubato.
- Mundo visual: campos de color que respiran, sin ataques bruscos.
- Gestos activos: color-armonico, fader-carga (preset "marea"), textura-brillo
- Cableado:
  | Gesto          | Salida  | → Parámetro visual | Curva  | Rango     |
  |----------------|---------|--------------------|--------|-----------|
  | color-armonico | value   | hue_paleta         | linear | 200 → 320 |
  | color-armonico | (modo)  | saturacion         | —      | may/men   |
  | fader-carga    | value   | brillo_global      | log    | 0.2 → 0.9 |
  | textura-brillo | agitacion| grano_shader      | sCurve | 0 → 0.4   |
- Notas: nada titila (histéresis alta en color-armonico); todo es lento y suave.
```

---

## Reglas de diseño de mapeos

- **Un parámetro visual = un cable** (un solo gesto lo maneja por vez, salvo override). Evita peleas entre gestos.
- **Reusá gestos entre escenas** con presets distintos. Es la gracia de la interfaz común: el fader-carga aparece en varias escenas con personalidad distinta.
- **No todos los gestos en todas las escenas.** 2–4 gestos activos por escena mantiene el resultado legible y el CPU bajo.
- **Los eventos discretos** (estalla/climax) casi siempre valen la pena mapear a algo contundente; son los que "se sienten".

---

## Decisión abierta

¿Las 6 escenas comparten un motor visual (variaciones por params) o son 6 mundos independientes? Impacta el trabajo de la Capa 3. Ver `09`.
