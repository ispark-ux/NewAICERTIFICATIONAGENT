import crypto from "crypto";

/**
 * AES-256-GCM encryption for secrets stored in the database (Gemini API key).
 * The encryption key is derived from SETTINGS_SECRET (recommended) or, as a
 * fallback, the Supabase service-role key - so a database dump alone does not
 * reveal the API key. Secrets are never sent back to the browser.
 */
function masterKey() {
  const seed = process.env.SETTINGS_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || "dialdesk-local-settings-secret";
  return crypto.createHash("sha256").update(`dialdesk:${seed}`).digest();
}

export function encryptSecret(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", masterKey(), iv);
  const data = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  return `v1:${iv.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${data.toString("base64")}`;
}

export function decryptSecret(blob) {
  try {
    const [v, iv, tag, data] = String(blob || "").split(":");
    if (v !== "v1") return null;
    const decipher = crypto.createDecipheriv("aes-256-gcm", masterKey(), Buffer.from(iv, "base64"));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

export function maskKey(key) {
  const k = String(key || "");
  if (k.length < 10) return k ? "••••" : "";
  return `${k.slice(0, 4)}••••••••${k.slice(-4)}`;
}
