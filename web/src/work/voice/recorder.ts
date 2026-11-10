// Microphone to 16 kHz mono PCM. The context resamples by itself; the worklet keeps capture off the main thread, which the map keeps busy.
import { toPcm16 } from './pcm';

const SAMPLE_RATE = 16_000;
const WORKLET = `registerProcessor('voice-capture', class extends AudioWorkletProcessor {
  buf = new Float32Array(800);
  at = 0;
  process(inputs) {
    for (const v of inputs[0]?.[0] ?? []) {
      this.buf[this.at++] = v;
      if (this.at === this.buf.length) {
        this.port.postMessage(this.buf);
        this.buf = new Float32Array(800);
        this.at = 0;
      }
    }
    return true;
  }
});`;

export interface Recorder {
  stop(): Int16Array;
}

export async function startRecorder(onChunk: (chunk: Float32Array) => void): Promise<Recorder> {
  // Browser noise suppression and echo cancellation are off: measured on real inference, with them Whisper dropped whole phrases.
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: true } });
  const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
  const close = () => {
    stream.getTracks().forEach((t) => t.stop());
    void ctx.close();
  };
  try {
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
    await ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    await ctx.resume();
    const chunks: Float32Array[] = [];
    const node = new AudioWorkletNode(ctx, 'voice-capture');
    node.port.onmessage = (e: MessageEvent<Float32Array>) => {
      chunks.push(e.data);
      onChunk(e.data);
    };
    // The processor writes nothing to its output: this only keeps the graph pulling, the speakers stay silent.
    ctx.createMediaStreamSource(stream).connect(node).connect(ctx.destination);
    return {
      stop() {
        node.port.onmessage = null;
        close();
        return toPcm16(chunks);
      },
    };
  } catch (e) {
    close();
    throw e;
  }
}
