import { refreshGeminiConfig } from "@/lib/server/gemini";
import { getAttempt } from "@/lib/server/pkt";
import { errorResponse, json } from "@/lib/server/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET full attempt (trainer view: questions, answer key, sources, result, proctoring) */
export async function GET(request, context) {
  try {
    await refreshGeminiConfig();
    const { attemptId } = await context.params;
    return json({ attempt: await getAttempt(attemptId) });
  } catch (err) {
    return errorResponse(err);
  }
}
