# Fluido viscoelástico

## Procedencia

- Repositorio: https://github.com/kotsoft/particle_based_viscoelastic_fluid
- Autor: Grant Kot
- Revisión auditada: `3238340fbd1e26665ac2a7b3e9ca5b42bb4f368e`
- Licencia: MIT; copia local en
  `src/visual/viscoelastic-fluid/LICENSE.upstream`.
- Algoritmo de referencia: *Particle-based Viscoelastic Fluid Simulation*,
  Simon Clavet, Philippe Beaudoin y Pierre Poulin.

El repositorio de referencia contiene etapas progresivas `sim_0`–`sim_5`.
No son seis efectos distintos: cada archivo agrega una parte del mismo
simulador. La integración usa `sim_5`, que reúne el paso de simulación,
hashing espacial, relajación de doble densidad, viscosidad y resortes
viscoelásticos.

## Organización local

- `simulation.ts`: núcleo físico puro, independiente de DOM y Three.js.
- `field.ts`: puente de render a `THREE.Points`, color y reacción musical.
- `simulation.test.ts`: estabilidad numérica, resortes e impulsos.
- `LICENSE.upstream`: atribución y licencia del código adaptado.

La adaptación reemplaza los scripts globales y el canvas 2D del demo original.
Así comparte el canvas WebGL, el ciclo de vida, el modo seguro, el blackout y
el panel de dirección del proyecto.

## Uso

Seleccionar `8 · Materia viscoelástica` o presionar `8`.

- Funciona de forma autónoma sin micrófono.
- `density` controla densidad de reposo y presión.
- `tension` controla resortes plásticos.
- `turbulence` modifica viscosidad, gravedad orbital y atracción.
- `hue` y `brightness` controlan la presentación.
- `Probar`, ataques de nota, `estalla`, `pulso` y `clímax` aplican impulsos al
  fluido.

Calidad alta usa 1.200 partículas. Modo seguro usa 650 y conserva la misma
dinámica.
