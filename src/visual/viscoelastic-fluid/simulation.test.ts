import { describe, expect, it } from 'vitest';
import { ViscoelasticFluidSimulation } from './simulation';

describe('fluido viscoelástico', () => {
  it('mantiene partículas finitas mientras combina densidad, viscosidad y resortes', () => {
    const simulation = new ViscoelasticFluidSimulation(320, 180, 140, 42);
    simulation.setMaterial({ springStiffness: 0.18, kernelRadius: 24 });
    for (let index = 0; index < 8; index += 1) {
      simulation.step({
        gravityX: 0.2,
        gravityY: 0.35,
        attractorX: 160,
        attractorY: 90,
        attraction: 0.1,
      });
    }
    expect(simulation.particleCount).toBe(140);
    expect(simulation.springCount).toBeGreaterThan(0);
    for (const particle of simulation.particles) {
      expect(Number.isFinite(particle.x)).toBe(true);
      expect(Number.isFinite(particle.y)).toBe(true);
      expect(Number.isFinite(particle.velocityX)).toBe(true);
      expect(Number.isFinite(particle.velocityY)).toBe(true);
    }
  });

  it('convierte un impulso radial en movimiento sin cambiar la cantidad de materia', () => {
    const simulation = new ViscoelasticFluidSimulation(320, 180, 80, 7);
    const speedBefore = simulation.particles.reduce(
      (total, particle) => total + Math.hypot(particle.velocityX, particle.velocityY),
      0,
    );
    simulation.applyRadialImpulse(160, 70, 12, 150);
    const speedAfter = simulation.particles.reduce(
      (total, particle) => total + Math.hypot(particle.velocityX, particle.velocityY),
      0,
    );
    expect(simulation.particleCount).toBe(80);
    expect(speedAfter).toBeGreaterThan(speedBefore);
  });

  it('acota parámetros externos y permite cambiar la resolución de partículas', () => {
    const simulation = new ViscoelasticFluidSimulation(320, 180, 60);
    simulation.setMaterial({
      restDensity: 99,
      springStiffness: -2,
      timeStep: 4,
    });
    expect(simulation.material.restDensity).toBe(8);
    expect(simulation.material.springStiffness).toBe(0);
    expect(simulation.material.timeStep).toBe(1);
    simulation.reset(100);
    expect(simulation.particleCount).toBe(100);
  });
});
