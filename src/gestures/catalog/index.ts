import { createAcumuladorClimax } from './acumulador-climax';
import { createColorArmonico } from './color-armonico';
import { createContadorPulsos } from './contador-pulsos';
import { createDensidad } from './densidad';
import { createFaderCarga } from './fader-carga';
import { createTexturaBrillo } from './textura-brillo';
import type { AnyGesture } from '../gesture';

export function createCatalog(): Map<string, AnyGesture> {
  const gestures = [
    createFaderCarga(),
    createContadorPulsos(),
    createAcumuladorClimax(),
    createDensidad(),
    createColorArmonico(),
    createTexturaBrillo(),
  ] as AnyGesture[];
  return new Map(gestures.map((gesture) => [gesture.id, gesture]));
}
