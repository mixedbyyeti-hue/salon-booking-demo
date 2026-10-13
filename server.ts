import { db } from "./db";
import { sendSms, normPhone, validTwilioSignature, smsLive } from "./sms";
import { readFileSync } from "fs";
import { createHmac } from "crypto";

const DIR = import.meta.dir;
const PORT = Number(process.env.PORT || 3456);
const HOST = "0.0.0.0";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "demo-pass-2026";
const ADMIN_PASSWORD_IS_DEFAULT = !process.env.ADMIN_PASSWORD;
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
const cfg = () => JSON.parse(readFileSync(DIR + "/config/business.json", "utf8"));
const faq = () => JSON.parse(readFileSync(DIR + "/config/faq.json", "utf8"));
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

// ---------- time helpers (all times are business-local "YYYY-MM-DDTHH:MM"; run with TZ set) ----------
const pad = (n: number) => String(n).padStart(2, "0");
const fmtLocal = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
const parseLocal = (s: string) => new Date(s.length === 16 ? s + ":00" : s);
const addMin = (s: string, m: number) => fmtLocal(new Date(parseLocal(s).getTime() + m * 60000));
const nice = (s: string) => parseLocal(s).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const esc = (s: any) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const priceStr = (s: any) => s.priceTo === 0 && s.priceFrom === 0 ? "Free" : s.priceFrom === s.priceTo ? `$${s.priceFrom}` : s.priceFrom === 0 ? `up to $${s.priceTo}` : `$${s.priceFrom}–$${s.priceTo}`;
const hoursStr = (c: any) => DAYS.map(d => { const r = c.workingHours[d]; return r?.length ? `${d[0].toUpperCase() + d.slice(1)} ${r.map((x: any) => x.join("-")).join(", ")}` : null; }).filter(Boolean).join("; ");

function overlapping(start: string, end: string, excludeId = 0) {
  const buf = cfg().bufferMinutes || 0;
  return db.query(`SELECT id FROM appointments WHERE status IN ('booked','confirmed') AND id != ? AND start < ? AND end > ?`)
    .all(excludeId, addMin(end, buf), addMin(start, -buf)).length > 0;
}

export function slotsFor(date: string, duration: number, excludeId = 0) {
  const c = cfg();
  if (c.closedDates?.includes(date)) return [];
  const day = DAYS[parseLocal(date + "T12:00").getDay()];
  const minStart = Date.now() + (c.minNoticeHours || 0) * 3600000;
  const out: string[] = [];
  for (const [o, cl] of c.workingHours[day] || []) {
    let t = `${date}T${o}`; const close = `${date}T${cl}`;
    while (addMin(t, duration) <= close) {
      if (parseLocal(t).getTime() >= minStart && !overlapping(t, addMin(t, duration), excludeId)) out.push(t.slice(11));
      t = addMin(t, c.slotIntervalMinutes || 15);
    }
  }
  return out;
}

function upsertClient(name: string, phone: string, email: string) {
  const p = normPhone(phone);
  const ex = db.query("SELECT * FROM clients WHERE phone=?").get(p) as any;
  if (ex) { db.run("UPDATE clients SET name=COALESCE(NULLIF(?,''),name), email=COALESCE(NULLIF(?,''),email) WHERE id=?", [name, email, ex.id]); return ex.id; }
  return (db.query("INSERT INTO clients(name,phone,email) VALUES(?,?,?) RETURNING id").get(name, p, email) as any).id;
}

// Atomic booking: BEGIN IMMEDIATE takes the write lock so concurrent requests can't both pass the overlap check.
const bookTx = db.transaction((a: any) => {
  if (overlapping(a.start, a.end)) throw new Error("SLOT_TAKEN");
  const cid = upsertClient(a.name, a.phone, a.email);
  return (db.query(`INSERT INTO appointments(client_id,service_id,service_name,price,start,end,client_notes) VALUES(?,?,?,?,?,?,?) RETURNING id`)
    .get(cid, a.service.id, a.service.name, a.service.priceFrom, a.start, a.end, a.notes || "") as any).id;
});

function tmpl(s: string) {
  const c = cfg(), p = c.policies || {};
  const vars: any = { bookingLink: PUBLIC_BASE_URL + "/", address: c.address, hours: hoursStr(c), businessName: c.businessName, stylistName: c.stylistName, phone: c.phoneDisplay || "",
    prices: c.services.slice(0, 6).map((s: any) => `${s.name} ${priceStr(s)}`).join(", ") + " (full menu at link)",
    cancellationPolicy: p.cancellation || "", depositPolicy: p.deposit || "", latePolicy: p.late || "" };
  return s.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? `{${k}}`);
}
export function draftReply(body: string) {
  const f = faq(), b = body.toLowerCase();
  const named = cfg().services.filter((s: any) => b.includes(s.id.split("-")[0]) || b.includes(s.name.toLowerCase().split(/[ \/–(]/)[0]));
  for (const r of f.rules) if (r.keywords.some((k: string) => b.includes(k.toLowerCase()))) {
    let t = tmpl(r.reply);
    if (r.id === "prices" && named.length) t = named.map((s: any) => `${s.name}: ${priceStr(s)} (${s.durationMinutes} min)`).join("; ") + `. Final price depends on length/density. Book here: ${PUBLIC_BASE_URL}/`; if (r.booking && !t.includes(PUBLIC_BASE_URL)) t += ` Book: ${PUBLIC_BASE_URL}/`;
    return { text: t, rule: r.id };
  }
  return { text: tmpl(f.fallback), rule: "fallback" };
}

// ---------- notifications ----------
async function sendConfirmation(id: number) {
  const a = db.query("SELECT a.*, c.phone, c.name FROM appointments a JOIN clients c ON c.id=a.client_id WHERE a.id=?").get(id) as any;
  if (!a || a.confirmation_sent) return;
  const c = cfg();
  await sendSms(a.phone, `Hi ${a.name.split(" ")[0]}! You're booked with ${c.businessName}: ${a.service_name}, ${nice(a.start)}. ${c.address}. Need to change it? Reply here. ${c.policies?.cancellation || ""}`.trim(), { clientId: a.client_id, kind: "confirmation" });
  db.run("UPDATE appointments SET confirmation_sent=1 WHERE id=?", [id]);
}
async function schedulerTick() {
  const now = fmtLocal(new Date()), in24 = fmtLocal(new Date(Date.now() + 24 * 3600000));
  for (const a of db.query("SELECT id FROM appointments WHERE status IN ('booked','confirmed') AND confirmation_sent=0 AND start > ?").all(now) as any[]) await sendConfirmation(a.id);
  const due = db.query(`SELECT a.*, c.phone, c.name FROM appointments a JOIN clients c ON c.id=a.client_id
    WHERE a.status IN ('booked','confirmed') AND a.reminder_sent=0 AND a.start > ? AND a.start <= ?`).all(now, in24) as any[];
  for (const a of due) {
    db.run("UPDATE appointments SET reminder_sent=1 WHERE id=?", [a.id]);
    await sendSms(a.phone, `Reminder: ${a.service_name} with ${cfg().businessName} ${nice(a.start)}. Reply to this text if you need to reschedule.`, { clientId: a.client_id, kind: "reminder" });
  }
}
function seedDemoIfEmpty() {
  const n = (db.query(`SELECT
    (SELECT COUNT(*) FROM clients) +
    (SELECT COUNT(*) FROM appointments) +
    (SELECT COUNT(*) FROM messages) AS n`).get() as { n: number }).n;
  if (n > 0) return;

  const at = (offsetDays: number, hhmm: string) => {
    const d = new Date();
    d.setDate(d.getDate() + offsetDays);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${hhmm}`;
  };

  const priceAsk = "How much is a balayage? This is a fake demo text.";
  const bookAsk = "Can I book a trim next week? Fake demo message only.";
  const priceDraft = draftReply(priceAsk);
  const bookDraft = draftReply(bookAsk);

  db.transaction(() => {
    const client = db.query("INSERT INTO clients(name,phone,email,notes) VALUES(?,?,?,?) RETURNING id");
    const maya = (client.get("Maya Chen", "+15555550101", "maya.chen@example.com", "DEMO ONLY — fictional client. Fine hair; likes a soft, grown-out balayage.") as any).id;
    const jordan = (client.get("Jordan Blake", "+15555550102", "jordan.blake@example.com", "DEMO ONLY — fictional client. Sensitive scalp; skip strong fragrance.") as any).id;
    const avery = (client.get("Avery Cole", "+15555550103", "avery.cole@example.com", "DEMO ONLY — fictional client. Growing out curtain bangs.") as any).id;

    const appt = db.query(`INSERT INTO appointments(client_id,service_id,service_name,price,start,end,status,client_notes,confirmation_sent,reminder_sent)
      VALUES(?,?,?,?,?,?,?,?,1,1) RETURNING id`);
    const past = at(-14, "11:00");
    const pastId = (appt.get(maya, "balayage", "Balayage", 275, past, addMin(past, 180), "completed", "Demo note: wanted something low-maintenance.") as any).id;
    db.run("INSERT INTO visits(client_id,appointment_id,date,service_name,price,notes) VALUES(?,?,?,?,?,?)",
      [maya, pastId, past.slice(0, 10), "Balayage", 275, "Demo visit — toner 9NB."]);

    const today = at(0, "14:00");
    appt.run(jordan, "blowout", "Blowout", 65, today, addMin(today, 45), "confirmed", "Demo note: event tonight, smooth finish.");
    const soon = at(2, "11:00");
    appt.run(avery, "cut-short", "Haircut – short/standard", 80, soon, addMin(soon, 45), "booked", "Demo note: keep the length, just shape.");
    const later = at(5, "13:00");
    appt.run(maya, "gloss", "Gloss / toner", 85, later, addMin(later, 45), "booked", "Demo note: refresh the tone from the last visit.");

    const msg = db.query(`INSERT INTO messages(client_id,direction,phone,body,status,kind,draft_reply,draft_rule,handled)
      VALUES(?,?,?,?,?,?,?,?,?)`);
    msg.run(jordan, "in", "+15555550102", priceAsk, "received", "inbound", priceDraft.text, priceDraft.rule, 0);
    msg.run(avery, "in", "+15555550103", bookAsk, "received", "inbound", bookDraft.text, bookDraft.rule, 1);
    msg.run(maya, "out", "+15555550101", `Hi Maya! You're booked with ${cfg().businessName}: Balayage (demo confirmation, not sent).`, "dry-run", "confirmation", null, null, 1);
  })();
  console.log("Seeded fictional demo clients, appointments, and messages.");
}

seedDemoIfEmpty();
setInterval(() => schedulerTick().catch(console.error), 60000);

// ---------- auth ----------
const sessionToken = () => createHmac("sha256", ADMIN_PASSWORD + ":salon").update("admin").digest("hex");
const authed = (req: Request) => !!ADMIN_PASSWORD && (req.headers.get("cookie") || "").split(/;\s*/).includes("sess=" + sessionToken());

// ---------- HTML ----------
const CSS = readFileSync(DIR + "/public/style.css", "utf8");
const page = (title: string, body: string, admin = false) => new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><link rel="preconnect" href="https://fonts.googleapis.com"><style>${CSS}</style></head><body class="${admin ? "admin" : "public"}">
<div class="sample-banner">Demo build — services, prices, hours and policies shown are <b>sample content</b>, not real business details.</div>${body}</body></html>`, { headers: { "content-type": "text/html; charset=utf-8" } });
const redirect = (to: string, headers: any = {}) => new Response(null, { status: 303, headers: { location: to, ...headers } });

function bookingPage() {
  const c = cfg();
  const cats: Record<string, any[]> = {};
  for (const s of c.services) (cats[s.category || "Services"] ||= []).push(s);
  const menu = Object.entries(cats).map(([cat, list]) => `<h3 class="cat">${esc(cat)}</h3>` + list.map(s => `
    <label class="svc"><input type="radio" name="service" value="${esc(s.id)}" data-dur="${s.durationMinutes}" required>
    <div class="svc-body"><div class="svc-top"><span class="svc-name">${esc(s.name)}</span><span class="price">${priceStr(s)}</span></div>
    <div class="svc-meta">${s.durationMinutes} min${s.depositRequired ? ` · $${s.depositRequired} deposit` : ""}${s.sample ? ' · <span class="tag">sample</span>' : ""}</div>
    <div class="svc-desc">${esc(s.description || "")}</div></div></label>`).join("")).join("");
  const pol = c.policies || {};
  return page(c.businessName + " – Book", `
<header class="hero"><div class="wrap"><p class="eyebrow">Online booking</p><h1>${esc(c.businessName)}</h1><p class="sub">${esc(c.address)} · ${esc(hoursStr(c))}</p></div></header>
<main class="wrap grid">
<form id="bk" class="card">
<section><h2><span class="step">1</span> Choose a service</h2>${menu}</section>
<section><h2><span class="step">2</span> Pick a time</h2>
<input type="date" id="date" name="date" required><div id="slots" class="slots"><p class="muted">Select a service and date.</p></div><input type="hidden" name="time" id="time"></section>
<section><h2><span class="step">3</span> Your details</h2>
<div class="row"><input name="name" placeholder="Full name" required autocomplete="name"><input name="phone" type="tel" placeholder="Mobile phone" required autocomplete="tel"></div>
<input name="email" type="email" placeholder="Email" required autocomplete="email"><textarea name="notes" rows="3" placeholder="Notes (hair history, inspiration, questions)"></textarea>
<button class="btn primary" type="submit">Book appointment</button><p id="msg" role="status"></p></section>
</form>
<aside class="card policies"><h2>Policies <span class="tag">sample</span></h2>${Object.entries(pol).filter(([k]) => !k.startsWith("_")).map(([k, v]) => `<h4>${esc(k[0].toUpperCase() + k.slice(1))}</h4><p>${esc(v)}</p>`).join("")}
<p class="muted small">Questions? Text ${esc(c.phoneDisplay || "the studio")}.</p></aside>
</main>
<script>
const f=document.getElementById('bk'),d=document.getElementById('date'),sl=document.getElementById('slots'),tm=document.getElementById('time'),msg=document.getElementById('msg');
d.min=new Date().toISOString().slice(0,10);
async function load(){const s=f.querySelector('input[name=service]:checked');if(!s||!d.value)return;tm.value='';
 sl.innerHTML='<p class="muted">Loading…</p>';const r=await fetch('/api/slots?service='+s.value+'&date='+d.value).then(r=>r.json());
 sl.innerHTML=r.slots.length?r.slots.map(t=>'<button type="button" class="slot" data-t="'+t+'">'+new Date('2000-01-01T'+t).toLocaleTimeString([], {hour:'numeric',minute:'2-digit'})+'</button>').join(''):'<p class="muted">No openings this day — try another date.</p>';}
f.addEventListener('change',e=>{if(e.target.name==='service'||e.target===d)load();});
sl.addEventListener('click',e=>{const b=e.target.closest('.slot');if(!b)return;sl.querySelectorAll('.slot').forEach(x=>x.classList.remove('on'));b.classList.add('on');tm.value=b.dataset.t;});
f.addEventListener('submit',async e=>{e.preventDefault();if(!tm.value){msg.textContent='Please pick a time.';msg.className='err';return;}
 const r=await fetch('/api/book',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(Object.fromEntries(new FormData(f)))});const j=await r.json();
 if(r.ok){f.innerHTML='<div class="done"><h2>You\\'re booked! ✨</h2><p>'+j.when+' — '+j.service+'</p><p class="muted">A confirmation text is on its way.</p></div>';}
 else{msg.textContent=j.error;msg.className='err';load();}});
</script>`);
}

function adminShell(active: string, inner: string) {
  const unread = (db.query("SELECT COUNT(*) n FROM messages WHERE direction='in' AND handled=0").get() as any).n;
  const nav = [["/admin", "Appointments"], ["/admin/inbox", `Inbox${unread ? ` <span class="badge">${unread}</span>` : ""}`], ["/admin/clients", "Clients"]]
    .map(([h, l]) => `<a href="${h}" class="${active === h ? "on" : ""}">${l}</a>`).join("");
  return page("Dashboard", `<header class="topbar"><div class="wrap bar"><b>${esc(cfg().businessName)}</b><nav>${nav}</nav><span class="pill ${smsLive ? "live" : "dry"}">${smsLive ? "SMS live" : "SMS dry-run"}</span><a href="/admin/logout" class="muted small">Log out</a></div></header><main class="wrap">${inner}</main>`, true);
}
const statusPill = (s: string) => `<span class="st st-${s}">${s}</span>`;
function apptRow(a: any) {
  const act = ["booked", "confirmed"].includes(a.status);
  return `<div class="appt card"><div class="appt-time">${esc(nice(a.start))}<span class="muted small">–${esc(parseLocal(a.end).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }))}</span></div>
  <div class="appt-main"><a href="/admin/client/${a.client_id}"><b>${esc(a.name)}</b></a> ${statusPill(a.status)}<div>${esc(a.service_name)}</div>${a.client_notes ? `<div class="muted small">“${esc(a.client_notes)}”</div>` : ""}</div>
  ${act ? `<div class="appt-actions">
   ${a.status === "booked" ? `<form method="post" action="/admin/appt/${a.id}/confirm"><button class="btn sm">Confirm</button></form>` : ""}
   <form method="post" action="/admin/appt/${a.id}/complete"><button class="btn sm">Complete</button></form>
   <form method="post" action="/admin/appt/${a.id}/cancel" onsubmit="return confirm('Cancel and text the client?')"><button class="btn sm danger">Cancel</button></form>
   <details><summary class="btn sm">Reschedule</summary><form method="post" action="/admin/appt/${a.id}/reschedule" class="resched"><input type="datetime-local" name="start" value="${a.start}" step="900" required><button class="btn sm primary">Move</button></form></details>
  </div>` : ""}</div>`;
}

async function adminRoute(req: Request, url: URL): Promise<Response> {
  const p = url.pathname;
  if (p === "/admin/login") {
    if (req.method === "POST") {
      const fd = await req.formData();
      if (ADMIN_PASSWORD && fd.get("password") === ADMIN_PASSWORD) return redirect("/admin", { "set-cookie": `sess=${sessionToken()}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000` });
      return redirect("/admin/login?e=1");
    }
    return page("Login", `<main class="wrap narrow"><form method="post" class="card login"><h1>Stylist login</h1>${ADMIN_PASSWORD_IS_DEFAULT ? `<p class="muted small">Demo password: <b>demo-pass-2026</b></p>` : ""}${url.searchParams.get("e") ? `<p class="err">Wrong password.</p>` : ""}<input type="password" name="password" placeholder="Password" autofocus><button class="btn primary">Log in</button></form></main>`, true);
  }
  if (!authed(req)) return redirect("/admin/login");
  if (p === "/admin/logout") return redirect("/admin/login", { "set-cookie": "sess=; Path=/; Max-Age=0" });

  const m = p.match(/^\/admin\/appt\/(\d+)\/(confirm|cancel|complete|reschedule)$/);
  if (m && req.method === "POST") {
    const id = +m[1], act = m[2];
    const a = db.query("SELECT a.*, c.phone, c.name FROM appointments a JOIN clients c ON c.id=a.client_id WHERE a.id=?").get(id) as any;
    if (!a) return new Response("not found", { status: 404 });
    const biz = cfg().businessName;
    if (act === "confirm") { db.run("UPDATE appointments SET status='confirmed' WHERE id=?", [id]); }
    if (act === "cancel") { db.run("UPDATE appointments SET status='cancelled' WHERE id=?", [id]);
      await sendSms(a.phone, `Your ${a.service_name} appointment on ${nice(a.start)} with ${biz} has been cancelled. Rebook anytime: ${PUBLIC_BASE_URL}/`, { clientId: a.client_id, kind: "cancellation" }); }
    if (act === "complete") { db.run("UPDATE appointments SET status='completed' WHERE id=?", [id]);
      db.run("INSERT OR IGNORE INTO visits(client_id,appointment_id,date,service_name,price,notes) VALUES(?,?,?,?,?,?)", [a.client_id, id, a.start.slice(0, 10), a.service_name, a.price, a.stylist_notes || ""]); }
    if (act === "reschedule") {
      const fd = await req.formData(); const start = String(fd.get("start")).slice(0, 16);
      const dur = (parseLocal(a.end).getTime() - parseLocal(a.start).getTime()) / 60000; const end = addMin(start, dur);
      const ok = db.transaction(() => { if (overlapping(start, end, id)) return false; db.run("UPDATE appointments SET start=?, end=?, reminder_sent=0 WHERE id=?", [start, end, id]); return true; })();
      if (!ok) return adminShell("/admin", `<div class="card err">That time overlaps another appointment. <a href="/admin">Back</a></div>`);
      await sendSms(a.phone, `Your ${a.service_name} with ${biz} has been moved to ${nice(start)}. Reply if that doesn't work.`, { clientId: a.client_id, kind: "reschedule" });
    }
    return redirect(req.headers.get("referer") || "/admin");
  }

  if (p === "/admin") {
    const today = fmtLocal(new Date()).slice(0, 10);
    const q = (w: string, ...args: any[]) => db.query(`SELECT a.*, c.name, c.phone FROM appointments a JOIN clients c ON c.id=a.client_id WHERE ${w} ORDER BY start`).all(...args) as any[];
    const t = q("substr(a.start,1,10)=? AND a.status!='cancelled'", today), up = q("substr(a.start,1,10)>? AND a.status IN ('booked','confirmed')", today);
    const stats = db.query(`SELECT (SELECT COUNT(*) FROM clients) clients, (SELECT COUNT(*) FROM appointments WHERE status IN ('booked','confirmed') AND start>=?) upcoming, (SELECT COUNT(*) FROM messages WHERE direction='in' AND handled=0) unread`).get(today) as any;
    return adminShell("/admin", `<div class="stats"><div class="card stat"><span>${t.length}</span>Today</div><div class="card stat"><span>${stats.upcoming}</span>Upcoming</div><div class="card stat"><span>${stats.unread}</span>Unread texts</div><div class="card stat"><span>${stats.clients}</span>Clients</div></div>
    <h2>Today</h2>${t.map(apptRow).join("") || `<p class="muted card">Nothing booked today.</p>`}<h2>Upcoming</h2>${up.map(apptRow).join("") || `<p class="muted card">No upcoming appointments.</p>`}`);
  }
  if (p === "/admin/inbox") {
    const msgs = db.query(`SELECT m.*, c.name FROM messages m LEFT JOIN clients c ON c.id=m.client_id WHERE direction='in' ORDER BY handled, m.id DESC LIMIT 100`).all() as any[];
    return adminShell("/admin/inbox", `<h2>Client messages</h2>` + (msgs.map(m => `<div class="card msg ${m.handled ? "handled" : ""}">
      <div class="msg-head"><a href="/admin/client/${m.client_id}"><b>${esc(m.name || m.phone)}</b></a> <span class="muted small">${esc(m.phone)} · ${esc(m.created_at)} UTC</span>${m.handled ? ' <span class="st st-completed">replied</span>' : ' <span class="st st-booked">new</span>'}</div>
      <p class="bubble">${esc(m.body)}</p>
      ${m.handled ? "" : `<form method="post" action="/admin/msg/${m.id}/reply"><label class="small muted">Auto-drafted reply (rule: ${esc(m.draft_rule)}) — edit before sending</label><textarea name="body" rows="3">${esc(m.draft_reply)}</textarea>
      <div class="row-btns"><button class="btn primary sm">Send reply</button><button class="btn sm" name="dismiss" value="1">Mark handled</button></div></form>`}</div>`).join("") || `<p class="card muted">No messages yet.</p>`));
  }
  const mr = p.match(/^\/admin\/msg\/(\d+)\/reply$/);
  if (mr && req.method === "POST") {
    const fd = await req.formData(); const msg = db.query("SELECT * FROM messages WHERE id=?").get(+mr[1]) as any;
    if (!fd.get("dismiss")) await sendSms(msg.phone, String(fd.get("body")), { clientId: msg.client_id, kind: "reply" });
    db.run("UPDATE messages SET handled=1 WHERE id=?", [msg.id]); return redirect("/admin/inbox");
  }
  if (p === "/admin/clients") {
    const s = url.searchParams.get("q") || "";
    const cl = db.query(`SELECT c.*, (SELECT COUNT(*) FROM visits v WHERE v.client_id=c.id) visits, (SELECT MAX(start) FROM appointments a WHERE a.client_id=c.id) last FROM clients c WHERE name LIKE ?1 OR phone LIKE ?1 OR email LIKE ?1 ORDER BY name`).all(`%${s}%`) as any[];
    return adminShell("/admin/clients", `<h2>Clients</h2><form class="search"><input name="q" value="${esc(s)}" placeholder="Search name, phone, email"></form>
    <div class="card table"><table><tr><th>Name</th><th>Phone</th><th>Email</th><th>Visits</th><th>Last appt</th></tr>${cl.map(c => `<tr><td><a href="/admin/client/${c.id}">${esc(c.name)}</a></td><td>${esc(c.phone)}</td><td>${esc(c.email)}</td><td>${c.visits}</td><td>${c.last ? esc(nice(c.last)) : ""}</td></tr>`).join("")}</table></div>`);
  }
  const mc = p.match(/^\/admin\/client\/(\d+)(\/notes)?$/);
  if (mc) {
    const id = +mc[1];
    if (mc[2] && req.method === "POST") { const fd = await req.formData(); db.run("UPDATE clients SET notes=? WHERE id=?", [String(fd.get("notes")), id]); return redirect(`/admin/client/${id}`); }
    const c = db.query("SELECT * FROM clients WHERE id=?").get(id) as any; if (!c) return new Response("not found", { status: 404 });
    const appts = db.query("SELECT a.*, c.name FROM appointments a JOIN clients c ON c.id=a.client_id WHERE client_id=? ORDER BY start DESC").all(id) as any[];
    const visits = db.query("SELECT * FROM visits WHERE client_id=? ORDER BY date DESC").all(id) as any[];
    const msgs = db.query("SELECT * FROM messages WHERE client_id=? ORDER BY id").all(id) as any[];
    return adminShell("/admin/clients", `<div class="profile"><div><h2>${esc(c.name)}</h2><p class="muted">${esc(c.phone)} · ${esc(c.email)} · client since ${esc(c.created_at.slice(0, 10))}</p></div></div>
    <div class="grid2"><div><div class="card"><h3>Notes</h3><form method="post" action="/admin/client/${id}/notes"><textarea name="notes" rows="5" placeholder="Formulas, preferences, allergies…">${esc(c.notes)}</textarea><button class="btn sm primary">Save notes</button></form></div>
    <div class="card"><h3>Visit history</h3>${visits.map(v => `<div class="li"><b>${esc(v.date)}</b> ${esc(v.service_name)}</div>`).join("") || '<p class="muted">No completed visits yet.</p>'}</div>
    <h3>Appointments</h3>${appts.map(apptRow).join("") || '<p class="muted">None.</p>'}</div>
    <div class="card thread"><h3>Messages</h3>${msgs.map(m => `<div class="tmsg ${m.direction}"><div class="bubble">${esc(m.body)}</div><div class="muted small">${m.direction === "out" ? esc(m.kind) + " · " + esc(m.status) : "received"} · ${esc(m.created_at)} UTC</div></div>`).join("") || '<p class="muted">No messages.</p>'}
    <form method="post" action="/admin/client/${id}/sms"><textarea name="body" rows="2" placeholder="Text ${esc(c.name.split(" ")[0])}…"></textarea><button class="btn sm primary">Send text</button></form></div></div>`);
  }
  const ms = p.match(/^\/admin\/client\/(\d+)\/sms$/);
  if (ms && req.method === "POST") { const fd = await req.formData(); const c = db.query("SELECT * FROM clients WHERE id=?").get(+ms[1]) as any; if (c && fd.get("body")) await sendSms(c.phone, String(fd.get("body")), { clientId: c.id }); return redirect(`/admin/client/${ms[1]}`); }
  return new Response("not found", { status: 404 });
}

const json = (o: any, status = 200) => Response.json(o, { status });
Bun.serve({
  hostname: HOST,
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url), p = url.pathname;
    try {
      if (p === "/" || p === "/book") return bookingPage();
      if (p === "/api/services") return json(cfg().services);
      if (p === "/api/slots") {
        const s = cfg().services.find((x: any) => x.id === url.searchParams.get("service")); const date = url.searchParams.get("date") || "";
        if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ error: "service and date required" }, 400);
        return json({ date, slots: slotsFor(date, s.durationMinutes) });
      }
      if (p === "/api/book" && req.method === "POST") {
        const b: any = await req.json(); const c = cfg();
        const s = c.services.find((x: any) => x.id === b.service);
        if (!s) return json({ error: "Please choose a service." }, 400);
        if (!b.name?.trim() || !normPhone(b.phone || "") || !/^\S+@\S+\.\S+$/.test(b.email || "")) return json({ error: "Name, a valid phone and email are required." }, 400);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(b.date) || !/^\d{2}:\d{2}$/.test(b.time)) return json({ error: "Pick a date and time." }, 400);
        if (!slotsFor(b.date, s.durationMinutes).includes(b.time)) return json({ error: "Sorry, that time is no longer available. Please pick another." }, 409);
        const start = `${b.date}T${b.time}`, end = addMin(start, s.durationMinutes);
        let id; try { id = bookTx.immediate({ ...b, service: s, start, end }); } catch (e: any) { if (e.message === "SLOT_TAKEN") return json({ error: "Sorry, that time was just taken. Please pick another." }, 409); throw e; }
        sendConfirmation(id).catch(console.error);
        return json({ ok: true, id, when: nice(start), service: s.name });
      }
      if (p === "/sms/inbound" && req.method === "POST") {
        const params = Object.fromEntries(new URLSearchParams(await req.text())) as Record<string, string>;
        if (!validTwilioSignature(PUBLIC_BASE_URL + "/sms/inbound", params, req.headers.get("x-twilio-signature"))) return new Response("bad signature", { status: 403 });
        const from = normPhone(params.From || ""), body = params.Body || "";
        if (!from) return new Response("missing From", { status: 400 });
        let cl = db.query("SELECT id FROM clients WHERE phone=?").get(from) as any;
        if (!cl) cl = db.query("INSERT INTO clients(name,phone,email) VALUES(?,?,'') RETURNING id").get(`Unknown (${from})`, from);
        const d = draftReply(body);
        db.run("INSERT INTO messages(client_id,direction,phone,body,status,provider_sid,kind,draft_reply,draft_rule) VALUES(?,?,?,?,?,?,?,?,?)", [cl.id, "in", from, body, "received", params.MessageSid || null, "inbound", d.text, d.rule]);
        // Empty TwiML: replies are reviewed/sent from the dashboard, not auto-sent.
        return new Response(`<?xml version="1.0" encoding="UTF-8"?><Response></Response>`, { headers: { "content-type": "text/xml" } });
      }
      if (p === "/sms/status" && req.method === "POST") { const q = new URLSearchParams(await req.text()); db.run("UPDATE messages SET status=? WHERE provider_sid=?", [q.get("MessageStatus"), q.get("MessageSid")]); return new Response("ok"); }
      if (p === "/health") return json({ ok: true, smsLive });
      if (p.startsWith("/admin")) return adminRoute(req, url);
      return new Response("not found", { status: 404 });
    } catch (e: any) { console.error(e); return json({ error: "Server error" }, 500); }
  },
});
console.log(`Salon system on http://${HOST}:${PORT} (SMS ${smsLive ? "LIVE" : "dry-run"}), TZ=${process.env.TZ}`);
schedulerTick().catch(console.error);
