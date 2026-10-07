// Jackson Investments Group — Dialer + Pipeline (Cloudflare Worker + D1 + SignalWire)
//
// Calls are made from the browser (computer mic + speakers) through SignalWire.
// Backup mode "Ring my phone": SignalWire rings the rep's cell, rep presses 1, then the number is dialed.
//
// Env (Cloudflare > Worker > Settings > Variables and secrets):
//   SW_SPACE       e.g. jackson-investments-group.signalwire.com
//   SW_PROJECT_ID  Project ID
//   SW_API_TOKEN   API token (Secret)
//   SW_FROM        your SignalWire number, +1XXXXXXXXXX
//   TEAM_PASSWORD  optional (default JIG-dial-2026); OWNER_PASSWORD also accepted (default JIG-owner-2026)

const DEFAULTS = { TEAM_PASSWORD: "JIG-dial-2026", OWNER_PASSWORD: "JIG-owner-2026" };
const STAGES = ["Lead", "Contacted", "Callback", "Interested", "Offer Made", "Under Contract", "Assigned", "Closed", "Dead"];
const OUTCOMES = ["No Answer", "Voicemail", "Wrong Number", "Not Interested", "Callback", "Interested", "Offer Made", "DNC", "Other"];

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS deals (id TEXT PRIMARY KEY, address TEXT, seller TEXT, phone TEXT, stage TEXT DEFAULT 'Lead', asking INTEGER, offer INTEGER, notes TEXT DEFAULT '', rep TEXT, callback TEXT, created TEXT, updated TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_deals_stage ON deals(stage)`,
  `CREATE TABLE IF NOT EXISTS calls (id INTEGER PRIMARY KEY AUTOINCREMENT, lead_id TEXT, rep TEXT, phone TEXT, outcome TEXT, seconds INTEGER DEFAULT 0, note TEXT, ts TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_calls_ts ON calls(ts)`,
  `CREATE TABLE IF NOT EXISTS reps (name TEXT PRIMARY KEY, phone TEXT, updated TEXT)`
];
let schemaReady = false;

export default { fetch: (request, env) => handle(request, env) };

export async function handle(request, rawEnv) {
  const env = { ...DEFAULTS, ...Object.fromEntries(Object.entries(rawEnv || {}).filter(([, v]) => v && typeof v === "string")), DB: rawEnv && rawEnv.DB, ASSETS: rawEnv && rawEnv.ASSETS };
  const url = new URL(request.url);
  try {
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    if (url.pathname === "/api/bridge") return await bridge(env, url);
    if (url.pathname === "/api/bridge/connect") return await bridgeConnect(env, url);
    if (!env.DB) return json({ error: "Database isn't connected. Add the D1 binding named DB." }, 500);
    if (!schemaReady) { await env.DB.batch(SCHEMA.map(s => env.DB.prepare(s))); schemaReady = true; }

    const key = request.headers.get("x-team-key") || "";
    if (key !== env.TEAM_PASSWORD && key !== env.OWNER_PASSWORD) return json({ error: "Wrong password." }, 401);
    const rep = clean(request.headers.get("x-rep") || "", 40);
    if (!rep) return json({ error: "Enter your name." }, 400);
    const ctx = { env, rep, url, request };
    const path = url.pathname.replace(/^\/api/, "");
    const m = request.method;

    if (path === "/me" && m === "GET") {
      const r = await env.DB.prepare("SELECT phone FROM reps WHERE name = ?").bind(rep).first();
      return json({ rep, stages: STAGES, outcomes: OUTCOMES, sw: swReady(env), project: swReady(env) ? env.SW_PROJECT_ID : null, from: env.SW_FROM || null, phone: r ? r.phone : null });
    }
    if (path === "/sw/token" && m === "GET") return await swToken(ctx);
    if (path === "/me/phone" && m === "POST") return await savePhone(ctx);
    if (path === "/dial" && m === "POST") return await ringFirst(ctx);
    const dl = path.match(/^\/dial\/([A-Za-z0-9-]+)(\/hangup)?$/);
    if (dl && m === "GET" && !dl[2]) return await dialStatus(ctx, dl[1]);
    if (dl && m === "POST" && dl[2]) return await hangup(ctx, dl[1]);

    if (path === "/deals" && m === "GET") return await listDeals(ctx);
    if (path === "/deals" && m === "POST") return await saveDeal(ctx, null);
    const dd = path.match(/^\/deals\/([A-Za-z0-9_-]+)$/);
    if (dd && m === "PATCH") return await saveDeal(ctx, dd[1]);
    if (dd && m === "DELETE") { await env.DB.prepare("DELETE FROM deals WHERE id = ?").bind(dd[1]).run(); return json({ ok: true }); }

    if (path === "/calls" && m === "POST") return await logCall(ctx);
    if (path === "/calls" && m === "GET") return await recentCalls(ctx);
    return json({ error: "Not found." }, 404);
  } catch (e) {
    return json({ error: e.publicMessage || "Something went wrong. Try again.", detail: String(e && e.message || e) }, e.status || 500);
  }
}

/* ---------------- pipeline ---------------- */

async function listDeals({ env, url }) {
  const q = clean(url.searchParams.get("q") || "", 80).toLowerCase();
  const args = [];
  let where = "";
  if (q) { where = "WHERE lower(address) LIKE ? OR lower(seller) LIKE ? OR phone LIKE ?"; args.push(`%${q}%`, `%${q}%`, `%${q.replace(/\D/g, "") || "~~"}%`); }
  const rows = (await env.DB.prepare(`SELECT * FROM deals ${where} ORDER BY updated DESC LIMIT 1000`).bind(...args).all()).results || [];
  return json({ deals: rows });
}

async function saveDeal({ env, rep, request }, id) {
  const b = await readJson(request);
  const now = new Date().toISOString();
  const f = {};
  if (b.address !== undefined) f.address = clean(b.address, 160);
  if (b.seller !== undefined) f.seller = clean(b.seller, 80);
  if (b.phone !== undefined) f.phone = clean(b.phone, 40);
  if (b.stage !== undefined) { if (!STAGES.includes(b.stage)) return json({ error: "Bad stage." }, 400); f.stage = b.stage; }
  if (b.asking !== undefined) f.asking = money(b.asking);
  if (b.offer !== undefined) f.offer = money(b.offer);
  if (b.notes !== undefined) f.notes = String(b.notes || "").slice(0, 8000);
  if (b.callback !== undefined) f.callback = b.callback ? String(b.callback).slice(0, 40) : null;
  if (!id) {
    if (!f.address && !f.phone && !f.seller) return json({ error: "Add an address, name, or phone." }, 400);
    id = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
    const row = { address: "", seller: "", phone: "", stage: "Lead", asking: null, offer: null, notes: "", callback: null, ...f };
    await env.DB.prepare("INSERT INTO deals (id, address, seller, phone, stage, asking, offer, notes, rep, callback, created, updated) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
      .bind(id, row.address, row.seller, row.phone, row.stage, row.asking, row.offer, row.notes, rep, row.callback, now, now).run();
  } else {
    const keys = Object.keys(f);
    if (!keys.length) return json({ error: "Nothing to update." }, 400);
    await env.DB.prepare(`UPDATE deals SET ${keys.map(k => k + " = ?").join(", ")}, updated = ? WHERE id = ?`).bind(...keys.map(k => f[k]), now, id).run();
  }
  const deal = await env.DB.prepare("SELECT * FROM deals WHERE id = ?").bind(id).first();
  if (!deal) return json({ error: "Deal not found." }, 404);
  return json({ deal });
}

/* ---------------- call log ---------------- */

async function logCall({ env, rep, request }) {
  const b = await readJson(request);
  const outcome = OUTCOMES.includes(b.outcome) ? b.outcome : "Other";
  const now = new Date().toISOString();
  const note = String(b.note || "").trim().slice(0, 2000);
  const r = await env.DB.prepare("INSERT INTO calls (lead_id, rep, phone, outcome, seconds, note, ts) VALUES (?,?,?,?,?,?,?)")
    .bind(b.deal_id ? String(b.deal_id) : null, rep, clean(b.phone || "", 40), outcome, Math.max(0, Math.min(Number(b.seconds) || 0, 14400)), note, now).run();
  if (b.deal_id && note) {
    const d = await env.DB.prepare("SELECT notes FROM deals WHERE id = ?").bind(String(b.deal_id)).first();
    if (d) await env.DB.prepare("UPDATE deals SET notes = ?, updated = ? WHERE id = ?").bind((`[${now.slice(0, 10)} · ${rep} · ${outcome}] ${note}\n` + (d.notes || "")).slice(0, 8000), now, String(b.deal_id)).run();
  }
  return json({ ok: true, id: r.meta && r.meta.last_row_id });
}

async function recentCalls({ env, rep, url }) {
  const all = url.searchParams.get("all") === "1";
  const rows = (await env.DB.prepare(`SELECT * FROM calls ${all ? "" : "WHERE rep = ?"} ORDER BY id DESC LIMIT 40`).bind(...(all ? [] : [rep])).all()).results || [];
  const since = new Date(Date.now() - 86400000).toISOString();
  const today = await env.DB.prepare("SELECT COUNT(*) n, COALESCE(SUM(seconds),0) s FROM calls WHERE rep = ? AND ts >= ?").bind(rep, since).first();
  return json({ calls: rows, today });
}

/* ---------------- SignalWire ---------------- */

function swReady(env) { return !!(env.SW_SPACE && env.SW_PROJECT_ID && env.SW_API_TOKEN && env.SW_FROM); }
function swHost(env) { return String(env.SW_SPACE).replace(/^https?:\/\//, "").replace(/\/.*$/, ""); }
function swAuth(env) { return "Basic " + btoa(`${env.SW_PROJECT_ID}:${env.SW_API_TOKEN}`); }
function swFail(status, j) {
  const msg = status === 401 ? "SignalWire rejected the Project ID or API token. Check them in Cloudflare."
    : status === 403 ? "SignalWire blocked this. Usually the account is still in trial mode (add at least $5) or the token is missing calling permission."
    : status === 404 ? "SignalWire couldn't find that. Check SW_SPACE and SW_PROJECT_ID."
    : (j.message || j.error_message || (j.errors && j.errors[0] && (j.errors[0].detail || j.errors[0].message)) || `SignalWire error (${status}).`);
  const e = new Error(msg); e.publicMessage = msg; e.status = 502; return e;
}

// Browser calling token (SignalWire JS SDK v1 / Relay).
async function swToken({ env, rep }) {
  if (!swReady(env)) return json({ error: "SignalWire isn't set up yet. Add the SW_ variables in Cloudflare." }, 503);
  const r = await fetch(`https://${swHost(env)}/api/relay/rest/jwt`, {
    method: "POST",
    headers: { Authorization: swAuth(env), "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ resource: rep.replace(/[^A-Za-z0-9_-]/g, "_") || "rep", expires_in: 120 })
  });
  let j = {}; try { j = await r.json(); } catch {}
  if (!r.ok || !j.jwt_token) throw swFail(r.status, j);
  return json({ jwt: j.jwt_token, project: env.SW_PROJECT_ID, from: env.SW_FROM });
}

async function sw(env, path, form) {
  const r = await fetch(`https://${swHost(env)}/api/laml/2010-04-01/Accounts/${env.SW_PROJECT_ID}${path}`, {
    method: form ? "POST" : "GET",
    headers: { Authorization: swAuth(env), accept: "application/json", ...(form ? { "content-type": "application/x-www-form-urlencoded" } : {}) },
    body: form ? new URLSearchParams(form).toString() : undefined
  });
  let j = {}; try { j = await r.json(); } catch {}
  if (!r.ok) throw swFail(r.status, j);
  return j;
}
async function sign(env, text) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.SW_API_TOKEN || "x"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(text)));
  return [...mac.slice(0, 16)].map(b => b.toString(16).padStart(2, "0")).join("");
}

async function savePhone({ env, rep, request }) {
  const b = await readJson(request);
  if (!b.phone) { await env.DB.prepare("DELETE FROM reps WHERE name = ?").bind(rep).run(); return json({ phone: null }); }
  const ph = toE164(b.phone);
  if (!ph) return json({ error: "Enter a valid US cell number." }, 400);
  await env.DB.prepare("INSERT INTO reps (name, phone, updated) VALUES (?,?,?) ON CONFLICT(name) DO UPDATE SET phone=excluded.phone, updated=excluded.updated").bind(rep, ph, new Date().toISOString()).run();
  return json({ phone: ph });
}

// Backup mode: ring the rep's cell, rep presses 1, then dial the number.
async function ringFirst({ env, rep, request, url }) {
  if (!swReady(env)) return json({ error: "SignalWire isn't set up yet." }, 503);
  const b = await readJson(request);
  const to = toE164(b.to);
  if (!to) return json({ error: "That isn't a valid US number." }, 400);
  const r = await env.DB.prepare("SELECT phone FROM reps WHERE name = ?").bind(rep).first();
  if (!r || !r.phone) return json({ error: "Add your cell in Settings first." }, 400);
  const s = await sign(env, to);
  const call = await sw(env, "/Calls.json", { From: env.SW_FROM, To: r.phone, Url: `${url.origin}/api/bridge?to=${encodeURIComponent(to)}&s=${s}`, Method: "POST", Timeout: "25" });
  return json({ sid: call.sid });
}
async function dialStatus({ env }, sid) {
  const parent = await sw(env, `/Calls/${sid}.json`);
  let child = null;
  try { child = ((await sw(env, `/Calls.json?ParentCallSid=${encodeURIComponent(sid)}&PageSize=5`)).calls || [])[0] || null; } catch {}
  return json({ rep: { status: parent.status, duration: Number(parent.duration) || 0 }, lead: child ? { status: child.status, duration: Number(child.duration) || 0 } : null });
}
async function hangup({ env }, sid) { await sw(env, `/Calls/${sid}.json`, { Status: "completed" }); return json({ ok: true }); }

async function bridge(env, url) {
  const to = url.searchParams.get("to") || "", s = url.searchParams.get("s") || "";
  if (!toE164(to) || s !== await sign(env, to)) return xml(`<Response><Say>Invalid request.</Say><Hangup/></Response>`);
  const next = `${url.origin}/api/bridge/connect?to=${encodeURIComponent(to)}&amp;s=${s}`;
  return xml(`<Response><Gather numDigits="1" timeout="8" action="${next}" method="POST"><Say voice="woman">Press 1 to connect.</Say></Gather><Say voice="woman">No key pressed. Goodbye.</Say><Hangup/></Response>`);
}
async function bridgeConnect(env, url) {
  const to = url.searchParams.get("to") || "", s = url.searchParams.get("s") || "";
  if (!toE164(to) || s !== await sign(env, to)) return xml(`<Response><Say>Invalid request.</Say><Hangup/></Response>`);
  return xml(`<Response><Dial callerId="${escXml(env.SW_FROM)}" timeout="35"><Number>${escXml(toE164(to))}</Number></Dial></Response>`);
}

/* ---------------- helpers ---------------- */

function digits10(s) { const d = String(s || "").replace(/\D/g, ""); const t = d.length === 11 && d[0] === "1" ? d.slice(1) : d; return t.length === 10 ? t : null; }
function toE164(s) { const d = digits10(s); return d ? "+1" + d : null; }
function money(v) { const n = Math.round(parseFloat(String(v ?? "").replace(/[^0-9.]/g, ""))); return isNaN(n) ? null : n; }
function clean(s, n) { return String(s ?? "").replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, n); }
function escXml(s) { return String(s).replace(/[<>&"']/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" }[c])); }
async function readJson(request) { try { return await request.json(); } catch { return {}; } }
function xml(body) { return new Response(`<?xml version="1.0" encoding="UTF-8"?>${body}`, { headers: { "content-type": "text/xml" } }); }
function json(o, status = 200) { return new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } }); }
