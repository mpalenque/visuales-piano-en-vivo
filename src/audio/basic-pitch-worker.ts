import * as tf from '@tensorflow/tfjs';
import { BasicPitch } from '@spotify/basic-pitch/esm/inference';
import modelJson from '@spotify/basic-pitch/model/model.json';
import modelWeightsUrl from '@spotify/basic-pitch/model/group1-shard1of1.bin?url';

const MODEL_SAMPLE_RATE = 22_050;
const FRAME_HOP = 256;
const ONSET_THRESHOLD = 0.42;

interface AnalyseRequest {
  type: 'analyse';
  samples: ArrayBuffer;
  startTime: number;
}

interface TranscribedNote {
  midi: number;
  frequency: number;
  strength: number;
  time: number;
}

let detector: Promise<BasicPitch> | null = null;
let running = false;
let queued: AnalyseRequest | null = null;

const workerScope = self as unknown as DedicatedWorkerGlobalScope;

workerScope.onmessage = ({ data }: MessageEvent<AnalyseRequest>) => {
  if (data.type !== 'analyse') return;
  if (running) {
    queued = data;
    return;
  }
  void analyse(data);
};

async function analyse(request: AnalyseRequest): Promise<void> {
  running = true;
  try {
    const pitch = await getDetector();
    const notes: TranscribedNote[] = [];
    let frameOffset = 0;
    await pitch.evaluateModel(new Float32Array(request.samples), (_frames, onsets) => {
      for (let frame = 1; frame < onsets.length - 1; frame += 1) {
        for (let index = 0; index < onsets[frame].length; index += 1) {
          const strength = onsets[frame][index];
          if (strength < ONSET_THRESHOLD || strength < onsets[frame - 1][index] || strength < onsets[frame + 1][index]) continue;
          notes.push({
            midi: 21 + index,
            frequency: 440 * 2 ** ((21 + index - 69) / 12),
            strength,
            time: request.startTime + (frameOffset + frame) * FRAME_HOP / MODEL_SAMPLE_RATE,
          });
        }
      }
      frameOffset += onsets.length;
    }, () => undefined);
    workerScope.postMessage({ type: 'notes', notes });
  } catch (error) {
    workerScope.postMessage({ type: 'status', status: 'error', error: error instanceof Error ? error.message : 'Falló el modelo polifónico.' });
  } finally {
    running = false;
    const next = queued;
    queued = null;
    if (next) void analyse(next);
  }
}

async function getDetector(): Promise<BasicPitch> {
  if (!detector) {
    workerScope.postMessage({ type: 'status', status: 'loading' });
    detector = createDetector();
    detector.then(() => workerScope.postMessage({ type: 'status', status: 'ready' }));
  }
  return detector;
}

async function createDetector(): Promise<BasicPitch> {
  const response = await fetch(modelWeightsUrl);
  if (!response.ok) throw new Error(`No se pudieron cargar los pesos del modelo (${response.status}).`);
  const manifest = modelJson.weightsManifest.flatMap((group) => group.weights);
  const artifacts: tf.io.ModelArtifacts = {
    modelTopology: modelJson.modelTopology,
    weightSpecs: manifest as tf.io.WeightsManifestEntry[],
    weightData: await response.arrayBuffer(),
    format: modelJson.format,
    generatedBy: modelJson.generatedBy,
    convertedBy: modelJson.convertedBy,
  };
  return new BasicPitch(tf.loadGraphModel(tf.io.fromMemory(artifacts)));
}

// Load weights before the performer starts so the first note does not pay the
// model-download and graph-compilation cost.
void getDetector();
