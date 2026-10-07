// Jackson Investments Group — Dialer + CRM (Cloudflare Worker + D1 + SignalWire)
//
// How a call works ("call me first"): rep clicks Call -> SignalWire rings the rep's cell ->
// rep answers and presses 1 -> SignalWire dials the lead and bridges them, showing SW_FROM as caller ID.
//
// Headers on every /api call (except /api/bridge*): x-team-key, x-rep
// Env (Cloudflare > Worker > Settings > Variables and secrets):
//   SW_SPACE       your space host, e.g. jacksoninvest.signalwire.com
//   SW_PROJECT_ID  Project ID (looks like a UUID)
//   SW_API_TOKEN   API token (starts with PT)
//   SW_FROM        your SignalWire number, +1XXXXXXXXXX
//   TEAM_PASSWORD, OWNER_PASSWORD (optional, defaults below)

const DEFAULTS = { TEAM_PASSWORD: "JIG-dial-2026", OWNER_PASSWORD: "JIG-owner-2026" };

const STATUSES = ["New", "Calling", "No Answer", "Callback", "Interested", "Offer Made", "Under Contract", "Not Interested", "Wrong Number", "DNC"];
// outcome picked after a call -> lead status
const OUTCOME_STATUS = {
  "No Answer": "No Answer", "Voicemail": "No Answer", "Callback": "Callback", "Interested": "Interested",
  "Offer Made": "Offer Made", "Under Contract": "Under Contract", "Not Interested": "Not Interested",
  "Wrong Number": "Wrong Number", "DNC": "DNC"
};

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS leads (id TEXT PRIMARY KEY, market TEXT, address TEXT, csz TEXT, sqft TEXT, beds_baths TEXT, phones TEXT, status TEXT DEFAULT 'New', owner TEXT, notes TEXT DEFAULT '', callback TEXT, last_call TEXT, calls INTEGER DEFAULT 0, created TEXT, updated TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_leads_market_status ON leads(market, status)`,
  `CREATE TABLE IF NOT EXISTS calls (id INTEGER PRIMARY KEY AUTOINCREMENT, lead_id TEXT, rep TEXT, phone TEXT, outcome TEXT, seconds INTEGER DEFAULT 0, note TEXT, ts TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_calls_ts ON calls(ts)`,
  `CREATE INDEX IF NOT EXISTS idx_calls_lead ON calls(lead_id)`,
  `CREATE TABLE IF NOT EXISTS reps (name TEXT PRIMARY KEY, phone TEXT, updated TEXT)`
];
let schemaReady = false;

export default {
  async fetch(request, rawEnv) {
    return handle(request, rawEnv);
  }
};
// Worker signature is fetch(request, env, ctx); keep a named export for tests.
export async function handle(request, rawEnv) {
  const env = { ...DEFAULTS, ...Object.fromEntries(Object.entries(rawEnv || {}).filter(([, v]) => v && typeof v === "string")), DB: rawEnv && rawEnv.DB, ASSETS: rawEnv && rawEnv.ASSETS };
  const url = new URL(request.url);
  try {
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    if (url.pathname === "/api/bridge") return await bridge(request, env, url);
    if (url.pathname === "/api/bridge/connect") return await bridgeConnect(request, env, url);
    if (!env.DB) return json({ error: "Database isn't connected. Add the D1 binding named DB." }, 500);
    if (!schemaReady) { await env.DB.batch(SCHEMA.map(s => env.DB.prepare(s))); schemaReady = true; }

    const key = request.headers.get("x-team-key") || "";
    const isOwner = key === env.OWNER_PASSWORD;
    if (!isOwner && key !== env.TEAM_PASSWORD) return json({ error: "Wrong password." }, 401);
    const rep = clean(request.headers.get("x-rep") || "", 40);
    if (!rep) return json({ error: "Enter your name." }, 400);
    const ctx = { env, rep, isOwner, url, request };
    const path = url.pathname.replace(/^\/api/, "");
    const m = request.method;

    if (path === "/me" && m === "GET") {
      const r = await env.DB.prepare("SELECT phone FROM reps WHERE name = ?").bind(rep).first();
      return json({ rep, owner: isOwner, statuses: STATUSES, dialer: swReady(env), phone: r ? r.phone : null });
    }
    if (path === "/me/phone" && m === "POST") return await savePhone(ctx);
    if (path === "/dial" && m === "POST") return await dial(ctx);
    const dl = path.match(/^\/dial\/([A-Za-z0-9-]+)(\/hangup)?$/);
    if (dl && m === "GET" && !dl[2]) return await dialStatus(ctx, dl[1]);
    if (dl && m === "POST" && dl[2]) return await hangup(ctx, dl[1]);
    if (path === "/leads" && m === "GET") return await listLeads(ctx);
    if (path === "/leads/next" && m === "POST") return await nextLead(ctx);
    if (path === "/leads/import" && m === "POST") return await importLeads(ctx);
    if (path === "/leads/add" && m === "POST") return await addLead(ctx);
    if (path === "/dnc" && m === "POST") return await dncScrub(ctx);
    if (path === "/calls" && m === "POST") return await logCall(ctx);
    if (path === "/stats" && m === "GET") return await stats(ctx);
    const one = path.match(/^\/leads\/([A-Za-z0-9_-]+)$/);
    if (one && m === "GET") return await getLead(ctx, one[1]);
    if (one && m === "PATCH") return await patchLead(ctx, one[1]);
    return json({ error: "Not found." }, 404);
  } catch (e) {
    return json({ error: e.publicMessage || "Something went wrong. Try again.", detail: String(e && e.message || e) }, e.status || 500);
  }
}

/* ---------------- leads ---------------- */

function rowOut(r) {
  return { ...r, phones: safeParse(r.phones, []) };
}

async function listLeads({ env, url, rep, isOwner }) {
  const q = url.searchParams;
  const where = [], args = [];
  const market = q.get("market"); if (market && market !== "All") { where.push("market = ?"); args.push(market); }
  const status = q.get("status"); if (status && status !== "All") { where.push("status = ?"); args.push(status); }
  if (q.get("mine") === "1") { where.push("owner = ?"); args.push(rep); }
  const owner = q.get("owner"); if (owner && isOwner) { where.push("owner = ?"); args.push(owner); }
  const s = clean(q.get("q") || "", 80).toLowerCase();
  if (s) { where.push("(lower(address) LIKE ? OR phones LIKE ?)"); args.push(`%${s}%`, `%${s.replace(/\D/g, "") || "~~"}%`); }
  const limit = Math.min(Number(q.get("limit")) || 100, 300), offset = Math.max(Number(q.get("offset")) || 0, 0);
  const order = status === "Callback" ? "callback ASC" : "updated DESC";
  const sql = `SELECT * FROM leads ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY ${order} LIMIT ? OFFSET ?`;
  const rows = (await env.DB.prepare(sql).bind(...args, limit, offset).all()).results || [];
  const total = (await env.DB.prepare(`SELECT COUNT(*) c FROM leads ${where.length ? "WHERE " + where.join(" AND ") : ""}`).bind(...args).first()).c;
  return json({ leads: rows.map(rowOut), total });
}

async function getLead({ env }, id) {
  const r = await env.DB.prepare("SELECT * FROM leads WHERE id = ?").bind(id).first();
  if (!r) return json({ error: "Lead not found." }, 404);
  const calls = (await env.DB.prepare("SELECT * FROM calls WHERE lead_id = ? ORDER BY id DESC LIMIT 50").bind(id).all()).results || [];
  return json({ lead: rowOut(r), calls });
}

// Atomically hand the next untouched lead to this rep so two reps never get the same one.
async function nextLead({ env, rep, request }) {
  const b = await readJson(request);
  const market = b.market && b.market !== "All" ? String(b.market) : null;
  // release anything this rep left half-open in "Calling" with no calls logged
  await env.DB.prepare("UPDATE leads SET status='New', owner=NULL WHERE status='Calling' AND owner=? AND calls=0 AND updated < ?").bind(rep, new Date(Date.now() - 1000 * 60 * 30).toISOString()).run();
  const now = new Date().toISOString();
  const sql = `UPDATE leads SET owner=?, status='Calling', updated=? WHERE id = (SELECT id FROM leads WHERE status='New' AND owner IS NULL ${market ? "AND market=?" : ""} ORDER BY rowid LIMIT 1) RETURNING *`;
  const r = await env.DB.prepare(sql).bind(...(market ? [rep, now, market] : [rep, now])).first();
  if (!r) return json({ lead: null });
  return json({ lead: rowOut(r) });
}

async function patchLead({ env, rep, isOwner, request }, id) {
  const b = await readJson(request);
  const cur = await env.DB.prepare("SELECT * FROM leads WHERE id = ?").bind(id).first();
  if (!cur) return json({ error: "Lead not found." }, 404);
  const sets = [], args = [];
  if (b.status !== undefined) {
    if (!STATUSES.includes(b.status)) return json({ error: "Bad status." }, 400);
    sets.push("status = ?"); args.push(b.status);
  }
  if (b.notes !== undefined) { sets.push("notes = ?"); args.push(String(b.notes).slice(0, 8000)); }
  if (b.callback !== undefined) { sets.push("callback = ?"); args.push(b.callback ? String(b.callback).slice(0, 40) : null); }
  if (b.owner !== undefined && isOwner) { sets.push("owner = ?"); args.push(b.owner ? clean(b.owner, 40) : null); }
  if (b.claim) { sets.push("owner = ?"); args.push(rep); }
  if (b.release) { sets.push("owner = NULL"); sets.push("status = 'New'"); }
  if (!sets.length) return json({ error: "Nothing to update." }, 400);
  sets.push("updated = ?"); args.push(new Date().toISOString());
  await env.DB.prepare(`UPDATE leads SET ${sets.join(", ")} WHERE id = ?`).bind(...args, id).run();
  const r = await env.DB.prepare("SELECT * FROM leads WHERE id = ?").bind(id).first();
  return json({ lead: rowOut(r) });
}

async function addLead({ env, request }) {
  const b = await readJson(request);
  const lead = normLead(b);
  if (!lead) return json({ error: "Address is required." }, 400);
  const now = new Date().toISOString();
  await env.DB.prepare("INSERT OR IGNORE INTO leads (id, market, address, csz, sqft, beds_baths, phones, status, created, updated) VALUES (?,?,?,?,?,?,?,'New',?,?)")
    .bind(lead.id, clean(b.market || "Other", 30), lead.address, lead.csz, lead.sqft, lead.beds_baths, JSON.stringify(lead.phones), now, now).run();
  return json({ ok: true, id: lead.id });
}

async function importLeads({ env, isOwner, request }) {
  if (!isOwner) return json({ error: "Owner password required to import." }, 403);
  const b = await readJson(request);
  const market = clean(b.market || "Other", 30);
  const items = Array.isArray(b.leads) ? b.leads.slice(0, 200) : [];
  const now = new Date().toISOString();
  const stmts = [];
  let skipped = 0;
  for (const raw of items) {
    const l = normLead(raw);
    if (!l) { skipped++; continue; }
    stmts.push(env.DB.prepare("INSERT OR IGNORE INTO leads (id, market, address, csz, sqft, beds_baths, phones, status, created, updated) VALUES (?,?,?,?,?,?,?,'New',?,?)")
      .bind(l.id, market, l.address, l.csz, l.sqft, l.beds_baths, JSON.stringify(l.phones), now, now));
  }
  let added = 0;
  if (stmts.length) {
    const res = await env.DB.batch(stmts);
    added = res.reduce((n, r) => n + ((r.meta && r.meta.changes) || 0), 0);
  }
  return json({ added, duplicates: stmts.length - added, skipped });
}

// Mark every lead that has any number on the supplied do-not-call list.
async function dncScrub({ env, isOwner, request }) {
  if (!isOwner) return json({ error: "Owner password required." }, 403);
  const b = await readJson(request);
  const set = new Set((Array.isArray(b.numbers) ? b.numbers : String(b.numbers || "").split(/[\n,;]+/)).map(digits10).filter(Boolean));
  if (!set.size) return json({ error: "No valid numbers found." }, 400);
  const rows = (await env.DB.prepare("SELECT id, phones FROM leads WHERE status != 'DNC'").all()).results || [];
  const now = new Date().toISOString();
  const stmts = [];
  for (const r of rows) {
    if (safeParse(r.phones, []).some(p => set.has(digits10(p.num)))) stmts.push(env.DB.prepare("UPDATE leads SET status='DNC', updated=? WHERE id=?").bind(now, r.id));
  }
  for (let i = 0; i < stmts.length; i += 90) await env.DB.batch(stmts.slice(i, i + 90));
  return json({ marked: stmts.length, checked: rows.length, numbers: set.size });
}

function normLead(r) {
  const address = clean(r.address || r.Address || "", 160).toUpperCase();
  if (address.length < 4) return null;
  let phones = r.phones ?? r["Phone Numbers"] ?? "";
  if (typeof phones === "string") {
    phones = phones.split(";").map(s => s.trim()).filter(Boolean).map(s => {
      const m = s.match(/^(.*?)(?:\s*\(([^)]*)\))?$/);
      return { num: (m && m[1] || s).trim(), type: (m && m[2] || "").trim() };
    });
  }
  const seen = new Set();
  phones = (phones || []).map(p => ({ num: String(p.num || "").trim(), type: String(p.type || "").trim() }))
    .filter(p => { const d = digits10(p.num); if (!d || seen.has(d)) return false; seen.add(d); return true; }).slice(0, 6);
  const csz = clean(r.csz || r["City, State, Zip"] || "", 80).toUpperCase();
  return {
    id: hashId(address + "|" + csz), address, csz,
    sqft: clean(r.sqft ?? r["Square Feet"] ?? "", 20),
    beds_baths: clean(r.beds_baths ?? r["Beds / Baths"] ?? "", 30),
    phones
  };
}

/* ---------------- calls + stats ---------------- */

async function logCall({ env, rep, request }) {
  const b = await readJson(request);
  const id = String(b.lead_id || "");
  const outcome = String(b.outcome || "");
  if (!OUTCOME_STATUS[outcome]) return json({ error: "Pick an outcome." }, 400);
  const lead = await env.DB.prepare("SELECT * FROM leads WHERE id = ?").bind(id).first();
  if (!lead) return json({ error: "Lead not found." }, 404);
  const now = new Date().toISOString();
  const note = String(b.note || "").trim().slice(0, 2000);
  const secs = Math.max(0, Math.min(Number(b.seconds) || 0, 7200));
  let notes = lead.notes || "";
  if (note) notes = `[${now.slice(0, 16).replace("T", " ")} UTC · ${rep} · ${outcome}] ${note}\n` + notes;
  const callback = outcome === "Callback" && b.callback ? String(b.callback).slice(0, 40) : (outcome === "Callback" ? lead.callback : null);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO calls (lead_id, rep, phone, outcome, seconds, note, ts) VALUES (?,?,?,?,?,?,?)").bind(id, rep, clean(b.phone || "", 30), outcome, secs, note, now),
    env.DB.prepare("UPDATE leads SET status=?, owner=COALESCE(owner, ?), notes=?, callback=?, last_call=?, calls=calls+1, updated=? WHERE id=?")
      .bind(OUTCOME_STATUS[outcome], rep, notes.slice(0, 12000), callback, now, now, id)
  ]);
  const r = await env.DB.prepare("SELECT * FROM leads WHERE id = ?").bind(id).first();
  return json({ lead: rowOut(r) });
}

async function stats({ env, url }) {
  const days = Math.min(Math.max(Number(url.searchParams.get("days")) || 1, 1), 30);
  const tz = url.searchParams.get("tz");
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const reps = (await env.DB.prepare(`SELECT rep, COUNT(*) calls, SUM(seconds) talk,
      SUM(outcome='Interested') interested, SUM(outcome='Offer Made') offers, SUM(outcome='Under Contract') contracts,
      SUM(outcome IN ('No Answer','Voicemail')) noans
      FROM calls WHERE ts >= ? GROUP BY rep ORDER BY calls DESC`).bind(since).all()).results || [];
  const pipeline = (await env.DB.prepare("SELECT status, COUNT(*) n FROM leads GROUP BY status").all()).results || [];
  const markets = (await env.DB.prepare("SELECT market, COUNT(*) n, SUM(status='New') fresh FROM leads GROUP BY market").all()).results || [];
  return json({ days, since, reps, pipeline, markets });
}

/* ---------------- SignalWire (call me first) ---------------- */

function swReady(env) { return !!(env.SW_SPACE && env.SW_PROJECT_ID && env.SW_API_TOKEN && env.SW_FROM); }
function swHost(env) { return String(env.SW_SPACE).replace(/^https?:\/\//, "").replace(/\/.*$/, ""); }
function swBase(env) { return `https://${swHost(env)}/api/laml/2010-04-01/Accounts/${env.SW_PROJECT_ID}`; }
function swAuth(env) { return "Basic " + btoa(`${env.SW_PROJECT_ID}:${env.SW_API_TOKEN}`); }
async function sw(env, path, form, method) {
  const r = await fetch(swBase(env) + path, {
    method: method || (form ? "POST" : "GET"),
    headers: { Authorization: swAuth(env), ...(form ? { "content-type": "application/x-www-form-urlencoded" } : {}), accept: "application/json" },
    body: form ? new URLSearchParams(form).toString() : undefined
  });
  let j = {}; try { j = await r.json(); } catch {}
  if (!r.ok) {
    const msg = r.status === 401 ? "SignalWire rejected the Project ID or API token. Check them in Cloudflare."
      : r.status === 403 ? "SignalWire blocked the call. Usually the account is still in trial mode (add at least $5) or SW_FROM isn't a number you own."
      : r.status === 404 ? "SignalWire couldn't find that space or call. Check SW_SPACE and SW_PROJECT_ID."
      : (j.message || j.error_message || `SignalWire error (${r.status}).`);
    const e = new Error(msg); e.publicMessage = msg; e.status = 502; throw e;
  }
  return j;
}
async function sign(env, text) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.SW_API_TOKEN || "x"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(text)));
  return [...mac.slice(0, 16)].map(b => b.toString(16).padStart(2, "0")).join("");
}

async function savePhone({ env, rep, request }) {
  const b = await readJson(request);
  const ph = toE164(b.phone);
  if (!ph) return json({ error: "Enter a valid US cell number." }, 400);
  await env.DB.prepare("INSERT INTO reps (name, phone, updated) VALUES (?,?,?) ON CONFLICT(name) DO UPDATE SET phone=excluded.phone, updated=excluded.updated").bind(rep, ph, new Date().toISOString()).run();
  return json({ phone: ph });
}

async function dial({ env, rep, request, url }) {
  if (!swReady(env)) return json({ error: "SignalWire isn't set up yet. Add the SW_ variables in Cloudflare." }, 503);
  const b = await readJson(request);
  const to = toE164(b.to);
  if (!to) return json({ error: "That isn't a valid US number." }, 400);
  const lead = await env.DB.prepare("SELECT id, status FROM leads WHERE id = ?").bind(String(b.lead_id || "")).first();
  if (!lead) return json({ error: "Lead not found." }, 404);
  if (lead.status === "DNC") return json({ error: "This lead is marked DNC." }, 403);
  const r = await env.DB.prepare("SELECT phone FROM reps WHERE name = ?").bind(rep).first();
  if (!r || !r.phone) return json({ error: "Add your cell number first (top right)." }, 400);
  const s = await sign(env, to);
  const bridgeUrl = `${url.origin}/api/bridge?to=${encodeURIComponent(to)}&s=${s}`;
  const call = await sw(env, "/Calls.json", { From: env.SW_FROM, To: r.phone, Url: bridgeUrl, Method: "POST", Timeout: "25" });
  return json({ sid: call.sid, rep_phone: r.phone });
}

async function dialStatus({ env }, sid) {
  const parent = await sw(env, `/Calls/${sid}.json`);
  let child = null;
  try {
    const list = await sw(env, `/Calls.json?ParentCallSid=${encodeURIComponent(sid)}&PageSize=5`);
    child = (list.calls || [])[0] || null;
  } catch {}
  return json({
    rep: { status: parent.status, duration: Number(parent.duration) || 0 },
    lead: child ? { status: child.status, duration: Number(child.duration) || 0 } : null
  });
}

async function hangup({ env }, sid) {
  await sw(env, `/Calls/${sid}.json`, { Status: "completed" });
  return json({ ok: true });
}

// SignalWire fetches this when the rep answers their cell. Rep must press a key so a voicemail can't connect the lead.
async function bridge(request, env, url) {
  const to = url.searchParams.get("to") || "";
  const s = url.searchParams.get("s") || "";
  if (!toE164(to) || s !== await sign(env, to)) return xml(`<Response><Say>Invalid request.</Say><Hangup/></Response>`);
  const next = `${url.origin}/api/bridge/connect?to=${encodeURIComponent(to)}&amp;s=${s}`;
  return xml(`<Response><Gather numDigits="1" timeout="8" action="${next}" method="POST"><Say voice="woman">Press 1 to connect.</Say></Gather><Say voice="woman">No key pressed. Goodbye.</Say><Hangup/></Response>`);
}

async function bridgeConnect(request, env, url) {
  const to = url.searchParams.get("to") || "";
  const s = url.searchParams.get("s") || "";
  if (!toE164(to) || s !== await sign(env, to)) return xml(`<Response><Say>Invalid request.</Say><Hangup/></Response>`);
  return xml(`<Response><Dial callerId="${escXml(env.SW_FROM)}" timeout="35"><Number>${escXml(toE164(to))}</Number></Dial></Response>`);
}

/* ---------------- helpers ---------------- */

function digits10(s) { const d = String(s || "").replace(/\D/g, ""); const t = d.length === 11 && d[0] === "1" ? d.slice(1) : d; return t.length === 10 ? t : null; }
function toE164(s) { const d = digits10(s); return d ? "+1" + d : null; }
function clean(s, n) { return String(s ?? "").replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, n); }
function safeParse(s, d) { try { return JSON.parse(s); } catch { return d; } }
function hashId(s) { let h1 = 0xdeadbeef, h2 = 0x41c6ce57; for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677); } h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909); h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909); return (h2 >>> 0).toString(36) + (h1 >>> 0).toString(36); }
function b64url(bytes) { let s = ""; bytes.forEach(b => s += String.fromCharCode(b)); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
function escXml(s) { return String(s).replace(/[<>&"']/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" }[c])); }
async function readJson(request) { try { return await request.json(); } catch { return {}; } }
function xml(body) { return new Response(`<?xml version="1.0" encoding="UTF-8"?>${body}`, { headers: { "content-type": "text/xml" } }); }
function json(o, status = 200) { return new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } }); }
