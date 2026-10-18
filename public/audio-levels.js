// Live audio level of a MediaStream (for the mic meter and the "talking" indicator).

let audioContext = null;

/** One AudioContext for the whole page (meters and game sounds). */
export function getAudioContext() {
  audioContext ??= new AudioContext();
  return audioContext;
}

/** Browsers start audio suspended until the page is clicked; call this on any click or key. */
export function resumeAudio() {
  if (audioContext?.state === 'suspended') {
    audioContext.resume().catch((error) => console.warn('Could not start audio meter:', error));
  }
}

export class LevelMeter {
  constructor() {
    this.source = null;
    this.analyser = null;
    this.samples = null;
  }

  /** Measure this stream's first audio track (or nothing, if it has none). */
  setStream(stream) {
    this.disconnect();
    const track = stream?.getAudioTracks()[0];
    if (!track) return;
    try {
      const context = getAudioContext();
      this.analyser = context.createAnalyser();
      this.analyser.fftSize = 512;
      // A stream holding only the audio track keeps video out of the audio graph.
      this.source = context.createMediaStreamSource(new MediaStream([track]));
      this.source.connect(this.analyser);
      this.samples = new Float32Array(this.analyser.fftSize);
      resumeAudio();
    } catch (error) {
      console.warn('Audio level meter unavailable:', error);
      this.disconnect();
    }
  }

  /** Loudness right now as RMS, roughly 0 (silence) to 0.3 (shouting). */
  level() {
    if (!this.analyser || audioContext?.state !== 'running') return 0;
    this.analyser.getFloatTimeDomainData(this.samples);
    let sumOfSquares = 0;
    for (const sample of this.samples) sumOfSquares += sample * sample;
    return Math.sqrt(sumOfSquares / this.samples.length);
  }

  disconnect() {
    this.source?.disconnect();
    this.source = null;
    this.analyser = null;
    this.samples = null;
  }
}
