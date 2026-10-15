# DialDesk · AI Training & Certification

## What's new (UX release)

- **DialDesk branding** and a redesigned panel: grouped navigation (Overview · Assessments · Training content · People · Settings), friendly page headers, a **Home** dashboard with a welcome hero, setup progress ring and a step-by-step **Getting started** checklist that always shows the next step, plus status banners when something needs attention.
- **✨ Desk AI assistant** (bottom-right, `Ctrl+K`): ask in Hindi, Hinglish or English ("PKT ka link kaise bheju?"). It answers in simple numbered steps with clickable links to the right page, knows the live platform status (missing key, papers waiting for approval…), and falls back to a built-in offline guide when no Gemini key is available or the quota is exhausted.
- **AI / Gemini key from the panel** (`/admin/ai-settings`): paste a new key when the limit is reached → it is **tested with Gemini, stored encrypted (AES-256-GCM) in the database** and never returned to the browser (only a masked hint like `AIza••••••••abcd`; nothing in page source or devtools). Panel key overrides `GEMINI_API_KEY`; models can be overridden too. Every change is audited. Set `SETTINGS_SECRET` in production for the encryption key (falls back to the Supabase service key).
- **PKT for work-from-home agents**: every test has a **personal, secret link** (`/pkt/{id}/{token}`) - **Copy link / Email link / New link** (rotating revokes the old one) on the PKT list and attempt page. The link exposes only candidate actions; answer keys never leave the server. The agent's page waits automatically until the trainer approves the paper, and the score can be shown or hidden per test.
- **Live camera AI proctoring** (runs in the agent's browser with MediaPipe, self-hosted under `/public/mediapipe`, no frames leave the device): **face check before start** (one face, looking at the screen, no phone), then continuous detection of **no face, another person, looking away, looking down for long (phone in lap), and a mobile phone in view**. Each is debounced, logged with time and counted as a violation (auto-submit at the limit); phone / another person marks the attempt's integrity as *violation* and blocks certification. Gemini still reviews the full camera + screen recordings afterwards.


A reusable, client-specific **AI training, assessment and certification engine**:

```
Approved process documents (SOPs, manuals, FAQs, scripts, policies, escalation matrices)
        │  (one knowledge base per process, versioned, trainer-approved)
        ├──► AI Scenario Generator ──► Voice certification (Gemini Live AI customer, screen + audio evaluated)
        ├──► PKT Generator ─────────► Proctored knowledge test in the panel (camera + screen + AI integrity review)
        └──► Evaluator policy check
                     │
        Unified certification (mandatory assessments + critical failures) ──► coaching plan + fresh retest
                     │
        Trainer dashboard · Analytics · Audit trail
```

## Training & assessment engine (new)

| Area | What it does |
| --- | --- |
| **Knowledge base** (`/admin/knowledge`) | Upload PDF (text or scanned → Gemini OCR), DOCX, TXT/MD/CSV, images, or paste text. Files go up in 512 KB parts (Vercel-safe). Every document is versioned; a version must be **approved** before AI may use it, and approving a new version archives the old one. **AI analysis** extracts testable topics and flags **conflicts, ambiguities, gaps and outdated content** with citations. |
| **AI scenario generator** (`/admin/scenarios`) | Generates realistic customer scenarios (information, complaint, objection, exception, escalation, retention) with customer facts, hidden facts, opening line, a complete AI-customer prompt, expected resolution, evaluator notes, required probing, portal/CRM steps and escalation path - **all cited to the approved documents** (citations verified verbatim). Anything unclear is **flagged** (`needs_review`) and cannot be published until the trainer acknowledges it. Trainer edits / approves (publishes) / rejects. |
| **Fresh assessments** | Voice links pick a **published scenario the agent has not had yet** (least-used first) - automatically (`auto`), random, a specific one, or the process default. Recertification also gets a new scenario. The scenario snapshot is stored on the session; hidden facts never reach the agent's browser. |
| **PKT generator** (`/admin/pkt`) | Trainer configures tests: number of questions, topics (from the KB analysis), difficulty, types (MCQ, multiple-select, true/false, scenario-based), marks per type, duration, passing score, review rule, proctoring rules, mandatory flag. **Each test and retest gets a fresh paper** generated from the approved documents, excluding every question the agent has seen (+ recent ones) and near-duplicates; ambiguous questions are dropped and listed for the trainer; options are shuffled; answer key, explanation and verified source citation per question. Trainer reviews / removes questions / approves before start. |
| **PKT conducted in the panel - no link** | The test opens only from the admin panel (`/admin/pkt/take/{id}`), in person or as an online supervised session. **Camera + microphone and the entire screen are required and recorded**, fullscreen is enforced, copy/paste/right-click/devtools/print-screen are blocked, tab switches / focus loss / fullscreen exits are logged as violations (auto-submit at the configured limit), stopping the camera or screen share ends the test, timer is server-synced, answers autosave, watermark with agent name. After submission the recordings are uploaded (413-proof) and **Gemini reviews camera + screen** for another person, phone, notes, ChatGPT/AI tools, search engines, messaging → integrity verdict, score and timestamped flags. Trainers can invalidate an attempt (with reason). |
| **Automatic scoring** | Exact-match scoring, topic / type / difficulty breakdown, **knowledge gaps** (topics below the pass mark), per-question answer vs key with explanations and sources, full attempt history. |
| **Unified evaluation & certification** | Voice evaluation now also checks the agent's information against the approved knowledge base. Scorecard weights = parameter marks; ZTP parameters = critical failures. Per process: required assessments (voice, PKT) - certification = all required passed, no critical failure, no PKT integrity violation. Every decision is recorded (`certification.granted / revoked / evaluated`). |
| **Coaching** | On failure (or on demand) Gemini writes a targeted coaching plan from the failed voice parameters (with evidence), screen-check failures and PKT gaps / missed questions - with SOP sections to revise, actions, a practice drill and the recommended **fresh** next assessment. |
| **Trainer dashboard** (`/admin/trainer`) | Pending work (documents, KB issues, scenarios, papers), KPIs, every agent's voice + PKT + certification status with one-click **Assign PKT / Voice link (fresh scenario) / Coaching plan**, recurring voice failures, PKT topic gaps and portal/CRM failures. |
| **Audit trail** (`/admin/audit`) | Document uploads/approvals/versions, KB analyses, generated scenarios and question papers **with answer keys**, approvals, starts, scores, invalidations, AI proctoring reviews, voice evaluations, certification decisions, coaching plans - filter, search, CSV export. The trainer name entered in the sidebar is recorded as the actor. |

Optional env: `GENERATION_MODEL` (scenarios, PKT, coaching, KB analysis; defaults to `EVALUATION_MODEL`).

**Flow**

1. **Admin → Processes → Add process**: name, customer name, opening line, **AI prompt** (the AI customer talks to the agent using this), evaluator notes (correct resolution etc.), scorecard (pre-filled with the standard 17 parameters / 100 marks, editable).
2. **Admin → Agents**: add agents (name, email, employee ID) to a process → **Send link** → the certification link is emailed to the agent.
3. **Admin → Certifications**: or create an open link for any process and copy it.
4. **Agent** opens the link → START → shares screen + mic → the **Gemini Live AI customer speaks first** → real call, recorded → END.
5. Transcript + audio + screen recording are uploaded → **Gemini audits** the call against the rubric → server computes the score → scorecard shown on the link **and emailed** to the configured To/CC (and the agent).
6. **Admin → Email settings**: SMTP host/port/user/password, From, To, CC, test email.

## Analytics & recertification (Admin → Analytics)

| Tab | What it shows |
| --- | --- |
| **Certification analysis** | KPIs (links, completed, pass rate, average/median score, first-attempt vs recertification pass rate, ZTP breaches, avg call time), daily trend, score distribution, section-wise performance, weakest parameters, portal/CRM verification stats, full parameter table (C/NC/NA, NC rate, compliance, marks lost) - CSV export |
| **Process-wise** | Comparison table across processes (links, completed, pass rate, avg/min/max, certified agents, ZTP, top defect) + one card per process with section bars, top-5 defects, screen verdicts and trend - CSV export |
| **Agent-wise** | Every agent (incl. registered agents not started yet): status (Certified / Not certified / Failed (ZTP) / In progress / Link sent / Not started), attempts used vs. allowed, latest / best / first score, improvement, sparkline trend, focus areas from the latest attempt, attempt history, **Recertify** per agent and **Recertify all eligible** in one click - search, filters, sorting, CSV export |
| **Pareto** | 80/20 analysis with Pareto chart (bars + cumulative line + 80 % line), "vital few" vs "useful many", an action plan and table for: parameters by marks lost, parameters by defect count, sections by marks lost, portal/CRM checks by failures - CSV export |

Filters: process + period (7 / 30 / 90 / 365 days / all time). Supabase also gets SQL views `agent_certification_summary` and `parameter_results` for your own reporting (BI tools / SQL editor).

**Recertification**: each process has rules (enabled, max attempts per agent - default 3, cooldown hours). "Recertify" (certifications list, detail page, agent-wise tab) creates the next attempt for the same agent + process, linked to the first attempt (`attempt_no`, `recertification_of`), reuses an unused open link instead of creating duplicates, blocks while another attempt is in progress, and emails a "Recertification - attempt N" invite. Limits can be overridden by the admin (force).

## Run (PowerShell)

```powershell
npm install
Copy-Item .env.example .env     # set GEMINI_API_KEY (+ Supabase keys, see below)
npm run dev                     # http://localhost:3000  -> admin panel
# production: npm run build ; npm run start
```

Desktop Chrome/Edge over HTTPS or localhost (browser requirement for screen + mic capture).

## Supabase (recommended)

1. Supabase Dashboard → **SQL Editor** → paste **`supabase/schema.sql`** → Run (safe to re-run after every update - it only adds missing columns/views). It creates: `processes`, `agents`, `certification_sessions`, `certification_results`, `app_settings`, `email_logs`, the private storage bucket `recordings`, indexes, RLS and a `certification_overview` view.
2. Project Settings → API → copy the **Project URL** and the **service_role (secret) key**.
3. `.env`:
   ```
   SUPABASE_URL=https://xxxx.supabase.co
   SUPABASE_SERVICE_ROLE_KEY=eyJ...
   ```
4. Restart. The app now stores everything in Supabase (the SoTrue process is seeded automatically from `data/processes/sotrue.json` the first time the table is empty). Recordings are uploaded to the `recordings` bucket as `<SESSION_ID>/screen.webm` and `audio.webm` and played in the admin panel through signed URLs.

Without Supabase keys the app runs in **JSON-file mode** (`data/*.json`, `recordings/`) — same features, useful for local testing.

> Supabase free plan limits uploads to 50 MB per file; raise it under Project Settings → Storage if long screen recordings fail to upload (the score is still produced).

## Uploads & performance

- **No 413 errors - in any environment (Vercel included)**. A recording is never sent or stored as one request/object:
  1. **Direct**: the server returns one signed Supabase URL per **5 MB part** and the browser PUTs the parts straight to Supabase Storage (3 in parallel, retries). Nothing passes through Vercel, so its 4.5 MB request limit cannot apply. If storage itself answers 413 (bucket file-size limit), the upload is re-planned with half the part size, down to 64 KB.
  2. **Relay** (fallback / local mode): each part (1 MB, hard cap 4 MB) is POSTed to `/upload-part` and written directly as the final part object - **stateless**, no temp files, works across Vercel instances. A 413 from any proxy halves the part size automatically (down to 64 KB).
  3. `/upload-complete` verifies the stored byte count. Every playback response is ≤ 3 MB (HTTP ranges), so responses also stay under serverless limits.
  - On failure the agent can **Retry** or **Continue without screen video**.
- **Vercel needs Supabase**: Vercel's filesystem is read-only/ephemeral, so the JSON fallback cannot store anything there. Without `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` the app shows a red banner and refuses to create links with a clear message (instead of failing later).
- **Certification duration**: set per process (*Certification duration*, 1-120 min; optional *Minimum duration* - END is locked until then; *Warn before end*), and override per link (Certifications page / Agents page "Duration"). The agent sees elapsed / limit, time left and a progress bar, gets a "time almost up" alert, and the call **ends and submits automatically** at the limit. Gemini Live connections (recycled by Google about every 10 minutes) are **re-established automatically** in the background so long certifications continue seamlessly.
- **Light screen capture**: max 1920×1080, ~5 fps, VP8 @ 600 kbps (≈ 2–5 MB per minute, perfectly readable for the Gemini video analysis, low CPU so the live call stays responsive).
- **Half-duplex mic** (default on, per-process `live_settings.half_duplex`): while the AI customer is speaking, Gemini receives silence instead of the mic. This stops speaker→mic echo from making the AI interrupt itself and slow down over the call. The mixed conversation recording still contains the real mic audio. Turn-taking is tuned via `realtimeInputConfig` (end-of-speech sensitivity HIGH, 800 ms silence) - overridable per process (`end_of_speech_sensitivity`, `silence_duration_ms`, `prefix_padding_ms`).
- Hosting notes (Vercel): add `GEMINI_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (and optional `PUBLIC_BASE_URL`) as Environment Variables and redeploy. The evaluation route exports `maxDuration = 300` s for the background video analysis - keep Fluid Compute enabled (default) or use a plan that allows 300 s. Supabase free plan limits uploads to 50 MB per file - raise it under Project Settings → Storage for very long calls.

## Scorecard (default, editable per process)

| Section | Sub parameter | Marks |
| --- | --- | --- |
| Opening (7) | Standard Call Opening · Acknowledgement | 5 · 2 |
| Soft Skills (54) | Professionalism **ZTP** · Empathy/Apology/Assurance · ROS/Clarity/Accent · Enthusiasm · Active listening · Grammar · Accurate Probing | 5 · 5 · 10 · 12 · 6 · 10 · 6 |
| Hold Procedure (10) | Hold Procedure · Transfer · Dead Air | 4 · 3 · 3 |
| Tagging (11) | CRM Disposition · Case Escalation | 6 · 5 |
| Resolution (10) | Correct and Complete Information | 10 |
| Closing (8) | Further Assistance · Closing script | 4 · 4 |

- Gemini returns C / NC / NA + marks + reason + verbatim evidence per parameter (strict JSON schema).
- Server clamps marks, verifies evidence against the real transcript, computes section totals, excludes NA from the denominator, and applies **ZTP**: an NC on a zero-tolerance parameter sets the score to 0 and fails the call.
- **Screen recording is analysed by Gemini** (two-stage evaluation): the `screen.webm` is uploaded to the Gemini Files API and Gemini watches the full recording against a **verification checklist built from the process**: portal opened (e.g. Shopify) → the **exact scenario ID searched** (e.g. `order_id: ST12345` from the customer profile; a different ID = fail with the value actually seen) → matching record opened → status/ETA read from the screen → CRM record opened for this customer → disposition selected → remarks added → saved → escalation (if required) → only work apps used. Each check gets `pass / fail / partial / unclear / not_applicable` + timestamp + evidence + value seen, plus a **cross-check**: what the screen showed vs. what the agent told the customer (`consistent / inconsistent`). The scorecard stage uses that: `fail` → NC, `partial` → partial marks, `unclear` → NA; Accurate Probing / Correct Information are corroborated against the screen. The full "Portal & CRM verification" report (verdicts, values seen, timeline, concerns) is on the result page, admin detail, dashboard list and in the result email.
- Evaluation runs in the background (`POST /evaluate` returns 202); the agent page and admin page poll the session and show the stage (uploading video → Gemini processing → watching screen → scoring → emailing). Typical time 1–5 minutes depending on call length.
- Optional env: `SCREEN_ANALYSIS_MODEL` (e.g. `gemini-2.5-pro` for better small-text reading), `SCREEN_MEDIA_RESOLUTION=MEDIA_RESOLUTION_HIGH`. Per process: expected portal/CRM actions (one per line) and an on/off switch for screen analysis.

## Files

```
data/processes/sotrue.json                   default process (seeded into Supabase)
supabase/schema.sql                          run once in Supabase
src/app/admin/*                              admin panel (certifications, processes, agents, email settings)
src/app/certification/[sessionId]/page.jsx   agent page: START -> live AI call -> END -> score
src/lib/server/db/*                          data layer: supabase-repo.js / json-repo.js (same interface)
src/lib/server/gemini.js                     Live token (config locked server-side) + AI customer prompt
src/lib/server/screen-analysis.js            Gemini Files API upload + vision pass over the screen recording
src/lib/server/evaluation.js                 scorecard prompt (transcript + audio + screen report), scoring, groups, ZTP
src/lib/server/evaluation-job.js             background pipeline with persisted stages
src/lib/server/email.js                      SMTP (nodemailer) + invite / result / test templates
src/lib/live/*                               browser: Gemini Live WebSocket, audio engine, screen recorder
```

## API

| Method | Path |
| --- | --- |
| GET | `/api/health` |
| GET/POST | `/api/processes` (`?view=admin`), PUT/DELETE `/api/processes/{id}` |
| GET/POST | `/api/agents`, PUT/DELETE `/api/agents/{id}`, POST `/api/agents/{id}/invite` |
| GET | `/api/certifications`, `/api/certifications/{id}` |
| POST | `/api/certifications/create` `{ process_id, agent_id?, send_email? }` |
| POST | `/api/certifications/{id}/start` · `/transcript` · `/upload-url` · `/upload-part` · `/upload-complete` · `/upload-screen` · `/upload-audio` (legacy single request) · `/end` · `/evaluate` · `/resend-invite` · `/resend-result` |
| GET | `/api/certifications/{id}/result`, `/recording?type=screen|audio` |
| POST | `/api/live-token` `{ session_id }` |
| GET/PUT | `/api/settings/email`, POST `/api/settings/email/test` |
| GET | `/api/analytics?process_id=&from=&to=` (overview, sections, parameters, pareto, processes, agents) |
| POST | `/api/certifications/{id}/recertify` `{ send_email?, force? }` |
