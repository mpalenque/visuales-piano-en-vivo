import { createDspState, extractFeatures, rmsOf } from './dsp.ts';

/* AudioWorklet adapter: DSP itself is pure and tested in dsp.ts. */
class FeatureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frameSize = 4096;
    this.hopSize = 512;
    this.ring = new Float32Array(this.frameSize);
    this.orderedFrame = new Float32Array(this.frameSize);
    this.dsp = createDspState(this.frameSize);
    this.writeIndex = 0;
    this.sampleCount = 0;
    this.sinceAnalysis = 0;
    this.transcriptionChunk = new Float32Array(2048);
    this.transcriptionWriteIndex = 0;
    this.calibratingUntil = 0;
    this.calibrationFloor = Infinity;
    this.calibrationPeak = 0;
    this.port.onmessage = ({ data }) => {
      if (data?.type === 'calibrate') {
        this.calibratingUntil = currentTime + (data.seconds ?? 10);
        this.calibrationFloor = Infinity;
        this.calibrationPeak = 0;
        this.port.postMessage({ type: 'calibration', state: 'started' });
      }
    };
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (output?.[0]) output[0].fill(0);
    const channel = input?.[0];
    if (!channel) return true;
    for (let index = 0; index < channel.length; index += 1) {
      this.ring[this.writeIndex] = channel[index];
      this.writeIndex = (this.writeIndex + 1) % this.frameSize;
      this.transcriptionChunk[this.transcriptionWriteIndex] = channel[index];
      this.transcriptionWriteIndex += 1;
      if (this.transcriptionWriteIndex >= this.transcriptionChunk.length) {
        this.port.postMessage({ type: 'audio', samples: this.transcriptionChunk.buffer }, [this.transcriptionChunk.buffer]);
        this.transcriptionChunk = new Float32Array(2048);
        this.transcriptionWriteIndex = 0;
      }
      this.sampleCount += 1;
      this.sinceAnalysis += 1;
      if (this.sampleCount >= this.frameSize && this.sinceAnalysis >= this.hopSize) {
        this.sinceAnalysis = 0;
        this.analyse();
      }
    }
    return true;
  }

  analyse() {
    for (let index = 0; index < this.frameSize; index += 1) this.orderedFrame[index] = this.ring[(this.writeIndex + index) % this.frameSize];
    this.calibrate(rmsOf(this.orderedFrame));
    const frame = extractFeatures(this.orderedFrame, sampleRate, this.dsp, currentTime);
    this.port.postMessage({ type: 'features', frame });
  }

  calibrate(rawRms) {
    if (this.calibratingUntil > 0) {
      this.calibrationFloor = Math.min(this.calibrationFloor, rawRms);
      this.calibrationPeak = Math.max(this.calibrationPeak, rawRms);
      if (currentTime >= this.calibratingUntil) {
        this.dsp.noiseFloor = Number.isFinite(this.calibrationFloor) ? this.calibrationFloor * 1.5 : this.dsp.noiseFloor;
        this.dsp.signalPeak = Math.max(this.calibrationPeak, this.dsp.noiseFloor * 4, 0.01);
        this.calibratingUntil = 0;
        this.port.postMessage({ type: 'calibration', state: 'complete', noiseFloor: this.dsp.noiseFloor, peak: this.dsp.signalPeak });
      }
    } else {
      this.dsp.noiseFloor = Math.min(this.dsp.noiseFloor * 1.0005, Math.max(0.0005, rawRms * 0.6));
      this.dsp.signalPeak = Math.max(rawRms, this.dsp.signalPeak * 0.9995);
    }
  }
}

registerProcessor('feature-processor', FeatureProcessor);
