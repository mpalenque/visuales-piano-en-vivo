/**
 * Native TypeScript adaptation of Grant Kot's MIT-licensed
 * particle_based_viscoelastic_fluid/sim_5.js.
 *
 * Upstream: https://github.com/kotsoft/particle_based_viscoelastic_fluid
 * Pinned revision: 3238340fbd1e26665ac2a7b3e9ca5b42bb4f368e
 *
 * The algorithm follows Clavet, Beaudoin and Poulin: spatial hashing,
 * viscosity impulses, double-density relaxation and plastic springs.
 */

const HASH_BUCKETS = 4096;
const EPSILON = 1e-6;

export interface ViscoelasticMaterial {
  restDensity: number;
  stiffness: number;
  nearStiffness: number;
  kernelRadius: number;
  springStiffness: number;
  plasticity: number;
  yieldRatio: number;
  minDistanceRatio: number;
  linearViscosity: number;
  quadraticViscosity: number;
  timeStep: number;
}

export interface FluidDrive {
  gravityX: number;
  gravityY: number;
  attractorX?: number;
  attractorY?: number;
  attraction?: number;
}

export interface FluidParticle {
  x: number;
  y: number;
  previousX: number;
  previousY: number;
  velocityX: number;
  velocityY: number;
  readonly springs: Map<number, number>;
}

const defaultMaterial = (): ViscoelasticMaterial => ({
  restDensity: 4,
  stiffness: 0.5,
  nearStiffness: 0.5,
  kernelRadius: 28,
  springStiffness: 0.08,
  plasticity: 0.5,
  yieldRatio: 0.25,
  minDistanceRatio: 0.25,
  linearViscosity: 0.04,
  quadraticViscosity: 0.1,
  timeStep: 0.82,
});

const clamp = (value: number, min: number, max: number): number => (
  Math.max(min, Math.min(max, Number.isFinite(value) ? value : min))
);

function randomGenerator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4_294_967_296;
  };
}

export class ViscoelasticFluidSimulation {
  readonly material = defaultMaterial();
  private particleData: FluidParticle[] = [];
  private readonly particleListHeads = new Int32Array(HASH_BUCKETS).fill(-1);
  private readonly activeBuckets = new Int32Array(HASH_BUCKETS);
  private particleListNext = new Int32Array(0);
  private activeBucketCount = 0;
  private seed: number;

  constructor(
    readonly width = 960,
    readonly height = 540,
    particleCount = 1_000,
    seed = 0x4b1d,
  ) {
    if (width <= 20 || height <= 20) throw new Error('El dominio del fluido es demasiado pequeño.');
    this.seed = seed;
    this.reset(particleCount);
  }

  get particles(): readonly FluidParticle[] {
    return this.particleData;
  }

  get particleCount(): number {
    return this.particleData.length;
  }

  get springCount(): number {
    return this.particleData.reduce((total, particle) => total + particle.springs.size, 0);
  }

  reset(particleCount = this.particleData.length || 1_000): void {
    const count = Math.round(clamp(particleCount, 16, 4_000));
    const random = randomGenerator(this.seed);
    this.seed = (this.seed + 0x9e3779b9) >>> 0;
    this.particleData = Array.from({ length: count }, (_, index) => {
      const columnCount = Math.max(8, Math.floor(Math.sqrt(count * this.width / this.height)));
      const row = Math.floor(index / columnCount);
      const column = index % columnCount;
      const spacing = Math.min(
        this.material.kernelRadius * 0.32,
        (this.width * 0.72) / columnCount,
      );
      const blockWidth = columnCount * spacing;
      const x = this.width * 0.5 - blockWidth * 0.5 + (column + 0.5) * spacing
        + (random() - 0.5) * spacing * 0.32;
      const y = this.height * 0.16 + (row + 0.5) * spacing
        + (random() - 0.5) * spacing * 0.32;
      const velocityX = (random() - 0.5) * 0.45;
      const velocityY = (random() - 0.5) * 0.45;
      return {
        x,
        y,
        previousX: x,
        previousY: y,
        velocityX,
        velocityY,
        springs: new Map<number, number>(),
      };
    });
    this.particleListNext = new Int32Array(count).fill(-1);
    this.particleListHeads.fill(-1);
    this.activeBucketCount = 0;
  }

  setMaterial(values: Partial<ViscoelasticMaterial>): void {
    if (values.restDensity !== undefined) this.material.restDensity = clamp(values.restDensity, 0.1, 8);
    if (values.stiffness !== undefined) this.material.stiffness = clamp(values.stiffness, 0.05, 2);
    if (values.nearStiffness !== undefined) this.material.nearStiffness = clamp(values.nearStiffness, 0.05, 2);
    if (values.kernelRadius !== undefined) this.material.kernelRadius = clamp(values.kernelRadius, 8, 64);
    if (values.springStiffness !== undefined) this.material.springStiffness = clamp(values.springStiffness, 0, 0.5);
    if (values.plasticity !== undefined) this.material.plasticity = clamp(values.plasticity, 0.05, 1);
    if (values.yieldRatio !== undefined) this.material.yieldRatio = clamp(values.yieldRatio, 0.05, 1);
    if (values.minDistanceRatio !== undefined) this.material.minDistanceRatio = clamp(values.minDistanceRatio, 0.025, 1);
    if (values.linearViscosity !== undefined) this.material.linearViscosity = clamp(values.linearViscosity, 0, 0.5);
    if (values.quadraticViscosity !== undefined) this.material.quadraticViscosity = clamp(values.quadraticViscosity, 0, 0.5);
    if (values.timeStep !== undefined) this.material.timeStep = clamp(values.timeStep, 0.1, 1);
  }

  step(drive: FluidDrive): void {
    const dt = this.material.timeStep;
    this.populateHashGrid();
    this.applyDrive(drive, dt);
    this.applyViscosity(dt);

    for (const particle of this.particleData) {
      particle.previousX = particle.x;
      particle.previousY = particle.y;
      particle.x += particle.velocityX * dt;
      particle.y += particle.velocityY * dt;
    }

    this.applySpringDisplacements(dt);
    this.doubleDensityRelaxation(dt);
    this.resolveCollisions(dt);

    const inverseDt = 1 / dt;
    for (let index = 0; index < this.particleData.length; index += 1) {
      const particle = this.particleData[index];
      if (!Number.isFinite(particle.x) || !Number.isFinite(particle.y)) {
        this.recoverParticle(particle, index);
        continue;
      }
      particle.velocityX = clamp((particle.x - particle.previousX) * inverseDt, -18, 18);
      particle.velocityY = clamp((particle.y - particle.previousY) * inverseDt, -18, 18);
    }
  }

  applyRadialImpulse(
    x: number,
    y: number,
    strength: number,
    radius = Math.min(this.width, this.height) * 0.36,
  ): void {
    const safeRadius = Math.max(1, radius);
    const radiusSquared = safeRadius * safeRadius;
    for (let index = 0; index < this.particleData.length; index += 1) {
      const particle = this.particleData[index];
      const deltaX = particle.x - x;
      const deltaY = particle.y - y;
      const distanceSquared = deltaX * deltaX + deltaY * deltaY;
      if (distanceSquared >= radiusSquared) continue;
      const distance = Math.sqrt(Math.max(distanceSquared, EPSILON));
      const influence = 1 - distance / safeRadius;
      const impulse = strength * influence * influence;
      const tangent = (index % 2 === 0 ? 1 : -1) * impulse * 0.26;
      particle.velocityX += deltaX / distance * impulse - deltaY / distance * tangent;
      particle.velocityY += deltaY / distance * impulse + deltaX / distance * tangent;
    }
  }

  private applyDrive(drive: FluidDrive, dt: number): void {
    const gravityScale = 0.02 * this.material.kernelRadius * dt;
    const gravityX = clamp(drive.gravityX, -1, 1) * gravityScale;
    const gravityY = clamp(drive.gravityY, -1, 1) * gravityScale;
    const attraction = clamp(drive.attraction ?? 0, -1, 1)
      * 0.014 * this.material.kernelRadius * dt;
    const attractorX = drive.attractorX ?? this.width * 0.5;
    const attractorY = drive.attractorY ?? this.height * 0.5;
    const influenceRadiusSquared = Math.pow(Math.max(this.width, this.height) * 0.64, 2);

    for (const particle of this.particleData) {
      particle.velocityX += gravityX;
      particle.velocityY += gravityY;
      if (Math.abs(attraction) <= EPSILON) continue;
      const deltaX = particle.x - attractorX;
      const deltaY = particle.y - attractorY;
      const distanceSquared = deltaX * deltaX + deltaY * deltaY;
      if (distanceSquared <= EPSILON || distanceSquared >= influenceRadiusSquared) continue;
      const inverseDistance = 1 / Math.sqrt(distanceSquared);
      particle.velocityX -= attraction * deltaX * inverseDistance;
      particle.velocityY -= attraction * deltaY * inverseDistance;
    }
  }

  private doubleDensityRelaxation(dt: number): void {
    const kernelRadius = this.material.kernelRadius;
    const kernelRadiusSquared = kernelRadius * kernelRadius;
    const inverseKernelRadius = 1 / kernelRadius;
    const stiffness = this.material.stiffness * dt * dt;
    const nearStiffness = this.material.nearStiffness * dt * dt;
    const minimumDistance = this.material.minDistanceRatio * kernelRadius;
    const addSprings = this.material.springStiffness > 0;
    const neighbours: number[] = [];
    const neighbourUnitX: number[] = [];
    const neighbourUnitY: number[] = [];
    const neighbourCloseness: number[] = [];
    const visitedBuckets = new Int32Array(9);

    for (let activeIndex = 0; activeIndex < this.activeBucketCount; activeIndex += 1) {
      let selfIndex = this.particleListHeads[this.activeBuckets[activeIndex]];
      while (selfIndex !== -1) {
        const particle = this.particleData[selfIndex];
        let density = 0;
        let nearDensity = 0;
        let neighbourCount = 0;
        let visitedCount = 0;
        const bucketX = Math.floor(particle.x * inverseKernelRadius);
        const bucketY = Math.floor(particle.y * inverseKernelRadius);

        for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
          for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
            const bucket = this.hashBucket(bucketX + offsetX, bucketY + offsetY);
            let visited = false;
            for (let index = 0; index < visitedCount; index += 1) {
              if (visitedBuckets[index] === bucket) visited = true;
            }
            if (visited) continue;
            visitedBuckets[visitedCount] = bucket;
            visitedCount += 1;

            let neighbourIndex = this.particleListHeads[bucket];
            while (neighbourIndex !== -1) {
              if (neighbourIndex === selfIndex) {
                neighbourIndex = this.particleListNext[neighbourIndex];
                continue;
              }
              const neighbour = this.particleData[neighbourIndex];
              const deltaX = neighbour.x - particle.x;
              const deltaY = neighbour.y - particle.y;
              if (Math.abs(deltaX) > kernelRadius || Math.abs(deltaY) > kernelRadius) {
                neighbourIndex = this.particleListNext[neighbourIndex];
                continue;
              }
              const distanceSquared = deltaX * deltaX + deltaY * deltaY;
              if (distanceSquared > EPSILON && distanceSquared < kernelRadiusSquared) {
                const distance = Math.sqrt(distanceSquared);
                const closeness = 1 - distance * inverseKernelRadius;
                const closenessSquared = closeness * closeness;
                density += closenessSquared;
                nearDensity += closenessSquared * closeness;
                neighbours[neighbourCount] = neighbourIndex;
                neighbourUnitX[neighbourCount] = deltaX / distance;
                neighbourUnitY[neighbourCount] = deltaY / distance;
                neighbourCloseness[neighbourCount] = closeness;
                neighbourCount += 1;
                if (
                  addSprings
                  && selfIndex < neighbourIndex
                  && distance > minimumDistance
                  && !particle.springs.has(neighbourIndex)
                ) {
                  particle.springs.set(neighbourIndex, distance);
                }
              }
              neighbourIndex = this.particleListNext[neighbourIndex];
            }
          }
        }

        const pressure = Math.min(1, stiffness * (density - this.material.restDensity));
        const nearPressure = Math.min(1, nearStiffness * nearDensity);
        let displacementX = 0;
        let displacementY = 0;
        for (let index = 0; index < neighbourCount; index += 1) {
          const closeness = neighbourCloseness[index];
          const displacement = (
            pressure * closeness + nearPressure * closeness * closeness
          ) * 0.5;
          const deltaX = displacement * neighbourUnitX[index];
          const deltaY = displacement * neighbourUnitY[index];
          const neighbour = this.particleData[neighbours[index]];
          neighbour.x += deltaX;
          neighbour.y += deltaY;
          displacementX -= deltaX;
          displacementY -= deltaY;
        }
        particle.x += displacementX;
        particle.y += displacementY;
        selfIndex = this.particleListNext[selfIndex];
      }
    }
  }

  private applySpringDisplacements(dt: number): void {
    if (this.material.springStiffness <= 0) return;
    const kernelRadius = this.material.kernelRadius;
    const springStiffness = this.material.springStiffness * dt * dt;
    const plasticity = this.material.plasticity * dt;
    const minimumDistance = this.material.minDistanceRatio * kernelRadius;

    for (const particle of this.particleData) {
      for (const [neighbourIndex, originalRestLength] of particle.springs) {
        const neighbour = this.particleData[neighbourIndex];
        if (!neighbour) {
          particle.springs.delete(neighbourIndex);
          continue;
        }
        let deltaX = particle.x - neighbour.x;
        let deltaY = particle.y - neighbour.y;
        const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
        if (distance <= EPSILON) continue;
        const tolerableDeformation = this.material.yieldRatio * originalRestLength;
        let restLength = originalRestLength;
        if (distance > restLength + tolerableDeformation) {
          restLength += plasticity * (distance - restLength - tolerableDeformation);
        } else if (distance < restLength - tolerableDeformation && distance > minimumDistance) {
          restLength -= plasticity * (restLength - tolerableDeformation - distance);
        }
        restLength = Math.max(minimumDistance, restLength);
        if (restLength > kernelRadius) {
          particle.springs.delete(neighbourIndex);
          continue;
        }
        particle.springs.set(neighbourIndex, restLength);
        const displacement = springStiffness
          * (1 - restLength / kernelRadius)
          * (distance - restLength)
          / distance;
        deltaX *= displacement;
        deltaY *= displacement;
        particle.x -= deltaX;
        particle.y -= deltaY;
        neighbour.x += deltaX;
        neighbour.y += deltaY;
      }
    }
  }

  private applyViscosity(dt: number): void {
    if (
      this.material.linearViscosity <= 0
      && this.material.quadraticViscosity <= 0
    ) return;
    const kernelRadius = this.material.kernelRadius;
    const kernelRadiusSquared = kernelRadius * kernelRadius;
    const inverseKernelRadius = 1 / kernelRadius;
    const linearViscosity = this.material.linearViscosity * dt;
    const quadraticViscosity = this.material.quadraticViscosity * dt;
    const visitedBuckets = new Int32Array(9);

    for (let activeIndex = 0; activeIndex < this.activeBucketCount; activeIndex += 1) {
      let selfIndex = this.particleListHeads[this.activeBuckets[activeIndex]];
      while (selfIndex !== -1) {
        const particle = this.particleData[selfIndex];
        const bucketX = Math.floor(particle.x * inverseKernelRadius);
        const bucketY = Math.floor(particle.y * inverseKernelRadius);
        let visitedCount = 0;
        for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
          for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
            const bucket = this.hashBucket(bucketX + offsetX, bucketY + offsetY);
            let visited = false;
            for (let index = 0; index < visitedCount; index += 1) {
              if (visitedBuckets[index] === bucket) visited = true;
            }
            if (visited) continue;
            visitedBuckets[visitedCount] = bucket;
            visitedCount += 1;
            let neighbourIndex = this.particleListHeads[bucket];
            while (neighbourIndex !== -1) {
              if (neighbourIndex === selfIndex) {
                neighbourIndex = this.particleListNext[neighbourIndex];
                continue;
              }
              const neighbour = this.particleData[neighbourIndex];
              const deltaX = neighbour.x - particle.x;
              const deltaY = neighbour.y - particle.y;
              const distanceSquared = deltaX * deltaX + deltaY * deltaY;
              if (distanceSquared > EPSILON && distanceSquared < kernelRadiusSquared) {
                const distance = Math.sqrt(distanceSquared);
                const directionX = deltaX / distance;
                const directionY = deltaY / distance;
                const inwardVelocity = Math.min(
                  1,
                  (particle.velocityX - neighbour.velocityX) * directionX
                    + (particle.velocityY - neighbour.velocityY) * directionY,
                );
                if (inwardVelocity > 0) {
                  const closeness = 1 - distance * inverseKernelRadius;
                  const impulse = closeness * (
                    linearViscosity * inwardVelocity
                      + quadraticViscosity * inwardVelocity * inwardVelocity
                  ) * 0.5;
                  const impulseX = impulse * directionX;
                  const impulseY = impulse * directionY;
                  particle.velocityX -= impulseX;
                  particle.velocityY -= impulseY;
                  neighbour.velocityX += impulseX;
                  neighbour.velocityY += impulseY;
                }
              }
              neighbourIndex = this.particleListNext[neighbourIndex];
            }
          }
        }
        selfIndex = this.particleListNext[selfIndex];
      }
    }
  }

  private resolveCollisions(dt: number): void {
    const correction = 0.5 * dt * dt;
    const minimumX = 5;
    const maximumX = this.width - 5;
    const minimumY = 5;
    const maximumY = this.height - 5;
    for (const particle of this.particleData) {
      if (particle.x < minimumX) particle.x += correction * (minimumX - particle.x);
      else if (particle.x > maximumX) particle.x += correction * (maximumX - particle.x);
      if (particle.y < minimumY) particle.y += correction * (minimumY - particle.y);
      else if (particle.y > maximumY) particle.y += correction * (maximumY - particle.y);
    }
  }

  private populateHashGrid(): void {
    for (let index = 0; index < this.activeBucketCount; index += 1) {
      this.particleListHeads[this.activeBuckets[index]] = -1;
    }
    this.activeBucketCount = 0;
    const inverseBucketSize = 1 / this.material.kernelRadius;
    for (let index = 0; index < this.particleData.length; index += 1) {
      const particle = this.particleData[index];
      const bucket = this.hashBucket(
        Math.floor(particle.x * inverseBucketSize),
        Math.floor(particle.y * inverseBucketSize),
      );
      const head = this.particleListHeads[bucket];
      if (head === -1) {
        this.activeBuckets[this.activeBucketCount] = bucket;
        this.activeBucketCount += 1;
      }
      this.particleListNext[index] = head;
      this.particleListHeads[bucket] = index;
    }
  }

  private hashBucket(x: number, y: number): number {
    const hash = (Math.imul(x, 92_837_111) ^ Math.imul(y, 689_287_499)) | 0;
    return Math.abs(hash === -2_147_483_648 ? 0 : hash) % HASH_BUCKETS;
  }

  private recoverParticle(particle: FluidParticle, index: number): void {
    const angle = index * 2.399963229728653;
    const radius = 8 + (index % 31) * 0.8;
    particle.x = this.width * 0.5 + Math.cos(angle) * radius;
    particle.y = this.height * 0.5 + Math.sin(angle) * radius;
    particle.previousX = particle.x;
    particle.previousY = particle.y;
    particle.velocityX = 0;
    particle.velocityY = 0;
    particle.springs.clear();
  }
}
