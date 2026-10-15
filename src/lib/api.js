/** Thin fetch wrapper for the certification API. */
export class ApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.data = data;
  }
}

const HTTP_TEXT = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  408: "Request Timeout",
  409: "Conflict",
  413: "Payload Too Large",
  429: "Too Many Requests",
  500: "Internal Server Error",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
};

async function request(
  path,
  { method = "GET", body, headers = {}, rawBody = null, timeoutMs = 0 } = {}
) {
  const init = { method, headers: { ...headers } };
  if (typeof window !== "undefined") {
    try {
      const actor = window.localStorage.getItem("aac_actor");
      if (actor) init.headers["x-actor"] = encodeURIComponent(actor);
    } catch {
      /* storage unavailable */
    }
  }
  if (rawBody !== null) init.body = rawBody;
  else if (body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  let timer = null;
  if (timeoutMs > 0 && typeof AbortController !== "undefined") {
    const controller = new AbortController();
    init.signal = controller.signal;
    timer = setTimeout(() => controller.abort(), timeoutMs);
  }
  let res;
  try {
    res = await fetch(path, init);
  } catch (err) {
    if (timer) clearTimeout(timer);
    if (err && err.name === "AbortError")
      throw new ApiError(`Request to ${path} timed out`, 0, null);
    throw new ApiError(`Network error while calling ${path}: ${err.message}`, 0, null);
  }
  if (timer) clearTimeout(timer);
  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }
  if (!res.ok) {
    const fallback = `${res.status} ${res.statusText || HTTP_TEXT[res.status] || "Error"}`;
    throw new ApiError(
      (data && (data.error || data.message)) || fallback,
      res.status,
      data
    );
  }
  return data;
}

const enc = encodeURIComponent;

export const api = {
  health: () => request("/api/health"),

  // processes
  listProcesses: (admin = false) =>
    request(`/api/processes${admin ? "?view=admin" : ""}`),
  getProcess: (processId, admin = false) =>
    request(`/api/processes/${enc(processId)}${admin ? "?view=admin" : ""}`),
  createProcess: (payload) => request("/api/processes", { method: "POST", body: payload }),
  updateProcess: (processId, payload) =>
    request(`/api/processes/${enc(processId)}`, { method: "PUT", body: payload }),
  deleteProcess: (processId) =>
    request(`/api/processes/${enc(processId)}`, { method: "DELETE" }),

  // agents
  listAgents: (processId) =>
    request(`/api/agents${processId ? `?process_id=${enc(processId)}` : ""}`),
  createAgent: (payload) => request("/api/agents", { method: "POST", body: payload }),
  updateAgent: (agentId, payload) =>
    request(`/api/agents/${enc(agentId)}`, { method: "PUT", body: payload }),
  deleteAgent: (agentId) => request(`/api/agents/${enc(agentId)}`, { method: "DELETE" }),
  inviteAgent: (agentId, payload = {}) =>
    request(`/api/agents/${enc(agentId)}/invite`, {
      method: "POST",
      body: payload,
      timeoutMs: 60000,
    }),

  // certifications
  listCertifications: () => request("/api/certifications"),
  createCertification: (payload) =>
    request("/api/certifications/create", {
      method: "POST",
      body: payload,
      timeoutMs: 60000,
    }),
  getCertification: (sessionId) => request(`/api/certifications/${enc(sessionId)}`),
  startCertification: (sessionId, payload) =>
    request(`/api/certifications/${enc(sessionId)}/start`, {
      method: "POST",
      body: payload,
    }),
  recertify: (sessionId, payload = {}) =>
    request(`/api/certifications/${enc(sessionId)}/recertify`, {
      method: "POST",
      body: payload,
      timeoutMs: 60000,
    }),
  analytics: (params = {}) => {
    const q = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v)
    ).toString();
    return request(`/api/analytics${q ? `?${q}` : ""}`, { timeoutMs: 60000 });
  },
  resendInvite: (sessionId) =>
    request(`/api/certifications/${enc(sessionId)}/resend-invite`, {
      method: "POST",
      body: {},
      timeoutMs: 60000,
    }),
  resendResult: (sessionId) =>
    request(`/api/certifications/${enc(sessionId)}/resend-result`, {
      method: "POST",
      body: {},
      timeoutMs: 60000,
    }),

  // live flow
  getLiveToken: (sessionId) =>
    request("/api/live-token", {
      method: "POST",
      body: { session_id: sessionId },
      timeoutMs: 20000,
    }),
  saveTranscript: (sessionId, transcript, final = false) =>
    request(`/api/certifications/${enc(sessionId)}/transcript`, {
      method: "POST",
      body: { transcript, final },
    }),
  uploadRecording: (sessionId, kind, blob, meta = {}) =>
    request(
      `/api/certifications/${enc(sessionId)}/upload-${
        kind === "audio" ? "audio" : "screen"
      }`,
      {
        method: "POST",
        rawBody: blob,
        headers: {
          "Content-Type": blob.type || (kind === "audio" ? "audio/webm" : "video/webm"),
          "x-recording-started-at": meta.startedAt || "",
          "x-recording-ended-at": meta.endedAt || "",
          "x-recording-duration": String(meta.durationSeconds ?? ""),
        },
      }
    ),
  getAt: (path) => request(path, { timeoutMs: 30000 }),
  postAt: (path, payload = {}) =>
    request(path, { method: "POST", body: payload, timeoutMs: 120000 }),
  aiSettings: () => request("/api/settings/ai"),
  saveAiSettings: (payload) =>
    request("/api/settings/ai", { method: "PUT", body: payload, timeoutMs: 60000 }),
  removeAiKey: () => request("/api/settings/ai", { method: "DELETE" }),
  askAssistant: (payload) =>
    request("/api/assistant", { method: "POST", body: payload, timeoutMs: 90000 }),

  // generic upload endpoints
  uploadPlanAt: (base, payload) =>
    request(`${base}/upload-url`, { method: "POST", body: payload, timeoutMs: 30000 }),
  uploadPartAt: (base, params, blobSlice) =>
    request(`${base}/upload-part?kind=${enc(params.kind)}&index=${params.index}`, {
      method: "POST",
      rawBody: blobSlice,
      headers: { "Content-Type": "application/octet-stream" },
      timeoutMs: 120000,
    }),
  completeUploadAt: (base, payload) =>
    request(`${base}/upload-complete`, { method: "POST", body: payload, timeoutMs: 180000 }),

  // ---- knowledge base
  listKbDocuments: (processId) =>
    request(`/api/kb/documents?process_id=${enc(processId)}`),
  getKbDocument: (id) => request(`/api/kb/documents/${enc(id)}`),
  createKbDocument: (payload) =>
    request("/api/kb/documents", { method: "POST", body: payload, timeoutMs: 60000 }),
  uploadKbPart: (id, index, blob) =>
    request(`/api/kb/documents/${enc(id)}/part?index=${index}`, {
      method: "POST",
      rawBody: blob,
      headers: { "Content-Type": "application/octet-stream" },
      timeoutMs: 120000,
    }),
  completeKbDocument: (id, totalSize) =>
    request(`/api/kb/documents/${enc(id)}/complete`, {
      method: "POST",
      body: { total_size: totalSize },
      timeoutMs: 300000,
    }),
  kbDocumentAction: (id, action) =>
    request(`/api/kb/documents/${enc(id)}/${action}`, { method: "POST", body: {} }),
  deleteKbDocument: (id) =>
    request(`/api/kb/documents/${enc(id)}`, { method: "DELETE" }),
  getKbAnalysis: (processId) =>
    request(`/api/kb/analysis?process_id=${enc(processId)}`),
  analyzeKb: (processId) =>
    request("/api/kb/analysis", {
      method: "POST",
      body: { process_id: processId },
      timeoutMs: 300000,
    }),

  // ---- knowledge base issue remarks (NEW)
  saveIssueRemark: (processId, issueId, payload) =>
    request(`/api/kb/issues/${enc(issueId)}/remark`, {
      method: "PATCH",
      body: { process_id: processId, ...payload },
      timeoutMs: 30000,
    }),
  reanalyseIssue: (processId, issueId) =>
    request(`/api/kb/issues/${enc(issueId)}/reanalyse`, {
      method: "POST",
      body: { process_id: processId },
      timeoutMs: 300000,
    }),

  // ---- scenarios
  listScenarios: (processId, status) =>
    request(
      `/api/scenarios?process_id=${enc(processId || "")}${
        status ? `&status=${enc(status)}` : ""
      }`
    ),
  generateScenarios: (payload) =>
    request("/api/scenarios/generate", {
      method: "POST",
      body: payload,
      timeoutMs: 300000,
    }),
  getScenario: (id) => request(`/api/scenarios/${enc(id)}`),
  updateScenario: (id, payload) =>
    request(`/api/scenarios/${enc(id)}`, { method: "PUT", body: payload }),
  scenarioAction: (id, payload) =>
    request(`/api/scenarios/${enc(id)}`, { method: "POST", body: payload }),

  // ---- PKT
  listBlueprints: (processId) =>
    request(
      `/api/pkt/blueprints${processId ? `?process_id=${enc(processId)}` : ""}`
    ),
  createBlueprint: (payload) =>
    request("/api/pkt/blueprints", { method: "POST", body: payload }),
  updateBlueprint: (id, payload) =>
    request(`/api/pkt/blueprints/${enc(id)}`, { method: "PUT", body: payload }),
  listPktAttempts: (params = {}) =>
    request(
      `/api/pkt/attempts?${new URLSearchParams(
        Object.entries(params).filter(([, v]) => v)
      ).toString()}`
    ),
  createPktAttempt: (payload) =>
    request("/api/pkt/attempts", { method: "POST", body: payload, timeoutMs: 60000 }),
  getPktAttempt: (id) => request(`/api/pkt/attempts/${enc(id)}`),
  getPktPaper: (id) => request(`/api/pkt/attempts/${enc(id)}/paper`),
  pktAction: (id, action, payload = {}) =>
    request(`/api/pkt/attempts/${enc(id)}/${action}`, {
      method: "POST",
      body: payload,
      timeoutMs: 120000,
    }),
  pktRecordingUrl: (id, kind) => `/api/pkt/attempts/${enc(id)}/recording?type=${kind}`,

  // ---- trainer / coaching / audit
  trainerOverview: (processId) =>
    request(
      `/api/trainer/overview${processId ? `?process_id=${enc(processId)}` : ""}`,
      { timeoutMs: 60000 }
    ),
  listCoaching: (params = {}) =>
    request(
      `/api/coaching?${new URLSearchParams(
        Object.entries(params).filter(([, v]) => v)
      ).toString()}`
    ),
  createCoaching: (payload) =>
    request("/api/coaching", { method: "POST", body: payload, timeoutMs: 300000 }),
  listAudit: (params = {}) =>
    request(
      `/api/audit?${new URLSearchParams(
        Object.entries(params).filter(([, v]) => v)
      ).toString()}`
    ),

  getUploadPlan: (sessionId, payload) =>
    request(`/api/certifications/${enc(sessionId)}/upload-url`, {
      method: "POST",
      body: payload,
      timeoutMs: 30000,
    }),
  uploadPart: (sessionId, params, blobSlice) =>
    request(
      `/api/certifications/${enc(sessionId)}/upload-part?kind=${enc(params.kind)}&index=${
        params.index
      }`,
      {
        method: "POST",
        rawBody: blobSlice,
        headers: { "Content-Type": "application/octet-stream" },
        timeoutMs: 120000,
      }
    ),
  completeUpload: (sessionId, payload) =>
    request(`/api/certifications/${enc(sessionId)}/upload-complete`, {
      method: "POST",
      body: payload,
      timeoutMs: 180000,
    }),
  endCertification: (sessionId, payload) =>
    request(`/api/certifications/${enc(sessionId)}/end`, {
      method: "POST",
      body: payload,
    }),
  evaluate: (sessionId, force = false) =>
    request(`/api/certifications/${enc(sessionId)}/evaluate`, {
      method: "POST",
      body: { force },
      timeoutMs: 60000,
    }),
  getResult: (sessionId) => request(`/api/certifications/${enc(sessionId)}/result`),
  recordingUrl: (sessionId, kind = "screen") =>
    `/api/certifications/${enc(sessionId)}/recording?type=${kind}`,

  // settings
  getEmailSettings: () => request("/api/settings/email"),
  saveEmailSettings: (payload) =>
    request("/api/settings/email", { method: "PUT", body: payload }),
  testEmail: (to) =>
    request("/api/settings/email/test", {
      method: "POST",
      body: { to },
      timeoutMs: 60000,
    }),
};