/**
 * Live camera proctoring in the browser (MediaPipe Tasks Vision, runs locally -
 * no frames leave the device). Detects, with debouncing to avoid false alarms:
 *   face_not_visible  - nobody in front of the camera (> 4 s)
 *   multiple_faces    - another person in view (> 2 s)
 *   looking_away      - head turned away from the screen (> 5 s)
 *   looking_down      - eyes/head down for a long time, typical of reading a phone in the lap (> 6 s)
 *   phone_detected    - a mobile phone visible in the camera (2 consecutive detections)
 * Runtime + models are self-hosted under /mediapipe (CDN fallback).
 */

const LOCAL = { wasm: "/mediapipe/wasm", face: "/mediapipe/models/face_landmarker.task", objects: "/mediapipe/models/efficientdet_lite0.tflite" };
const REMOTE = {
  wasm: "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.1.0/wasm",
  face: "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
  objects: "https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/int8/1/efficientdet_lite0.tflite",
};

const RULES = {
  face_not_visible: { holdMs: 4000, label: "Face not visible - stay in front of the camera" },
  multiple_faces: { holdMs: 2000, label: "Another person detected in the camera" },
  looking_away: { holdMs: 5000, label: "Looking away from the screen" },
  looking_down: { holdMs: 6000, label: "Looking down for a long time (phone / notes?)" },
  phone_detected: { holdMs: 1500, label: "Mobile phone detected in the camera" },
};
const COOLDOWN_MS = 15000;

async function createTasks(paths, delegate) {
  const { FilesetResolver, FaceLandmarker, ObjectDetector } = await import("@mediapipe/tasks-vision");
  const fileset = await FilesetResolver.forVisionTasks(paths.wasm);
  const face = await FaceLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: paths.face, delegate },
    runningMode: "VIDEO",
    numFaces: 3,
    outputFaceBlendshapes: true,
    minFaceDetectionConfidence: 0.5,
    minFacePresenceConfidence: 0.5,
  });
  let objects = null;
  try {
    objects = await ObjectDetector.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: paths.objects, delegate },
      runningMode: "VIDEO",
      scoreThreshold: 0.42,
      maxResults: 5,
      categoryAllowlist: ["cell phone"],
    });
  } catch {
    objects = null; // face checks still work
  }
  return { face, objects };
}

export class ProctorVision {
  constructor({ onStatus, onViolation, onLog } = {}) {
    this.onStatus = onStatus || (() => {});
    this.onViolation = onViolation || (() => {});
    this.onLog = onLog || (() => {});
    this.state = {};
    this.lastFired = {};
    this.lastTs = 0;
    this.tick = 0;
    this.phoneHits = 0;
    this.running = false;
    this.status = { ready: false, loading: true, faces: 0, ok: false, issues: [], phone: false };
  }

  async start(stream) {
    this.video = document.createElement("video");
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.srcObject = stream;
    await this.video.play().catch(() => {});
    const attempts = [
      [LOCAL, "GPU"],
      [LOCAL, "CPU"],
      [REMOTE, "CPU"],
    ];
    let lastErr = null;
    for (const [paths, delegate] of attempts) {
      try {
        this.tasks = await createTasks(paths, delegate);
        this.onLog(`Camera AI ready (${delegate}${paths === REMOTE ? ", CDN" : ""}${this.tasks.objects ? ", phone detection on" : ", phone detection unavailable"})`);
        break;
      } catch (err) {
        lastErr = err;
      }
    }
    if (!this.tasks) {
      this.status = { ...this.status, loading: false, ready: false, error: `Camera AI could not start: ${lastErr?.message || "unknown error"}` };
      this.onStatus(this.status);
      return false;
    }
    this.running = true;
    this.timer = setInterval(() => this.loop(), 400);
    return true;
  }

  ts() {
    const now = performance.now();
    this.lastTs = Math.max(now, this.lastTs + 1);
    return this.lastTs;
  }

  hold(type, active, detail) {
    const now = Date.now();
    if (!active) {
      delete this.state[type];
      return false;
    }
    if (!this.state[type]) this.state[type] = now;
    if (now - this.state[type] >= RULES[type].holdMs && now - (this.lastFired[type] || 0) >= COOLDOWN_MS) {
      this.lastFired[type] = now;
      this.onViolation(type, detail || RULES[type].label);
    }
    return true;
  }

  loop() {
    if (!this.running || !this.video || this.video.readyState < 2) return;
    this.tick += 1;
    let faces = 0;
    let away = false;
    let down = false;
    let phone = false;
    try {
      const r = this.tasks.face.detectForVideo(this.video, this.ts());
      faces = r.faceLandmarks?.length || 0;
      if (faces === 1) {
        const lm = r.faceLandmarks[0];
        const nose = lm[1];
        const le = lm[263];
        const re = lm[33];
        const chin = lm[152];
        const eyeDist = Math.abs(le.x - re.x) || 0.001;
        const yaw = (nose.x - (le.x + re.x) / 2) / eyeDist;
        const eyeY = (le.y + re.y) / 2;
        const pitch = (nose.y - eyeY) / Math.max(0.001, chin.y - eyeY);
        const bs = Object.fromEntries((r.faceBlendshapes?.[0]?.categories || []).map((c) => [c.categoryName, c.score]));
        const eyesDown = ((bs.eyeLookDownLeft || 0) + (bs.eyeLookDownRight || 0)) / 2;
        const eyesSide = Math.max(((bs.eyeLookOutLeft || 0) + (bs.eyeLookInRight || 0)) / 2, ((bs.eyeLookInLeft || 0) + (bs.eyeLookOutRight || 0)) / 2);
        away = Math.abs(yaw) > 0.38 || eyesSide > 0.7;
        down = pitch > 0.66 || eyesDown > 0.62;
      }
      if (this.tasks.objects && this.tick % 3 === 0) {
        const o = this.tasks.objects.detectForVideo(this.video, this.ts());
        const hit = (o.detections || []).some((d) => d.categories?.some((c) => c.categoryName === "cell phone" && c.score >= 0.42));
        this.phoneHits = hit ? this.phoneHits + 1 : 0;
      }
      phone = this.phoneHits >= 2;
    } catch (err) {
      this.onLog(`Camera AI frame error: ${err.message}`);
      return;
    }
    const issues = [];
    if (this.hold("face_not_visible", faces === 0)) issues.push("No face");
    if (this.hold("multiple_faces", faces > 1, `${faces} faces in the camera`)) issues.push("Another person");
    if (this.hold("looking_away", faces === 1 && away)) issues.push("Looking away");
    if (this.hold("looking_down", faces === 1 && down && !away)) issues.push("Looking down");
    if (this.hold("phone_detected", phone)) issues.push("Phone");
    const next = { ready: true, loading: false, faces, ok: faces === 1 && !away && !down && !phone, issues, phone, away, down };
    const changed = ["faces", "ok", "phone", "away", "down"].some((k) => next[k] !== this.status[k]) || next.issues.join() !== (this.status.issues || []).join();
    this.status = next;
    if (changed) this.onStatus(next);
  }

  stop() {
    this.running = false;
    clearInterval(this.timer);
    try {
      this.tasks?.face?.close();
      this.tasks?.objects?.close();
    } catch {
      /* ignore */
    }
    if (this.video) this.video.srcObject = null;
  }
}

export const VISION_LABELS = Object.fromEntries(Object.entries(RULES).map(([k, v]) => [k, v.label]));
