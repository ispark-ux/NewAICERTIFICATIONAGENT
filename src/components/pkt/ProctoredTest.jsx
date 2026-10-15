"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Alert, Button, Card, Modal, Spinner } from "@/components/ui";
import { api } from "@/lib/api";
import { requestScreenStream, describeMediaError, ScreenRecorder, stopStream, isSecureContextForMedia } from "@/lib/live/screen-recorder";
import { uploadRecordingResilient } from "@/lib/live/uploader";
import { formatDuration } from "@/lib/format";
import { ProctorVision } from "@/lib/live/proctor-vision";
import { BrandLogo } from "@/components/Brand";

/**
 * Proctored Process Knowledge Test - opened only from the admin panel (no public link).
 * Camera + entire screen are recorded, fullscreen is enforced and suspicious
 * browser events are logged; stopping camera/screen ends the test immediately.
 */

function pickCameraMime() {
  if (typeof MediaRecorder === "undefined") return "";
  return ["video/webm;codecs=vp8,opus", "video/webm;codecs=vp8", "video/webm"].find((m) => MediaRecorder.isTypeSupported(m)) || "";
}

class CameraRecorder {
  constructor(stream) {
    this.stream = stream;
    this.chunks = [];
    this.startedAt = null;
  }
  start() {
    const mimeType = pickCameraMime();
    this.recorder = new MediaRecorder(this.stream, { ...(mimeType ? { mimeType } : {}), videoBitsPerSecond: 250000, audioBitsPerSecond: 32000 });
    this.recorder.ondataavailable = (e) => e.data?.size && this.chunks.push(e.data);
    this.recorder.start(2000);
    this.startedAt = Date.now();
  }
  stop() {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve({ blob: new Blob(this.chunks, { type: this.recorder?.mimeType || "video/webm" }), durationSeconds: this.startedAt ? Math.round((Date.now() - this.startedAt) / 1000) : 0 });
      };
      if (!this.recorder || this.recorder.state === "inactive") return finish();
      this.recorder.onstop = finish;
      try {
        this.recorder.requestData();
        this.recorder.stop();
      } catch {
        finish();
      }
      setTimeout(finish, 4000);
    });
  }
}

function Video({ stream, className }) {
  const ref = useRef(null);
  useEffect(() => {
    if (ref.current && stream) {
      ref.current.srcObject = stream;
      ref.current.play().catch(() => {});
    }
  }, [stream]);
  return <video ref={ref} muted playsInline className={className} />;
}

function Shell({ name, children }) {
  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-indigo-50">
      <header className="flex items-center justify-between border-b border-slate-200 bg-white/80 px-6 py-3 backdrop-blur">
        <BrandLogo subtitle="Process Knowledge Test" />
        {name ? <span className="text-sm font-medium text-slate-600">{name}</span> : null}
      </header>
      {children}
    </div>
  );
}

export default function ProctoredTest({ attemptId, token = null }) {
  const isLink = Boolean(token);
  const base = token ? `/api/pkt/public/${encodeURIComponent(attemptId)}/${encodeURIComponent(token)}` : `/api/pkt/attempts/${encodeURIComponent(attemptId)}`;
  const [waiting, setWaiting] = useState(null);
  const [finished, setFinished] = useState(null);
  const [vision, setVision] = useState({ loading: false, ready: false, ok: false, issues: [] });
  const [faceOkSince, setFaceOkSince] = useState(null);
  const visionRef = useRef(null);
  const [phase, setPhase] = useState("loading"); // loading | precheck | test | submitting | done | error
  const [paper, setPaper] = useState(null);
  const [error, setError] = useState(null);
  const [camStream, setCamStream] = useState(null);
  const [scrStream, setScrStream] = useState(null);
  const [answers, setAnswers] = useState({});
  const [current, setCurrent] = useState(0);
  const [remaining, setRemaining] = useState(null);
  const [violations, setViolations] = useState(0);
  const [warning, setWarning] = useState(null);
  const [notFull, setNotFull] = useState(false);
  const [confirmSubmit, setConfirmSubmit] = useState(false);
  const [result, setResult] = useState(null);
  const [uploadState, setUploadState] = useState({});
  const [multiScreen, setMultiScreen] = useState(false);

  const phaseRef = useRef("loading");
  const paperRef = useRef(null);
  const answersRef = useRef({});
  const eventsRef = useRef([]);
  const offsetRef = useRef(0);
  const camRecRef = useRef(null);
  const scrRecRef = useRef(null);
  const camRef = useRef(null);
  const scrRef = useRef(null);
  const saveTimerRef = useRef(null);
  const submittingRef = useRef(false);
  const lastViolationRef = useRef(0);
  const recordingsRef = useRef(null);

  const setPhaseBoth = (p) => {
    phaseRef.current = p;
    setPhase(p);
  };

  // ---------------------------------------------------------------- load
  useEffect(() => {
    let timer = null;
    const loadPaper = async () => {
      try {
        const d = await api.getAt(`${base}/paper`);
        if (d.waiting) {
          setWaiting(d);
          setPhaseBoth("waiting");
          timer = setTimeout(loadPaper, 10000);
          return;
        }
        if (d.finished) {
          setFinished(d);
          setPhaseBoth("finished");
          return;
        }
        setWaiting(null);
        paperRef.current = d.paper;
        setPaper(d.paper);
        setAnswers(d.paper.answers || {});
        answersRef.current = d.paper.answers || {};
        offsetRef.current = new Date(d.paper.server_time).getTime() - Date.now();
        setMultiScreen(Boolean(typeof window !== "undefined" && window.screen && window.screen.isExtended));
        setPhaseBoth("precheck");
      } catch (err) {
        setError(err.message);
        setPhaseBoth("error");
      }
    };
    loadPaper();
    return () => clearTimeout(timer);
  }, [attemptId, base]);

  // ---------------------------------------------------------------- events
  const flushEvents = useCallback(async () => {
    if (!eventsRef.current.length) return;
    const batch = eventsRef.current.splice(0, eventsRef.current.length);
    try {
      const r = await api.postAt(`${base}/events`, { events: batch });
      if (typeof r.violations === "number") setViolations(r.violations);
      const max = paperRef.current?.proctoring?.max_violations || 5;
      if (r.violations >= max && phaseRef.current === "test") doSubmit("max_violations");
    } catch {
      eventsRef.current.unshift(...batch);
    }
  }, [attemptId]); // eslint-disable-line react-hooks/exhaustive-deps

  const logEvent = useCallback(
    (type, detail = "", violation = false) => {
      if (violation) {
        const now = Date.now();
        if (now - lastViolationRef.current < 1500) return; // one tab switch fires several events
        lastViolationRef.current = now;
        setWarning(`Proctoring alert: ${detail || type.replace(/_/g, " ")}. This is recorded and reported to your trainer.`);
      }
      eventsRef.current.push({ t: new Date().toISOString(), type, detail });
      if (violation) flushEvents();
    },
    [flushEvents]
  );

  useEffect(() => {
    if (phase !== "test") return undefined;
    const t = setInterval(flushEvents, 5000);
    return () => clearInterval(t);
  }, [phase, flushEvents]);

  // ---------------------------------------------------------------- pre-check
  const enableCamera = async () => {
    setError(null);
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 15, max: 15 } }, audio: true });
      camRef.current = s;
      setCamStream(s);
      if (paperRef.current?.proctoring?.live_ai !== false && !visionRef.current) startVision(s);
    } catch (err) {
      setError(describeMediaError(err, "camera").replace("Microphone", "Camera / microphone"));
    }
  };
  const startVision = async (stream) => {
    setVision({ loading: true, ready: false, ok: false, issues: [] });
    const v = new ProctorVision({
      onStatus: (st) => {
        setVision(st);
        setFaceOkSince((prev) => (st.ok ? prev || Date.now() : null));
      },
      onViolation: (type, detail) => {
        if (phaseRef.current === "test") logEvent(type, detail, true);
      },
      onLog: (m) => eventsRef.current.push({ t: new Date().toISOString(), type: "camera_ai", detail: m.slice(0, 200) }),
    });
    visionRef.current = v;
    const ok = await v.start(stream);
    if (!ok) setVision((x) => ({ ...x, loading: false }));
  };

  const enableScreen = async () => {
    setError(null);
    try {
      const s = await requestScreenStream();
      const settings = s.getVideoTracks()[0]?.getSettings?.() || {};
      if (settings.displaySurface && settings.displaySurface !== "monitor") {
        stopStream(s);
        setError("Please share your ENTIRE SCREEN (not a window or a tab) - choose “Entire screen” in the browser dialog.");
        return;
      }
      scrRef.current = s;
      setScrStream(s);
    } catch (err) {
      setError(describeMediaError(err, "screen"));
    }
  };

  const needCam = paper?.proctoring?.camera !== false;
  const needScr = paper?.proctoring?.screen !== false;
  const needFull = paper?.proctoring?.fullscreen !== false;
  const needVision = needCam && paper?.proctoring?.live_ai !== false;
  const [, forceTick] = useState(0);
  useEffect(() => {
    if (phase !== "precheck" || !faceOkSince) return undefined;
    const t = setInterval(() => forceTick((x) => x + 1), 500);
    return () => clearInterval(t);
  }, [phase, faceOkSince]);
  const faceVerified = !needVision || vision.error || (faceOkSince && Date.now() - faceOkSince > 2500);
  const ready = paper && (!needCam || camStream) && (!needScr || scrStream) && faceVerified;

  // ---------------------------------------------------------------- start
  const startTest = async () => {
    setError(null);
    try {
      if (needFull && document.documentElement.requestFullscreen) await document.documentElement.requestFullscreen().catch(() => {});
      const d = await api.postAt(`${base}/start`);
      paperRef.current = d.paper;
      setPaper(d.paper);
      offsetRef.current = new Date(d.paper.server_time).getTime() - Date.now();
      if (camRef.current) {
        camRecRef.current = new CameraRecorder(camRef.current);
        camRecRef.current.start();
        camRef.current.getVideoTracks()[0].onended = () => phaseRef.current === "test" && doSubmit("camera_stopped");
      }
      if (scrRef.current) {
        scrRecRef.current = new ScreenRecorder(scrRef.current, {});
        scrRecRef.current.start();
        scrRef.current.getVideoTracks()[0].onended = () => phaseRef.current === "test" && doSubmit("screen_stopped");
      }
      logEvent("test_started", `${d.paper.questions.length} questions${multiScreen ? " · multiple monitors detected" : ""}${isLink ? " · shared link" : " · admin panel"}${vision.error ? " · camera AI unavailable" : ""}`);
      if (multiScreen) logEvent("multiple_screens", "Extended display detected");
      setPhaseBoth("test");
    } catch (err) {
      setError(err.message);
    }
  };

  // ---------------------------------------------------------------- guards during the test
  useEffect(() => {
    if (phase !== "test") return undefined;
    const block = paperRef.current?.proctoring?.block_copy_paste !== false;
    const onVis = () => document.hidden && logEvent("tab_hidden", "Switched tab / minimised the window", true);
    const onBlur = () => !document.hidden && logEvent("window_blur", "Focus left the test window", true);
    const onFull = () => {
      const off = !document.fullscreenElement;
      setNotFull(off && needFull);
      if (off && needFull) logEvent("fullscreen_exit", "Exited fullscreen", true);
    };
    const onCopy = (e) => {
      if (!block) return;
      e.preventDefault();
      logEvent(e.type === "paste" ? "paste_attempt" : "copy_attempt", `${e.type} blocked`, true);
    };
    const onMenu = (e) => {
      if (!block) return;
      e.preventDefault();
      logEvent("context_menu", "Right-click blocked", true);
    };
    const onKey = (e) => {
      const k = e.key?.toLowerCase();
      if (k === "printscreen") return logEvent("print_screen", "Print Screen pressed", true);
      if (k === "f12" || ((e.ctrlKey || e.metaKey) && e.shiftKey && ["i", "j", "c"].includes(k)) || ((e.ctrlKey || e.metaKey) && k === "u")) {
        e.preventDefault();
        return logEvent("devtools_key", "Developer tools shortcut blocked", true);
      }
      if (block && (e.ctrlKey || e.metaKey) && ["c", "v", "x", "p", "s", "a"].includes(k)) {
        e.preventDefault();
        logEvent(k === "v" ? "paste_attempt" : "copy_attempt", `Ctrl+${k.toUpperCase()} blocked`, true);
      }
    };
    const onLeave = (e) => {
      e.preventDefault();
      e.returnValue = "";
    };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("blur", onBlur);
    document.addEventListener("fullscreenchange", onFull);
    document.addEventListener("copy", onCopy);
    document.addEventListener("cut", onCopy);
    document.addEventListener("paste", onCopy);
    document.addEventListener("contextmenu", onMenu);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("beforeunload", onLeave);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("fullscreenchange", onFull);
      document.removeEventListener("copy", onCopy);
      document.removeEventListener("cut", onCopy);
      document.removeEventListener("paste", onCopy);
      document.removeEventListener("contextmenu", onMenu);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("beforeunload", onLeave);
    };
  }, [phase, logEvent, needFull]);

  // timer
  useEffect(() => {
    if (phase !== "test" || !paper?.deadline_at) return undefined;
    const tick = () => {
      const left = Math.max(0, Math.round((new Date(paper.deadline_at).getTime() - (Date.now() + offsetRef.current)) / 1000));
      setRemaining(left);
      if (left <= 0) doSubmit("time_expired");
    };
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [phase, paper]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------------------------------------------------------- answers
  const choose = (q, optId) => {
    setAnswers((prev) => {
      const cur = prev[q.id] || [];
      const next = q.type === "multi" ? (cur.includes(optId) ? cur.filter((x) => x !== optId) : [...cur, optId].sort()) : [optId];
      const all = { ...prev, [q.id]: next };
      answersRef.current = all;
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => api.postAt(`${base}/answers`, { answers: answersRef.current }).catch(() => {}), 1200);
      return all;
    });
  };

  // ---------------------------------------------------------------- submit + upload
  const uploadRecordings = useCallback(async () => {
    const recs = recordingsRef.current || {};
    for (const [kind, rec] of Object.entries(recs)) {
      if (!rec?.blob?.size || uploadState[kind] === "done") continue;
      setUploadState((s) => ({ ...s, [kind]: "0%" }));
      try {
        await uploadRecordingResilient({ sessionId: attemptId, kind, blob: rec.blob, meta: { durationSeconds: rec.durationSeconds }, uploadBase: base, onProgress: (f) => setUploadState((s) => ({ ...s, [kind]: `${Math.round(f * 100)}%` })) });
        setUploadState((s) => ({ ...s, [kind]: "done" }));
      } catch (err) {
        setUploadState((s) => ({ ...s, [kind]: `failed: ${err.message}` }));
        return false;
      }
    }
    if (paperRef.current?.proctoring?.ai_review !== false) api.postAt(`${base}/proctoring-review`).catch(() => {});
    return true;
  }, [attemptId, uploadState]);

  const doSubmit = async (reason = "submitted") => {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setConfirmSubmit(false);
    setPhaseBoth("submitting");
    clearTimeout(saveTimerRef.current);
    if (reason !== "submitted") eventsRef.current.push({ t: new Date().toISOString(), type: reason, detail: "Test ended automatically" });
    await flushEvents();
    let res = null;
    try {
      const r = await api.postAt(`${base}/submit`, { answers: answersRef.current, reason });
      res = r.result;
    } catch (err) {
      setError(`Submit failed: ${err.message}`);
    }
    const [cam, scr] = await Promise.all([camRecRef.current?.stop() || null, scrRecRef.current?.stop("ended") || null]);
    visionRef.current?.stop();
    stopStream(camRef.current);
    stopStream(scrRef.current);
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    recordingsRef.current = { camera: cam, screen: scr };
    setResult({ ...res, reason });
    setPhaseBoth("done");
    await uploadRecordings();
  };

  // ---------------------------------------------------------------- render
  if (phase === "waiting") {
    return (
      <Shell name={paper?.agent?.name || waiting?.agent?.name}>
        <div className="mx-auto max-w-lg p-10 text-center">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-indigo-100 text-3xl">⏳</div>
          <h1 className="mt-4 text-xl font-bold text-slate-900">{waiting?.title || "Your test"}</h1>
          <p className="mt-2 text-sm text-slate-600">{waiting?.message}</p>
          <p className="mt-4 flex items-center justify-center gap-2 text-xs text-slate-400">
            <Spinner className="h-4 w-4" /> Checking every 10 seconds…
          </p>
        </div>
      </Shell>
    );
  }
  if (phase === "finished") {
    return (
      <Shell name={paper?.agent?.name || waiting?.agent?.name}>
        <div className="mx-auto max-w-lg p-10 text-center">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-emerald-100 text-3xl">✓</div>
          <h1 className="mt-4 text-xl font-bold text-slate-900">Test already submitted</h1>
          {finished?.result ? (
            <p className={`mt-3 text-4xl font-extrabold ${finished.result.passed ? "text-emerald-600" : "text-rose-600"}`}>
              {finished.result.percentage}% <span className="block text-sm font-semibold text-slate-600">{finished.result.passed ? "PASSED" : "NOT PASSED"} · pass mark {finished.result.passing_score}%</span>
            </p>
          ) : (
            <p className="mt-2 text-sm text-slate-600">Your trainer will share the result with you.</p>
          )}
        </div>
      </Shell>
    );
  }

  if (phase === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center gap-2 text-slate-500">
        <Spinner /> Loading test…
      </div>
    );
  }
  if (phase === "error") {
    return (
      <div className="mx-auto max-w-xl p-8">
        <Alert tone="error" title="This test cannot be opened">
          {error}
        </Alert>
        {!isLink ? (
          <Button className="mt-4" variant="secondary" href={`/admin/pkt/attempt/${attemptId}`}>
            Back to the attempt
          </Button>
        ) : null}
      </div>
    );
  }

  if (phase === "precheck") {
    const checks = [
      needCam ? { ok: Boolean(camStream), label: "Camera & microphone on" } : null,
      needVision ? { ok: Boolean(faceVerified && camStream), label: vision.error ? "Camera AI unavailable (recording still reviewed)" : "Face verified - alone, looking at the screen, no phone" } : null,
      needScr ? { ok: Boolean(scrStream), label: "Entire screen shared" } : null,
    ].filter(Boolean);
    return (
      <Shell name={paper?.agent?.name || waiting?.agent?.name}>
      <div className="mx-auto max-w-5xl space-y-5 p-6">
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-brand-700">Process Knowledge Test · proctored</p>
          <h1 className="text-2xl font-bold text-slate-900">{paper.title}</h1>
          <p className="text-sm text-slate-500">
            {paper.agent?.name} · attempt {paper.attempt_no} · {paper.questions.length} questions · {paper.duration_minutes} minutes · pass mark {paper.passing_score}%
          </p>
        </div>
        {!isSecureContextForMedia() ? <Alert tone="error">Camera and screen capture need HTTPS or localhost.</Alert> : null}
        {error ? <Alert tone="error">{error}</Alert> : null}
        {multiScreen ? <Alert tone="warning">Multiple monitors detected - disconnect extra screens. This is logged.</Alert> : null}
        <Card title="Exam rules">
          <ul className="list-disc space-y-1 pl-5 text-sm text-slate-700">
            {needCam ? <li>Your camera and microphone stay on and are recorded for the whole test. Stay alone and visible in front of the camera.</li> : null}
            {needVision ? <li>Live camera AI watches for: no face, another person, looking away or down for long, and a mobile phone. Each is recorded as a violation.</li> : null}
            {needScr ? <li>Your entire screen is shared and recorded. Using ChatGPT, search engines, notes, SOP files, chat apps or any other window is cheating.</li> : null}
            {needFull ? <li>The test runs in fullscreen. Leaving fullscreen, switching tabs or windows is recorded as a violation.</li> : null}
            <li>Copy, paste and right-click are blocked. After {paper.proctoring?.max_violations || 5} violations the test is submitted automatically.</li>
            <li className="font-semibold text-rose-700">Stopping the camera or the screen share ends the test immediately.</li>
            <li>The timer starts when you click Start and the test is submitted automatically when time is up. Answers are saved as you go.</li>
            <li>The recordings are reviewed by AI and by your trainer.</li>
          </ul>
        </Card>
        <div className="grid gap-4 md:grid-cols-2">
          {needCam ? (
            <Card title="1. Camera, microphone & face check">
              {camStream ? (
                <div className="relative">
                  <Video stream={camStream} className={`aspect-video w-full rounded-lg bg-black object-cover ring-4 ${!needVision || vision.ok ? "ring-emerald-400" : "ring-amber-400"}`} />
                  {needVision ? (
                    <div className={`absolute bottom-2 left-2 right-2 rounded-lg px-3 py-1.5 text-center text-xs font-semibold text-white ${vision.loading ? "bg-slate-800/80" : vision.error ? "bg-amber-600/90" : vision.ok ? "bg-emerald-600/90" : "bg-rose-600/90"}`}>
                      {vision.loading ? "Starting camera AI…" : vision.error ? "Camera AI unavailable" : vision.ok ? (faceVerified ? "Face verified ✓" : "Hold still…") : vision.faces === 0 ? "No face detected - sit in front of the camera" : vision.faces > 1 ? "Only you should be visible" : vision.phone ? "Put your phone away" : vision.away || vision.down ? "Look straight at the screen" : "Checking…"}
                    </div>
                  ) : null}
                </div>
              ) : (
                <div className="space-y-2">
                  <p className="text-sm text-slate-600">Sit alone in a well-lit room, face the camera and keep your phone away.</p>
                  <Button onClick={enableCamera}>Enable camera</Button>
                </div>
              )}
            </Card>
          ) : null}
          {needScr ? (
            <Card title="2. Share entire screen">
              {scrStream ? <Video stream={scrStream} className="aspect-video w-full rounded-lg bg-black object-contain" /> : <Button onClick={enableScreen}>Share entire screen</Button>}
              {scrStream ? <p className="mt-2 text-sm font-medium text-emerald-600">Screen shared ✓</p> : null}
            </Card>
          ) : null}
        </div>
        <Card>
          <div className="flex flex-wrap items-center gap-4">
            <ul className="flex-1 space-y-1">
              {checks.map((c) => (
                <li key={c.label} className={`flex items-center gap-2 text-sm ${c.ok ? "text-emerald-700" : "text-slate-500"}`}>
                  <span className={`flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-bold ${c.ok ? "bg-emerald-500 text-white" : "bg-slate-200 text-slate-500"}`}>{c.ok ? "✓" : "•"}</span>
                  {c.label}
                </li>
              ))}
            </ul>
            <Button size="xl" onClick={startTest} disabled={!ready}>
              {paper.status === "in_progress" ? "Resume test" : "Start test"}
            </Button>
            {!isLink ? (
              <Link href={`/admin/pkt/attempt/${attemptId}`} className="text-sm text-slate-500 hover:underline">
                Back
              </Link>
            ) : null}
          </div>
        </Card>
      </div>
      </Shell>
    );
  }

  if (phase === "submitting") {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 text-slate-600">
        <Spinner className="h-10 w-10 text-brand-600" />
        <p className="text-lg font-semibold">Submitting your answers…</p>
      </div>
    );
  }

  if (phase === "done") {
    const reasons = { time_expired: "Time was up - the test was submitted automatically.", max_violations: "Too many proctoring violations - the test was submitted automatically.", camera_stopped: "The camera was stopped - the test was ended.", screen_stopped: "Screen sharing was stopped - the test was ended." };
    const allUploaded = Object.entries(recordingsRef.current || {}).every(([k, r]) => !r?.blob?.size || uploadState[k] === "done");
    return (
      <div className="mx-auto max-w-2xl space-y-5 p-8">
        {result?.reason && reasons[result.reason] ? <Alert tone="warning">{reasons[result.reason]}</Alert> : null}
        {error ? <Alert tone="error">{error}</Alert> : null}
        {result?.hidden ? (
          <Card>
            <p className="text-center text-lg font-semibold text-slate-800">Test submitted ✓</p>
            <p className="text-center text-sm text-slate-500">Your trainer will share the result with you.</p>
          </Card>
        ) : null}
        {result?.percentage !== undefined ? (
          <Card>
            <div className="text-center">
              <p className="text-xs font-semibold uppercase tracking-widest text-slate-500">Process Knowledge Test submitted</p>
              <p className={`mt-2 text-5xl font-extrabold ${result.passed ? "text-emerald-600" : "text-rose-600"}`}>{result.percentage}%</p>
              <p className="text-sm font-semibold text-slate-700">
                {result.passed ? "PASSED" : "NOT PASSED"} · {result.correct}/{result.total} correct · pass mark {result.passing_score}%
              </p>
              {result.integrity?.status && result.integrity.status !== "clean" ? <p className="mt-1 text-xs text-amber-600">Integrity: {result.integrity.status} - {result.integrity.reasons?.join("; ")}</p> : null}
            </div>
          </Card>
        ) : null}
        <Card title="Proctoring recordings">
          {Object.entries(recordingsRef.current || {}).map(([k, r]) => (
            <p key={k} className="text-sm text-slate-700">
              {k === "camera" ? "Camera" : "Screen"}: {r?.blob?.size ? `${(r.blob.size / 1048576).toFixed(1)} MB · ${uploadState[k] === "done" ? "uploaded ✓" : uploadState[k] || "waiting"}` : "not recorded"}
            </p>
          ))}
          {!allUploaded && Object.values(uploadState).some((v) => String(v).startsWith("failed")) ? (
            <Button className="mt-3" size="sm" onClick={uploadRecordings}>
              Retry upload
            </Button>
          ) : null}
          <p className="mt-2 text-xs text-slate-500">Keep this page open until both recordings are uploaded.</p>
        </Card>
        {!isLink ? (
          <Button href={`/admin/pkt/attempt/${attemptId}`} disabled={!allUploaded}>
            Open detailed result (trainer)
          </Button>
        ) : (
          <p className="text-sm text-slate-600">{allUploaded ? "All done ✓ - you can close this page now. Your trainer will review the test." : "Please wait until the upload finishes before closing this page."}</p>
        )}
      </div>
    );
  }

  // ---------------------------------------------------------------- test
  const q = paper.questions[current];
  const answeredCount = paper.questions.filter((x) => answers[x.id]?.length).length;
  const low = remaining !== null && remaining <= 120;
  return (
    <div className="relative min-h-screen select-none bg-slate-50" onCopy={(e) => e.preventDefault()}>
      <div className="pointer-events-none fixed inset-0 z-0 flex flex-wrap content-start gap-24 overflow-hidden p-10 opacity-[0.05]">
        {Array.from({ length: 30 }).map((_, i) => (
          <span key={i} className="-rotate-12 text-xl font-bold text-slate-900">
            {paper.agent?.name} · {paper.id}
          </span>
        ))}
      </div>
      <header className="sticky top-0 z-20 flex flex-wrap items-center gap-4 bg-slate-900 px-6 py-3 text-white">
        <div>
          <p className="text-[11px] uppercase tracking-widest text-slate-400">Proctored PKT</p>
          <p className="font-semibold">{paper.title}</p>
        </div>
        <div className="ml-auto flex items-center gap-5">
          <span className="text-sm text-slate-300">
            {answeredCount}/{paper.questions.length} answered
          </span>
          <span className={`text-sm font-semibold ${violations ? "text-amber-300" : "text-slate-300"}`}>
            Violations {violations}/{paper.proctoring?.max_violations || 5}
          </span>
          <span className="flex items-center gap-1.5 text-xs text-rose-300">
            <span className="live-dot h-2 w-2 rounded-full bg-rose-500" /> Recording
          </span>
          <span className={`mono rounded-lg px-3 py-1 text-xl font-bold ${low ? "bg-rose-600" : "bg-white/10"}`}>{remaining !== null ? formatDuration(remaining) : "--:--"}</span>
          <Button variant="danger" size="sm" onClick={() => setConfirmSubmit(true)}>
            Submit test
          </Button>
        </div>
      </header>

      {warning ? (
        <div className="relative z-10 mx-auto mt-3 max-w-4xl px-6">
          <Alert tone="warning">
            {warning}{" "}
            <button type="button" className="ml-2 underline" onClick={() => setWarning(null)}>
              dismiss
            </button>
          </Alert>
        </div>
      ) : null}

      <main className="relative z-10 mx-auto grid max-w-6xl gap-6 p-6 lg:grid-cols-4">
        <aside className="order-2 lg:order-1">
          <Card title="Questions">
            <div className="grid grid-cols-6 gap-1.5 lg:grid-cols-5">
              {paper.questions.map((x, i) => (
                <button key={x.id} type="button" onClick={() => setCurrent(i)} className={`h-9 rounded-lg text-xs font-semibold ${i === current ? "bg-brand-600 text-white" : answers[x.id]?.length ? "bg-emerald-100 text-emerald-800" : "bg-slate-100 text-slate-600"}`}>
                  {i + 1}
                </button>
              ))}
            </div>
          </Card>
          {camStream ? (
            <div className="mt-4">
              <Video stream={camStream} className="aspect-video w-full rounded-xl bg-black object-cover ring-2 ring-rose-500" />
              <p className={`mt-1 text-center text-[11px] font-semibold ${!needVision || vision.error ? "text-slate-500" : vision.ok ? "text-emerald-600" : "text-rose-600"}`}>
                {!needVision || vision.error ? "Camera is recording" : vision.ok ? "Camera AI: all good ✓" : `Camera AI: ${vision.issues?.join(", ") || (vision.faces === 0 ? "no face" : vision.faces > 1 ? "another person" : vision.phone ? "phone" : "look at the screen")}`}
              </p>
            </div>
          ) : null}
        </aside>
        <section className="order-1 lg:order-2 lg:col-span-3">
          <Card>
            <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-slate-500">
              <span className="font-semibold text-slate-700">
                Question {current + 1} of {paper.questions.length}
              </span>
              <span>· {q.topic}</span>
              <span>· {q.marks} mark{q.marks > 1 ? "s" : ""}</span>
              <span className="rounded bg-slate-100 px-1.5 py-0.5">{q.type === "multi" ? "Select all that apply" : q.type === "tf" ? "True / False" : q.type === "scenario" ? "Scenario" : "Choose one"}</span>
            </div>
            <p className="whitespace-pre-wrap text-lg font-medium leading-relaxed text-slate-900">{q.stem}</p>
            <div className="mt-5 space-y-2">
              {q.options.map((o) => {
                const on = (answers[q.id] || []).includes(o.id);
                return (
                  <button key={o.id} type="button" onClick={() => choose(q, o.id)} className={`flex w-full items-start gap-3 rounded-xl border px-4 py-3 text-left transition ${on ? "border-brand-500 bg-brand-50 ring-2 ring-brand-200" : "border-slate-200 bg-white hover:border-brand-300"}`}>
                    <span className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center ${q.type === "multi" ? "rounded-md" : "rounded-full"} border text-xs font-bold ${on ? "border-brand-600 bg-brand-600 text-white" : "border-slate-300 text-slate-500"}`}>{on && q.type === "multi" ? "✓" : o.id}</span>
                    <span className="text-slate-800">{o.text}</span>
                  </button>
                );
              })}
            </div>
            <div className="mt-6 flex justify-between">
              <Button variant="secondary" onClick={() => setCurrent((c) => Math.max(0, c - 1))} disabled={current === 0}>
                ← Previous
              </Button>
              {current < paper.questions.length - 1 ? (
                <Button onClick={() => setCurrent((c) => Math.min(paper.questions.length - 1, c + 1))}>Next →</Button>
              ) : (
                <Button variant="danger" onClick={() => setConfirmSubmit(true)}>
                  Finish & submit
                </Button>
              )}
            </div>
          </Card>
        </section>
      </main>

      {notFull ? (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/95 p-6 text-center text-white">
          <div className="max-w-md space-y-4">
            <p className="text-xl font-bold">Return to fullscreen to continue</p>
            <p className="text-sm text-slate-300">Leaving fullscreen was recorded as a proctoring violation. The timer keeps running.</p>
            <Button size="lg" onClick={() => document.documentElement.requestFullscreen?.().catch(() => {})}>
              Back to fullscreen
            </Button>
          </div>
        </div>
      ) : null}

      <Modal
        open={confirmSubmit}
        title="Submit the test?"
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmSubmit(false)}>
              Continue test
            </Button>
            <Button variant="danger" onClick={() => doSubmit("submitted")}>
              Submit now
            </Button>
          </>
        }
      >
        {answeredCount < paper.questions.length ? <p className="font-semibold text-amber-700">{paper.questions.length - answeredCount} question(s) are not answered.</p> : <p>All questions are answered.</p>}
        <p className="mt-1">You cannot change your answers after submitting.</p>
      </Modal>
    </div>
  );
}
