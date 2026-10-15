import { db } from "./db";
import { nowIso } from "./storage";

/**
 * Audit trail: every generated question set, answer key, scenario, document
 * version, evaluation result and certification decision is recorded here.
 */
export async function audit(action, { entity_type = null, entity_id = null, process_id = null, agent_key = null, actor = "system", summary = "", details = null } = {}) {
  const entry = {
    id: `AUD-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
    process_id,
    agent_key,
    status: action.split(".")[0] || "event",
    action,
    entity_type,
    entity_id,
    actor: actor || "system",
    summary: String(summary || "").slice(0, 500),
    details: details ?? null,
    created_at: nowIso(),
  };
  try {
    await db.saveDoc("audit_log", entry);
  } catch (err) {
    console.error(`[audit] failed to record ${action}:`, err.message);
  }
  return entry;
}

export async function listAudit({ process_id, limit = 500 } = {}) {
  return db.listDocs("audit_log", { process_id: process_id || undefined, limit });
}
