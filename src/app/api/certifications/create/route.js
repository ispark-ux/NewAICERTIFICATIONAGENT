import { refreshGeminiConfig } from "@/lib/server/gemini";
import { createCertification } from "@/lib/server/certifications";
import { errorResponse, json, httpError, readJsonBody, publicBaseUrl, actorOf } from "@/lib/server/http";
import { assertPersistentStorage } from "@/lib/server/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** POST /api/certifications/create  { process_id, agent_id?, agent_name?, agent_email?, send_email? } */
export async function POST(request) {
  try {
    await refreshGeminiConfig();
    assertPersistentStorage();
    const body = await readJsonBody(request);
    if (!body.process_id) throw httpError("process_id is required", 400);
    const result = await createCertification({
      processId: body.process_id,
      agentId: body.agent_id || null,
      agentName: body.agent_name || "",
      agentEmail: body.agent_email || "",
      sendEmail: Boolean(body.send_email),
      durationMinutes: body.duration_minutes,
      scenarioMode: ["auto", "default", "random", "specific"].includes(body.scenario_mode) ? body.scenario_mode : "auto",
      scenarioId: body.scenario_id || null,
      actor: actorOf(request),
      baseUrl: publicBaseUrl(request),
    });
    return json({ session: result.session, certification_path: `/certification/${result.session.session_id}`, certification_url: result.url, email: result.email }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
