export interface VisualProfile {
  id: number;
  name: string;
  description: string;
}

export const visualProfiles: readonly VisualProfile[] = [
  { id: 1, name: 'Umbral', description: 'Campo escaso y contenido.' },
  { id: 2, name: 'Pólvora', description: 'Compresión y descarga expansiva.' },
  { id: 3, name: 'Constelación', description: 'Red pulsante y estructurada.' },
  { id: 4, name: 'Abismo', description: 'Vórtice profundo y granular.' },
  { id: 5, name: 'Marea armónica', description: 'Ondas lentas de color.' },
  { id: 6, name: 'Coda luminosa', description: 'Campo radial cálido y denso.' },
];

export function visualProfileById(id: number): VisualProfile {
  const profile = visualProfiles.find((candidate) => candidate.id === id);
  if (!profile) throw new Error(`Perfil visual desconocido: ${id}`);
  return profile;
}
