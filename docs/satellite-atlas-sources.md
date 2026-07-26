# Fuentes del atlas satelital

El atlas `src/assets/forest-satellite-atlas-8x8.jpg` contiene 64 recortes de
512×512 construidos desde imágenes de NASA Earth Observatory y datos
Landsat de NASA/USGS. El procesamiento local solo aplica recorte, reducción,
contraste, saturación y enfoque moderados para uso como textura escénica.

Crédito general: NASA Earth Observatory; datos Landsat de U.S. Geological
Survey cuando corresponde.

## Escenas

- [Olympic National Park](https://science.nasa.gov/earth/earth-observatory/olympic-national-park-87507/)
  — Landsat 8, octubre de 2015; fuente de 9000×9000.
- [Yellowstone National Park](https://science.nasa.gov/earth/earth-observatory/yellowstone-national-park-87881/)
  — Landsat 8, junio de 2013; fuente de 3240×2160.
- [Smoky Mountain Seasons](https://science.nasa.gov/earth/earth-observatory/smoky-mountain-seasons-82828/)
  — MODIS, octubre de 2012 y junio de 2013; fuentes de 3840×2880.
- [Kalimantan, Borneo, Indonesia](https://earthobservatory.nasa.gov/images/78461/kalimantan-borneo-indonesia)
  — Landsat 7, bosque tropical y cuencas; fuente de 4200×4200.
- [Landsat 8 Detects New Deforestation in Peru](https://science.nasa.gov/earth/earth-observatory/landsat-8-detects-new-deforestation-in-peru-82076/)
  — Amazonia peruana y río Amazonas; fuente de 4572×4572.
- [Patterns of Forest Change in Bolivia](https://earthobservatory.nasa.gov/images/150257/patterns-of-forest-change-in-bolivia)
  — Landsat 8, bosque Chiquitano y patrones radiales; fuente de 3964×3636.
- [Bombetoka Bay, Madagascar](https://earthobservatory.nasa.gov/images/5245/bombetoka-bay-madagascar)
  — ASTER/Terra, manglares y estuario; fuente de 1924×2028.

## Uso

NASA indica que los productos multimedia derivados de Landsat son de dominio
público y pide atribuirlos a `USGS/NASA Landsat`. Las demás imágenes de NASA
se usan bajo sus pautas de medios, con NASA reconocida como fuente y sin
implicar aval institucional:

- [Landsat multimedia y uso](https://science.nasa.gov/mission/landsat/multimedia/)
- [NASA Images and Media Usage Guidelines](https://www.nasa.gov/nasa-brand-center/images-and-media/)

El script reproducible está en `scripts/build-satellite-atlas.swift`. Recibe
un directorio con las fuentes usando los nombres declarados en el script y la
ruta de salida del atlas.
