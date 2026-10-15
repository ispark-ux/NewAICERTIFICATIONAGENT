import { refreshGeminiConfig, getGeminiConfig, getGeminiClient, describeGeminiError } from "@/lib/server/gemini";
import { db, dbInfo } from "@/lib/server/db";
import { guideAsText, offlineAnswer } from "@/lib/assistant-guide";
import { errorResponse, json, readJsonBody } from "@/lib/server/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function platformStatus() {
  try {
    const cfg = getGeminiConfig();
    const [procs, docs, scenarios, attempts, agents] = await Promise.all([
      db.listProcesses().catch(() => []),
      db.listDocs("kb_documents", { limit: 1000 }).catch(() => []),
      db.listDocs("scenarios", { limit: 1000 }).catch(() => []),
      db.listDocs("pkt_attempts", { limit: 1000 }).catch(() => []),
      db.listAgents().catch(() => []),
    ]);
    return {
      gemini_key: cfg.configured ? `configured (${cfg.keySource})` : "MISSING",
      storage: dbInfo().mode,
      processes: procs.map((p) => p.process_name).slice(0, 20),
      agents: agents.length,
      documents_approved: docs.filter((d) => d.status === "approved").length,
      documents_waiting_approval: docs.filter((d) => d.status === "draft").length,
      scenarios_published: scenarios.filter((s) => s.status === "approved").length,
      scenarios_to_review: scenarios.filter((s) => ["draft", "needs_review"].includes(s.status)).length,
      pkt_papers_to_approve: attempts.filter((a) => a.status === "review").length,
      pkt_ready: attempts.filter((a) => a.status === "ready").length,
    };
  } catch {
    return {};
  }
}

/** POST { messages: [{ role: "user"|"assistant", text }], path } */
export async function POST(request) {
  try {
    await refreshGeminiConfig();
    const body = await readJsonBody(request);
    const messages = (Array.isArray(body.messages) ? body.messages : []).filter((m) => m && typeof m.text === "string" && m.text.trim()).slice(-12);
    const last = messages.filter((m) => m.role === "user").pop()?.text || "";
    if (!last) return json({ answer: "Ask me anything about DialDesk - for example “How do I send a PKT link?”", offline: true });
    const cfg = getGeminiConfig();
    if (!cfg.configured) return json({ answer: `${offlineAnswer(last)}\n\n_(Offline guide - save a Gemini key in [AI / Gemini key](/admin/ai-settings) for smarter answers.)_`, offline: true });

    const status = await platformStatus();
    const system = `You are "Desk Assistant", the friendly in-app helper of the DialDesk AI Training & Certification platform (a contact-centre tool to train agents, run AI voice certifications and process knowledge tests).

HOW TO ANSWER
- Reply in the SAME language and script as the user (Hindi, Hinglish or English). Use very simple words.
- Be short: a one-line answer, then numbered steps (max 7). Bold the exact button names.
- Always link to the right page with Markdown links exactly like [Knowledge base](/admin/knowledge). Only use paths that appear in the guide.
- If something is not available in the platform, say so honestly and suggest the closest option. Never invent features or buttons.
- Use the live platform status to give specific advice (e.g. if the Gemini key is missing, tell them to add it first; if papers are waiting for approval, mention it).
- You may also answer general contact-centre training / quality questions briefly.

PLATFORM GUIDE
${guideAsText()}

LIVE PLATFORM STATUS
${JSON.stringify(status)}

The user is currently on page: ${String(body.path || "/admin").slice(0, 100)}`;

    try {
      const ai = getGeminiClient();
      const res = await ai.models.generateContent({
        model: cfg.generationModel,
        contents: messages.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.text.slice(0, 4000) }] })),
        config: { systemInstruction: system, temperature: 0.3, maxOutputTokens: 900 },
      });
      const answer = String(res.text || "").trim();
      return json({ answer: answer || offlineAnswer(last), offline: !answer });
    } catch (err) {
      return json({ answer: `${offlineAnswer(last)}\n\n_(AI unavailable: ${describeGeminiError(err)} - showing the built-in guide.)_`, offline: true });
    }
  } catch (err) {
    return errorResponse(err);
  }
}
