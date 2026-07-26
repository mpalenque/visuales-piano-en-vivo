export interface TransportFieldBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
}

export interface TransportFieldCentroid {
  x: number;
  y: number;
  normalizedX: number;
  normalizedY: number;
}

export interface TransportFieldCovariance {
  xx: number;
  xy: number;
  yy: number;
}

export interface TransportFieldMajorAxis {
  angleRadians: number;
  majorVariance: number;
  minorVariance: number;
  anisotropy: number;
}

export interface TransportFieldComponents {
  count: number;
  largestPixels: number;
  largestEnergy: number;
}

export interface TransportFieldLagValues {
  2: number;
  4: number;
  8: number;
}

export interface TransportFieldMetrics {
  sum: number;
  maximum: number;
  p95: number;
  p99: number;
  nonZeroPixels: number;
  boundingBox: TransportFieldBounds | null;
  centroid: TransportFieldCentroid | null;
  covariance: TransportFieldCovariance;
  majorAxis: TransportFieldMajorAxis;
  connectedComponents: TransportFieldComponents;
  outsideLeak: number;
  outsideLeakRatio: number;
  outsideLeakPixels: number;
  clippingThreshold: number;
  clippedPixels: number;
  clippedRatio: number;
  phase4Score: number;
  autocorrelation: TransportFieldLagValues;
  autocorrelationLagSpikes: TransportFieldLagValues;
}

export interface AnalyzeTransportFieldInput {
  energy: ArrayLike<number>;
  width: number;
  height: number;
  receiverMask?: ArrayLike<number>;
  nonZeroThreshold?: number;
  clippingThreshold?: number;
}

const ANALYZED_LAGS = [2, 4, 8] as const;

const normalizedCoordinate = (coordinate: number, extent: number): number =>
  extent > 1 ? coordinate / (extent - 1) : 0;

const percentile = (sortedValues: readonly number[], quantile: number): number => {
  if (sortedValues.length === 0) return 0;
  const position = (sortedValues.length - 1) * quantile;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  const fraction = position - lowerIndex;
  return sortedValues[lowerIndex]
    + (sortedValues[upperIndex] - sortedValues[lowerIndex]) * fraction;
};

const emptyLagValues = (): TransportFieldLagValues => ({
  2: 0,
  4: 0,
  8: 0,
});

const validateExtent = (value: number, name: string): number => {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return value;
};

const validateThreshold = (
  value: number | undefined,
  fallback: number,
  name: string,
  allowZero: boolean,
): number => {
  const threshold = value ?? fallback;
  if (
    !Number.isFinite(threshold)
    || (allowZero ? threshold < 0 : threshold <= 0)
  ) {
    throw new RangeError(
      `${name} must be ${allowZero ? 'non-negative' : 'positive'} and finite`,
    );
  }
  return threshold;
};

const connectedComponents = (
  energy: Float64Array,
  width: number,
  height: number,
  threshold: number,
): TransportFieldComponents => {
  const visited = new Uint8Array(energy.length);
  const queue = new Int32Array(energy.length);
  let count = 0;
  let largestPixels = 0;
  let largestEnergy = 0;

  for (let start = 0; start < energy.length; start += 1) {
    if (visited[start] !== 0 || energy[start] <= threshold) continue;
    count += 1;
    let readIndex = 0;
    let writeIndex = 0;
    let componentPixels = 0;
    let componentEnergy = 0;
    queue[writeIndex] = start;
    writeIndex += 1;
    visited[start] = 1;

    while (readIndex < writeIndex) {
      const index = queue[readIndex];
      readIndex += 1;
      componentPixels += 1;
      componentEnergy += energy[index];
      const x = index % width;
      const y = Math.floor(index / width);

      const visit = (neighbour: number): void => {
        if (
          visited[neighbour] !== 0
          || energy[neighbour] <= threshold
        ) return;
        visited[neighbour] = 1;
        queue[writeIndex] = neighbour;
        writeIndex += 1;
      };

      if (x > 0) visit(index - 1);
      if (x + 1 < width) visit(index + 1);
      if (y > 0) visit(index - width);
      if (y + 1 < height) visit(index + width);
    }

    if (
      componentPixels > largestPixels
      || (
        componentPixels === largestPixels
        && componentEnergy > largestEnergy
      )
    ) {
      largestPixels = componentPixels;
      largestEnergy = componentEnergy;
    }
  }

  return { count, largestPixels, largestEnergy };
};

const spatialAutocorrelation = (
  energy: Float64Array,
  width: number,
  height: number,
  lag: number,
  receiverMask?: ArrayLike<number>,
): number => {
  let dotProduct = 0;
  let firstMagnitude = 0;
  let secondMagnitude = 0;

  const addPair = (firstIndex: number, secondIndex: number): void => {
    if (
      receiverMask
      && (
        receiverMask[firstIndex] <= 0
        || receiverMask[secondIndex] <= 0
      )
    ) return;
    const first = energy[firstIndex];
    const second = energy[secondIndex];
    dotProduct += first * second;
    firstMagnitude += first * first;
    secondMagnitude += second * second;
  };

  if (lag < width) {
    for (let y = 0; y < height; y += 1) {
      const rowStart = y * width;
      for (let x = 0; x + lag < width; x += 1) {
        addPair(rowStart + x, rowStart + x + lag);
      }
    }
  }
  if (lag < height) {
    for (let y = 0; y + lag < height; y += 1) {
      const firstRow = y * width;
      const secondRow = (y + lag) * width;
      for (let x = 0; x < width; x += 1) {
        addPair(firstRow + x, secondRow + x);
      }
    }
  }

  const denominator = Math.sqrt(firstMagnitude * secondMagnitude);
  return denominator > 0 ? dotProduct / denominator : 0;
};

export function analyzeTransportField(
  input: AnalyzeTransportFieldInput,
): TransportFieldMetrics {
  const width = validateExtent(input.width, 'width');
  const height = validateExtent(input.height, 'height');
  const pixelCount = width * height;
  if (input.energy.length !== pixelCount) {
    throw new RangeError('energy length must equal width * height');
  }
  if (
    input.receiverMask
    && input.receiverMask.length !== pixelCount
  ) {
    throw new RangeError('receiverMask length must equal width * height');
  }

  const nonZeroThreshold = validateThreshold(
    input.nonZeroThreshold,
    1e-6,
    'nonZeroThreshold',
    true,
  );
  const clippingThreshold = validateThreshold(
    input.clippingThreshold,
    1,
    'clippingThreshold',
    false,
  );
  const energy = new Float64Array(pixelCount);
  const activeValues: number[] = [];
  let sum = 0;
  let maximum = 0;
  let nonZeroPixels = 0;
  let clippedPixels = 0;
  let outsideLeak = 0;
  let outsideLeakPixels = 0;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  let weightedX = 0;
  let weightedY = 0;
  let phaseReal = 0;
  let phaseImaginary = 0;
  let phaseWeight = 0;

  for (let index = 0; index < pixelCount; index += 1) {
    const rawValue = input.energy[index];
    const value = Number.isFinite(rawValue) ? Math.max(0, rawValue) : 0;
    energy[index] = value;
    sum += value;
    maximum = Math.max(maximum, value);
    const active = value > nonZeroThreshold;
    if (active) {
      activeValues.push(value);
      nonZeroPixels += 1;
      const x = index % width;
      const y = Math.floor(index / width);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      weightedX += x * value;
      weightedY += y * value;
    }
    if (value >= clippingThreshold) clippedPixels += 1;
    if (input.receiverMask && input.receiverMask[index] <= 0 && value > 0) {
      outsideLeak += value;
      if (active) outsideLeakPixels += 1;
    }

    if (!input.receiverMask || input.receiverMask[index] > 0) {
      const x = index % width;
      const y = Math.floor(index / width);
      const phase = (x + y * 2) % 4;
      const angle = phase * Math.PI * 0.5;
      phaseReal += value * Math.cos(angle);
      phaseImaginary += value * Math.sin(angle);
      phaseWeight += value;
    }
  }

  activeValues.sort((left, right) => left - right);
  const boundingBox = nonZeroPixels > 0
    ? {
        minX,
        minY,
        maxX,
        maxY,
        width: maxX - minX + 1,
        height: maxY - minY + 1,
      }
    : null;
  const centroidX = sum > 0 ? weightedX / sum : 0;
  const centroidY = sum > 0 ? weightedY / sum : 0;
  const centroid = sum > 0
    ? {
        x: centroidX,
        y: centroidY,
        normalizedX: normalizedCoordinate(centroidX, width),
        normalizedY: normalizedCoordinate(centroidY, height),
      }
    : null;

  let covarianceXx = 0;
  let covarianceXy = 0;
  let covarianceYy = 0;
  if (sum > 0) {
    const normalizedCentroidX = normalizedCoordinate(centroidX, width);
    const normalizedCentroidY = normalizedCoordinate(centroidY, height);
    for (let index = 0; index < pixelCount; index += 1) {
      const value = energy[index];
      if (value <= 0) continue;
      const x = index % width;
      const y = Math.floor(index / width);
      const dx = normalizedCoordinate(x, width) - normalizedCentroidX;
      const dy = normalizedCoordinate(y, height) - normalizedCentroidY;
      covarianceXx += value * dx * dx;
      covarianceXy += value * dx * dy;
      covarianceYy += value * dy * dy;
    }
    covarianceXx /= sum;
    covarianceXy /= sum;
    covarianceYy /= sum;
  }
  const covariance = {
    xx: covarianceXx,
    xy: covarianceXy,
    yy: covarianceYy,
  };
  const covarianceTrace = covarianceXx + covarianceYy;
  const covarianceDiscriminant = Math.sqrt(
    (covarianceXx - covarianceYy) ** 2 + 4 * covarianceXy ** 2,
  );
  const majorVariance = (covarianceTrace + covarianceDiscriminant) * 0.5;
  const minorVariance = Math.max(
    0,
    (covarianceTrace - covarianceDiscriminant) * 0.5,
  );
  const majorAxis = {
    angleRadians: covarianceDiscriminant > 0
      ? 0.5 * Math.atan2(
          2 * covarianceXy,
          covarianceXx - covarianceYy,
        )
      : 0,
    majorVariance,
    minorVariance,
    anisotropy: covarianceTrace > 0
      ? (majorVariance - minorVariance) / covarianceTrace
      : 0,
  };

  const autocorrelation = emptyLagValues();
  const autocorrelationLagSpikes = emptyLagValues();
  for (const lag of ANALYZED_LAGS) {
    autocorrelation[lag] = spatialAutocorrelation(
      energy,
      width,
      height,
      lag,
      input.receiverMask,
    );
    const previous = spatialAutocorrelation(
      energy,
      width,
      height,
      lag - 1,
      input.receiverMask,
    );
    const next = spatialAutocorrelation(
      energy,
      width,
      height,
      lag + 1,
      input.receiverMask,
    );
    autocorrelationLagSpikes[lag] = Math.max(
      0,
      autocorrelation[lag] - (previous + next) * 0.5,
    );
  }

  return {
    sum,
    maximum,
    p95: percentile(activeValues, 0.95),
    p99: percentile(activeValues, 0.99),
    nonZeroPixels,
    boundingBox,
    centroid,
    covariance,
    majorAxis,
    connectedComponents: connectedComponents(
      energy,
      width,
      height,
      nonZeroThreshold,
    ),
    outsideLeak,
    outsideLeakRatio: sum > 0 ? outsideLeak / sum : 0,
    outsideLeakPixels,
    clippingThreshold,
    clippedPixels,
    clippedRatio: nonZeroPixels > 0 ? clippedPixels / nonZeroPixels : 0,
    phase4Score: phaseWeight > 0
      ? Math.hypot(phaseReal, phaseImaginary) / phaseWeight
      : 0,
    autocorrelation,
    autocorrelationLagSpikes,
  };
}
