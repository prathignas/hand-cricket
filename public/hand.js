// Webcam + MediaPipe HandLandmarker finger counting.

// ---- Tuning knobs -----------------------------------------------------------

export const MEDIAPIPE_VERSION = '1.1.1';
const MEDIAPIPE_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}`;
const MEDIAPIPE_BUNDLE_URL = `${MEDIAPIPE_BASE}/vision_bundle.mjs`;
const MEDIAPIPE_WASM_URL = `${MEDIAPIPE_BASE}/wasm`;
const HAND_MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

// MediaPipe confidences (0–1). Raise them if random objects count as hands.
export const MIN_HAND_DETECTION_CONFIDENCE = 0.6;
export const MIN_HAND_PRESENCE_CONFIDENCE = 0.6;
export const MIN_TRACKING_CONFIDENCE = 0.5;

// A finger is raised when wrist→tip is this many times wrist→PIP (middle knuckle).
// Straight finger ≈ 1.4, curled ≈ 0.8. Lower it if raised fingers get missed.
export const FINGER_RAISED_RATIO = 1.2;

// Thumb is raised when BOTH are true:
// 1) thumb tip is far from the index knuckle, measured in palm lengths (wrist→middle knuckle).
//    Thumb out ≈ 0.6–0.9, tucked across the palm ≈ 0.3–0.4.
export const THUMB_AWAY_FROM_INDEX_RATIO = 0.5;
// 2) thumb points away from the hand: pinky knuckle→thumb tip is this many times
//    pinky knuckle→thumb base knuckle. Thumb out ≈ 1.3–1.6, wrapped over a fist ≈ 0.6–0.9.
export const THUMB_POINTING_OUT_RATIO = 1.2;

// Reveal smoothing: the locked number is the most common reading in this window.
export const LOCK_WINDOW_MS = 400;
// The hand must be seen in at least this share of frames in the window, or the ball is a NO BALL.
export const MIN_SEEN_FRACTION = 0.5;
// How much reading history to keep around.
const HISTORY_KEEP_MS = 2000;

// ---- Landmark indices -------------------------------------------------------

const WRIST = 0;
const THUMB_MCP = 2;
const THUMB_TIP = 4;
const INDEX_MCP = 5;
const MIDDLE_MCP = 9;
const PINKY_MCP = 17;
// [PIP, TIP] for index, middle, ring, pinky
const FINGERS = [
  [6, 8],
  [10, 12],
  [14, 16],
  [18, 20],
];

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, (a.z ?? 0) - (b.z ?? 0));
}

/**
 * Describe the hand pose. Uses distances from the wrist/knuckles (not screen y),
 * so a tilted or sideways hand still counts correctly.
 * Works best with world landmarks (metres, camera-independent), but normalized ones work too.
 */
export function analyzeHand(landmarks) {
  const wrist = landmarks[WRIST];
  const palmLength = distance(wrist, landmarks[MIDDLE_MCP]) || 1e-6;

  const fingerRatios = FINGERS.map(
    ([pip, tip]) => distance(wrist, landmarks[tip]) / (distance(wrist, landmarks[pip]) || 1e-6)
  );
  const fingersRaised = fingerRatios.map((ratio) => ratio > FINGER_RAISED_RATIO);

  const thumbAwayRatio = distance(landmarks[THUMB_TIP], landmarks[INDEX_MCP]) / palmLength;
  const thumbOutRatio =
    distance(landmarks[THUMB_TIP], landmarks[PINKY_MCP]) /
    (distance(landmarks[THUMB_MCP], landmarks[PINKY_MCP]) || 1e-6);
  const thumbRaised =
    thumbAwayRatio > THUMB_AWAY_FROM_INDEX_RATIO && thumbOutRatio > THUMB_POINTING_OUT_RATIO;

  return { fingerRatios, fingersRaised, thumbAwayRatio, thumbOutRatio, thumbRaised };
}

/** 1–5 raised fingers, thumb only = 6, fist = null. */
export function countFingers(landmarks) {
  if (!landmarks || landmarks.length < 21) return null;
  const { fingersRaised, thumbRaised } = analyzeHand(landmarks);
  const raisedFingers = fingersRaised.filter(Boolean).length;

  if (raisedFingers === 0) return thumbRaised ? 6 : null;
  return raisedFingers + (thumbRaised ? 1 : 0);
}

// ---- Camera -----------------------------------------------------------------

export class CameraError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'CameraError';
    this.cause = cause;
  }
}

export async function startCamera(videoElement) {
  if (!window.isSecureContext) {
    throw new CameraError(
      'The camera only works on https:// or http://localhost. Open the game at http://localhost:3000.'
    );
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new CameraError('This browser cannot use a webcam. Try the latest Chrome, Edge or Firefox.');
  }

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
      audio: false,
    });
  } catch (error) {
    throw new CameraError(describeCameraError(error), error);
  }

  videoElement.srcObject = stream;
  try {
    await videoElement.play();
  } catch (error) {
    throw new CameraError('The camera started but the video would not play. Reload the page.', error);
  }
  return stream;
}

export function describeCameraError(error) {
  switch (error?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Camera is blocked. Click the camera icon in the address bar, choose "Allow", then press Retry.';
    case 'NotFoundError':
    case 'OverconstrainedError':
    case 'NotSupportedError':
      return 'No webcam found. Plug one in, then press Retry.';
    case 'NotReadableError':
    case 'AbortError':
      return 'Your camera is busy in another app (Zoom, Meet, FaceTime…). Close it, then press Retry.';
    default:
      return `Could not start the camera (${error?.name || 'unknown error'}). Press Retry.`;
  }
}

// ---- Detector ---------------------------------------------------------------

async function createHandLandmarker() {
  // Dynamic import so a CDN failure becomes a catchable error instead of a dead page.
  const { FilesetResolver, HandLandmarker } = await import(MEDIAPIPE_BUNDLE_URL);
  const fileset = await FilesetResolver.forVisionTasks(MEDIAPIPE_WASM_URL);

  const optionsFor = (delegate) => ({
    baseOptions: { modelAssetPath: HAND_MODEL_URL, delegate },
    runningMode: 'VIDEO',
    numHands: 1,
    minHandDetectionConfidence: MIN_HAND_DETECTION_CONFIDENCE,
    minHandPresenceConfidence: MIN_HAND_PRESENCE_CONFIDENCE,
    minTrackingConfidence: MIN_TRACKING_CONFIDENCE,
  });

  try {
    const landmarker = await HandLandmarker.createFromOptions(fileset, optionsFor('GPU'));
    return { landmarker, delegate: 'GPU' };
  } catch (gpuError) {
    console.warn('GPU hand detector failed, falling back to CPU:', gpuError);
    const landmarker = await HandLandmarker.createFromOptions(fileset, optionsFor('CPU'));
    return { landmarker, delegate: 'CPU' };
  }
}

/**
 * Runs the detector on every new video frame and keeps a short reading history.
 * onFrame({ handSeen, number, analysis }) fires on each processed frame.
 */
export class HandTracker {
  constructor(video, overlayCanvas, { onFrame } = {}) {
    this.video = video;
    this.canvas = overlayCanvas;
    this.ctx = overlayCanvas?.getContext('2d') ?? null;
    this.onFrame = onFrame;
    this.landmarker = null;
    this.delegate = null;
    this.history = [];
    this.running = false;
    this.lastVideoTime = -1;
    this.rafId = 0;
    this.loop = this.loop.bind(this);
  }

  get isReady() {
    return this.landmarker !== null;
  }

  async init() {
    if (this.landmarker) return this.delegate;
    const { landmarker, delegate } = await createHandLandmarker();
    this.landmarker = landmarker;
    this.delegate = delegate;
    return delegate;
  }

  start() {
    if (this.running || !this.landmarker) return;
    this.running = true;
    this.rafId = requestAnimationFrame(this.loop);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.rafId);
  }

  loop() {
    if (!this.running) return;
    const video = this.video;

    if (video.readyState >= 2 && video.currentTime !== this.lastVideoTime) {
      this.lastVideoTime = video.currentTime;
      const now = performance.now();
      try {
        const result = this.landmarker.detectForVideo(video, now);
        this.handleResult(result, now);
      } catch (error) {
        console.error('Hand detection failed on a frame:', error);
      }
    }

    this.rafId = requestAnimationFrame(this.loop);
  }

  handleResult(result, now) {
    const screenLandmarks = result.landmarks?.[0] ?? null;
    const worldLandmarks = result.worldLandmarks?.[0] ?? screenLandmarks;
    const handSeen = screenLandmarks !== null;
    const number = handSeen ? countFingers(worldLandmarks) : null;
    const analysis = handSeen ? analyzeHand(worldLandmarks) : null;

    this.history.push({ t: now, handSeen, number });
    while (this.history.length && now - this.history[0].t > HISTORY_KEEP_MS) {
      this.history.shift();
    }

    this.drawLandmarks(screenLandmarks);
    this.onFrame?.({ handSeen, number, analysis });
  }

  /**
   * Most common number shown in the last LOCK_WINDOW_MS.
   * null if the hand was seen in fewer than MIN_SEEN_FRACTION of frames, or if a fist won.
   */
  lockedNumber(now = performance.now()) {
    const recent = this.history.filter((reading) => now - reading.t <= LOCK_WINDOW_MS);
    if (recent.length === 0) return null;

    const seen = recent.filter((reading) => reading.handSeen);
    if (seen.length < recent.length * MIN_SEEN_FRACTION) return null;

    const tally = new Map();
    for (const { number } of seen) tally.set(number, (tally.get(number) ?? 0) + 1);

    let best = null;
    let bestCount = 0;
    for (const [number, count] of tally) {
      if (count > bestCount) {
        best = number;
        bestCount = count;
      }
    }
    return best; // may be null when a fist was the most common pose
  }

  drawLandmarks(landmarks) {
    const { canvas, ctx, video } = this;
    if (!ctx) return;
    if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
    }
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!landmarks) return;

    const radius = Math.max(3, canvas.width / 160);
    ctx.fillStyle = 'rgba(255, 214, 10, 0.95)';
    ctx.strokeStyle = '#111';
    ctx.lineWidth = 2;
    for (const point of landmarks) {
      ctx.beginPath();
      ctx.arc(point.x * canvas.width, point.y * canvas.height, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }
}
