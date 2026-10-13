import { db } from "./db";
import { createHmac } from "crypto";
const SID = process.env.TWILIO_ACCOUNT_SID, TOKEN = process.env.TWILIO_AUTH_TOKEN, FROM = process.env.TWILIO_FROM_NUMBER;
export const smsLive = !!(SID && TOKEN && FROM);

export function normPhone(p: string) {
  const d = (p || "").replace(/[^\d+]/g, "");
  if (d.startsWith("+")) return d;
  const digits = d.replace(/\D/g, "");
  if (digits.length === 10) return "+1" + digits;
  if (digits.length === 11 && digits.startsWith("1")) return "+" + digits;
  return digits ? "+" + digits : "";
}

/** Send an SMS. Dry-run (log only) when Twilio env vars are unset. */
export async function sendSms(to: string, body: string, opts: { clientId?: number | null; kind?: string } = {}) {
  to = normPhone(to);
  const ins = db.query("INSERT INTO messages(client_id,direction,phone,body,status,kind) VALUES(?,?,?,?,?,?) RETURNING id")
    .get(opts.clientId ?? null, "out", to, body, smsLive ? "sending" : "dry-run", opts.kind || "manual") as any;
  if (!smsLive) { console.log(`[sms dry-run] to ${to}: ${body}`); return { ok: true, dryRun: true, id: ins.id }; }
  try {
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${SID}/Messages.json`, {
      method: "POST",
      headers: { Authorization: "Basic " + btoa(`${SID}:${TOKEN}`), "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ To: to, From: FROM!, Body: body }),
    });
    const j: any = await r.json();
    if (!r.ok) throw new Error(j.message || r.statusText);
    db.run("UPDATE messages SET status=?, provider_sid=? WHERE id=?", [j.status || "queued", j.sid, ins.id]);
    return { ok: true, id: ins.id };
  } catch (e: any) {
    db.run("UPDATE messages SET status='failed', error=? WHERE id=?", [String(e.message || e), ins.id]);
    return { ok: false, error: String(e.message || e), id: ins.id };
  }
}

/** Validate X-Twilio-Signature (skipped if no auth token configured). */
export function validTwilioSignature(url: string, params: Record<string, string>, sig: string | null) {
  if (!TOKEN) return true;
  if (!sig) return false;
  const data = url + Object.keys(params).sort().map(k => k + params[k]).join("");
  return createHmac("sha1", TOKEN).update(data).digest("base64") === sig;
}
