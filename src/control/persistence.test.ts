import { describe, expect, it } from 'vitest';
import { createDefaultScenes, sceneById } from './scenes';
import { LEGACY_SCENES_STORAGE_KEY, SHOW_CONFIG_STORAGE_KEY, createDefaultShowConfig, loadShowConfig, saveShowConfig } from './show-config';

function memoryStorage(initial: Record<string, string> = {}): Storage {
  const values = new Map(Object.entries(initial));
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, value); },
  } as Storage;
}

describe('persistencia y escenas', () => {
  it('guarda, carga y aísla una configuración válida', () => {
    const storage = memoryStorage();
    const config = createDefaultShowConfig();
    config.scenes[0].nombre = 'Ensayo';
    saveShowConfig(storage, config);
    expect(JSON.parse(storage.getItem(SHOW_CONFIG_STORAGE_KEY)!)).toEqual(config);
    const loaded = loadShowConfig(storage);
    expect(loaded).toEqual({ config, migrated: false, warning: null });
  });

  it('falla de forma segura ante storage corrupto y migra presets heredados', () => {
    const corrupt = loadShowConfig(memoryStorage({ [SHOW_CONFIG_STORAGE_KEY]: '{no-json' }));
    expect(corrupt.config.scenes).toHaveLength(6);
    expect(corrupt.warning).toContain('Se ignoró un preset local inválido');

    const legacy = memoryStorage({ [LEGACY_SCENES_STORAGE_KEY]: JSON.stringify(createDefaultScenes()) });
    const migrated = loadShowConfig(legacy);
    expect(migrated.migrated).toBe(true);
    expect(legacy.getItem(SHOW_CONFIG_STORAGE_KEY)).not.toBeNull();
  });

  it('crea copias independientes y reporta ids inexistentes', () => {
    const first = createDefaultScenes();
    const second = createDefaultScenes();
    first[0].nombre = 'Mutación local';
    expect(second[0].nombre).not.toBe('Mutación local');
    expect(sceneById(second, 6).visualScene).toBe(6);
    expect(() => sceneById(second, 7)).toThrow('No existe la escena 7');
  });
});
