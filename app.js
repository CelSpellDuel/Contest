/* SpellDuel – Supabase client app (teacher, student, projector) */
const CFG = window.SPELLDUEL_CONFIG;
const sb = supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const norm = s => String(s || "").trim().toLowerCase();
const val = id => $("#" + id)?.value.trim() || "";
const S = { role: null, contest: null, people: [], matches: [], words: [], answers: [], events: [], me: null, tab: "overview", ch: null, busy: false };
const nm = id => S.people.find(p => p.id === id)?.name;

/* ---------- UI helpers ---------- */
let tt;
function toast(t) { const e = $("#toast"); e.textContent = t; e.classList.add("show"); clearTimeout(tt); tt = setTimeout(() => e.classList.remove("show"), 2800); }
function pill(t, c = "") { $("#pill").textContent = t; $("#pill").className = "pill " + c; }
function show(id) {
  document.querySelectorAll(".screen").forEach(s => s.classList.toggle("active", s.id === id));
  $("#hLogout").hidden = id !== "teacher";
}
function go(id) {
  if (id === "landing") { leave(); pill("READY"); }
  show(id);
}
function leave() {
  speechSynthesis.cancel(); S.voiceOn = false;
  if (S.ch) sb.removeChannel(S.ch);
  Object.assign(S, { ch: null, role: null, contest: null, people: [], matches: [], words: [], answers: [], events: [], me: null, key: null, cur: null });
}
const statusPill = () => { const s = S.contest?.status || "lobby"; pill(s.toUpperCase(), s === "finished" ? "off" : ""); };

/* ---------- realtime + data ---------- */
function subscribe() {
  if (S.ch) sb.removeChannel(S.ch);
  const id = S.contest.id;
  let ch = sb.channel("contest-" + id);
  ["contestants", "matches", "words", "answers", "security_events"].forEach(t =>
    ch = ch.on("postgres_changes", { event: "*", schema: "public", table: t, filter: `contest_id=eq.${id}` }, refresh));
  ch = ch.on("postgres_changes", { event: "*", schema: "public", table: "contests", filter: `id=eq.${id}` }, refresh);
  S.ch = ch.subscribe();
}
let rt;
function refresh() { clearTimeout(rt); rt = setTimeout(doRefresh, 120); }
async function doRefresh() {
  if (!S.contest) return;
  const id = S.contest.id, t = S.role === "teacher";
  const q = tb => t || ["contestants", "matches"].includes(tb) ? sb.from(tb).select("*").eq("contest_id", id).order("created_at") : Promise.resolve({ data: [] });
  const [k, p, m, w, a, e] = await Promise.all([sb.from("contests").select("*").eq("id", id).single(), q("contestants"), q("matches"), q("words"), q("answers"), q("security_events")]);
  if (!k.data) return;
  Object.assign(S, { contest: k.data, people: p.data || [], matches: m.data || [], words: w.data || [], answers: a.data || [], events: e.data || [] });
  if (t) await reconcile();
  render();
}
function render() {
  if (!S.contest) return;
  statusPill();
  if (S.role === "teacher") renderTeacher();
  else if (S.role === "student") renderStudent();
  else renderProjector();
}

/* ---------- teacher: judging + bracket engine ---------- */
async function pickWord() {
  if (!S.words.length) { toast("Add words to the word bank first."); return null; }
  let pool = S.words.filter(w => !w.used);
  if (!pool.length) { await sb.from("words").update({ used: false }).eq("contest_id", S.contest.id); S.words.forEach(w => w.used = false); pool = S.words; }
  const w = pool[Math.floor(Math.random() * pool.length)];
  w.used = true;
  await sb.from("words").update({ used: true }).eq("id", w.id);
  return w;
}
async function finish(m, w, l, dq) {
  await sb.from("matches").update({ status: "done", winner: w, finished_at: new Date().toISOString() }).eq("id", m.id);
  m.status = "done"; m.winner = w;
  const W = S.people.find(p => p.id === w), L = S.people.find(p => p.id === l);
  if (W) { W.wins++; await sb.from("contestants").update({ wins: W.wins }).eq("id", w); }
  if (L && !dq) {
    L.losses++; L.status = L.losses >= 2 ? "eliminated" : "active";
    await sb.from("contestants").update({ losses: L.losses, status: L.status }).eq("id", l);
  }
}
async function reconcile() {
  if (S.busy) return;
  S.busy = true;
  try {
    for (const e of S.events.filter(e => e.severity === "dq")) {           // disqualifications
      const p = S.people.find(x => x.id === e.contestant_id);
      if (p && p.status === "active") {
        p.status = "disqualified";
        await sb.from("contestants").update({ status: "disqualified", losses: 2 }).eq("id", p.id);
        for (const m of S.matches.filter(m => m.status !== "done" && (m.p1 === p.id || m.p2 === p.id)))
          await finish(m, m.p1 === p.id ? m.p2 : m.p1, p.id, true);
      }
    }
    for (const m of S.matches.filter(m => m.status === "live")) {           // auto-judging
      const a = S.answers.filter(x => x.match_id === m.id && x.attempt === m.attempt);
      const a1 = a.find(x => x.contestant_id === m.p1), a2 = a.find(x => x.contestant_id === m.p2);
      if (!a1 || !a2) continue;
      const ok1 = norm(a1.answer) === norm(m.word), ok2 = norm(a2.answer) === norm(m.word);
      if (ok1 !== ok2) await finish(m, ok1 ? m.p1 : m.p2, ok1 ? m.p2 : m.p1);
      else {                                                                // tie → sudden-death word
        const w = await pickWord();
        if (w) await sb.from("matches").update({ attempt: m.attempt + 1, word: w.word, definition: w.definition, example: w.example }).eq("id", m.id);
      }
    }
    const open = S.matches.some(m => m.status !== "done"), act = S.people.filter(p => p.status === "active");
    if (S.contest.status === "live" && !open && act.length === 1) {         // champion
      await sb.from("contestants").update({ status: "champion" }).eq("id", act[0].id);
      await sb.from("contests").update({ status: "finished" }).eq("id", S.contest.id);
    }
  } finally { S.busy = false; }
}
async function nextRound() {
  const act = S.people.filter(p => p.status === "active");
  if (S.matches.some(m => m.status !== "done")) return toast("Finish the current matches first.");
  if (act.length < 2) return toast("Need at least 2 active contestants.");
  const round = Math.max(0, ...S.matches.map(m => m.round)) + 1;
  const rows = [];
  if (act.length % 2) {                                                        // odd number → one bye
    const had = new Set(S.matches.filter(m => !m.p2).map(m => m.p1));
    const pool = act.filter(p => !had.has(p.id));                              // nobody gets a second bye first
    const b = (pool.length ? pool : act)[Math.floor(Math.random() * (pool.length || act.length))];
    act.splice(act.indexOf(b), 1);
    rows.push({ contest_id: S.contest.id, round, p1: b.id, p2: null, status: "done", winner: b.id });
  }
  act.sort(() => Math.random() - .5).sort((a, b) => a.losses - b.losses);     // same-loss players meet first
  for (let i = 0; i < act.length; i += 2)
    rows.push({ contest_id: S.contest.id, round, p1: act[i].id, p2: act[i + 1].id, status: "pending" });
  const { error } = await sb.from("matches").insert(rows);
  if (error) return toast("Could not create round: " + error.message);
  await sb.from("contests").update({ status: "live" }).eq("id", S.contest.id);
  toast(`Round ${round} ready.`);
}

/* ---------- teacher UI ---------- */
function bracketHtml() {
  const rounds = [...new Set(S.matches.map(m => m.round))].sort((a, b) => a - b);
  if (!rounds.length) return `<p class="empty">The bracket appears once round 1 starts.</p>`;
  const line = (m, k) => {
    const id = m[k], cls = m.status === "done" && id ? (m.winner === id ? "win" : "lose") : "";
    return `<div class="pl ${cls}">${esc(id ? nm(id) : "Bye")}</div>`;
  };
  return `<div class="bracket">${rounds.map(r => `<div class="col"><h4>Round ${r}</h4>${S.matches.filter(m => m.round === r).map(m =>
    `<div class="mbox ${m.status}">${line(m, "p1")}${line(m, "p2")}</div>`).join("")}</div>`).join("")}</div>`;
}
function renderTeacher() {
  const ae = document.activeElement;
  if (ae && ae.closest("#teacher") && /INPUT|TEXTAREA|SELECT/.test(ae.tagName)) return;
  const c = S.contest, tabs = [["overview", "Overview"], ["contestants", "Contestants"], ["words", "Word bank"], ["matches", "Matches"], ["security", "Security"]];
  let body = "";
  if (!c || S.creating) {
    body = `<div class="narrow" style="max-width:520px;margin:auto"><h3>New contest</h3><br>
      <input id="cName" placeholder="Contest name">
      <input id="cCap" type="number" min="2" max="500" inputmode="numeric" placeholder="Number of students (e.g. 15)">
      <select id="cSec"><option value="strict">Strict: disqualify on leaving the screen</option><option value="warning">One warning, then disqualify</option></select>
      <button class="btn" data-act="createContest">Create contest</button>
      ${c ? `<button class="link" data-act="cancelNew">Cancel</button>` : ""}</div>`;
  } else if (S.tab === "overview") {
    body = `<div class="row"><h3>${esc(c.name)}</h3><button class="btn ghost" data-act="newContest">New contest</button></div>
      <div class="stats">${[["Contestants", S.people.length], ["Matches", S.matches.length], ["Words", S.words.length], ["Violations", S.events.length]]
        .map(([l, n]) => `<div class="card stat"><b>${n}</b><span>${l}</span></div>`).join("")}</div>
      <div class="card row" style="margin-bottom:26px"><div><b>Number of students</b><br><small>${S.people.length} joined. An odd number gives one student a bye each round.</small></div>
      <div style="display:flex;gap:10px;align-items:center"><input id="capIn" type="number" min="2" max="500" value="${c.capacity}" style="width:110px;margin:0"><button class="btn ghost sm" data-act="setCap">Update</button></div></div>
      <div class="card center"><p class="sub" style="margin-bottom:8px">Contest code</p><div class="code">${esc(c.code)}</div><br>
      <button class="btn ghost" data-act="copy">Copy code</button> <button class="btn" data-act="openProjector">Open projector</button></div>`;
  } else if (S.tab === "contestants") {
    body = `<h3>Contestants (${S.people.length}/${c.capacity})</h3><br><table><tr><th>#</th><th>Name</th><th>Student no.</th><th>Status</th><th>Wins</th><th>Losses</th></tr>
      ${S.people.map((p, i) => `<tr><td>${i + 1}</td><td><b>${esc(p.name)}</b></td><td>${esc(p.student_no)}</td><td><span class="tag ${p.status}">${p.status}</span></td><td>${p.wins}</td><td>${p.losses}</td></tr>`).join("")}</table>
      ${S.people.length ? "" : `<p class="empty">Share code ${esc(c.code)} so students can join.</p>`}`;
  } else if (S.tab === "words") {
    body = `<h3>Word bank</h3><br><p class="sub" style="text-align:left;margin-bottom:14px">Type a word. AI Master writes the definition and the example sentence.</p>
      <textarea id="wBulk" placeholder="necessary&#10;Add several at once: one word per line, or separate them with commas."></textarea>
      <button class="btn" data-act="addWords">Add words</button><br><br>
      <table><tr><th>Word</th><th>Definition</th><th>Example</th><th></th></tr>${S.words.map(w =>
        `<tr><td><b>${esc(w.word)}</b> ${w.used ? '<span class="tag">used</span>' : ""}</td><td>${esc(w.definition)}</td><td>${w.example ? esc(w.example) : '<span class="tag disqualified">no example</span>'}</td><td><button class="btn ghost sm" data-act="sayWord" data-id="${w.id}">🔊</button> <button class="btn ghost sm" data-act="editWord" data-id="${w.id}">Edit</button> <button class="btn ghost sm" data-act="delWord" data-id="${w.id}">Delete</button></td></tr>`).join("")}</table>`;
  } else if (S.tab === "matches") {
    const last = Math.max(0, ...S.matches.map(m => m.round)), cur = S.matches.filter(m => m.round === last && m.p2);
    body = `<div class="row"><h3>${last ? "Round " + last : "Matches"}</h3><button class="btn" data-act="nextRound">${last ? "Start next round" : "Start round 1"}</button></div>
      ${cur.map(m => {
        const got = S.answers.filter(a => a.match_id === m.id && a.attempt === m.attempt).length;
        return `<div class="card row"><div><b>${esc(nm(m.p1))}</b> vs <b>${esc(nm(m.p2))}</b> <span class="tag ${m.status}">${m.status}</span>
        ${m.status === "live" ? `<br><small>Word: <b>${esc(m.word)}</b> · attempt ${m.attempt} · ${got}/2 answers</small>` : ""}</div>
        <div>${m.status === "live" ? `<button class="btn ok sm" data-act="sayMatch" data-id="${m.id}">🔊 Read aloud</button> ` : ""}${m.status === "pending" ? `<button class="btn ok sm" data-act="start" data-id="${m.id}">Start</button>` : ""}
        ${m.status !== "done" ? `<button class="btn ghost sm" data-act="force" data-id="${m.id}" data-w="p1">${esc(nm(m.p1))} wins</button> <button class="btn ghost sm" data-act="force" data-id="${m.id}" data-w="p2">${esc(nm(m.p2))} wins</button>` : ""}</div></div>`;
      }).join("")}<br>${bracketHtml()}`;
  } else {
    body = `<h3>Security monitor</h3><br>${S.events.length ? S.events.slice().reverse().map(e =>
      `<div class="card" style="margin-bottom:12px"><b>${esc(nm(e.contestant_id))}</b> <span class="tag ${e.severity === "dq" ? "disqualified" : ""}">${e.severity === "dq" ? "disqualified" : "warning"}</span><p>${esc(e.reason)}</p><small>${new Date(e.created_at).toLocaleString()}</small></div>`).join("")
      : `<p class="empty">No security violations.</p>`}`;
  }
  $("#teacher").innerHTML = (c && !S.creating ? `<nav class="tabs">${tabs.map(([k, l]) => `<button class="tab ${S.tab === k ? "on" : ""}" data-act="tab" data-id="${k}">${l}</button>`).join("")}</nav>` : "") + body;
}

/* ---------- student UI ---------- */
let VOICE = null;
function pickVoice() {
  const v = speechSynthesis.getVoices().filter(x => /^en/i.test(x.lang));
  VOICE = v.find(x => /aria|jenny|zira|samantha|libby|sonia|hazel|susan|karen|moira|tessa|female|google us english/i.test(x.name)) || v[0] || null;
}
speechSynthesis.onvoiceschanged = pickVoice; pickVoice();
function say(text) {
  if (!VOICE) pickVoice();
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  if (VOICE) u.voice = VOICE;
  u.rate = .85; u.pitch = 1.05;
  speechSynthesis.speak(u);
}
const script = m => `The word is ${m.word}. ${(m.definition || "").replace(/^\(([^)]+)\)\s*/, "$1: ")}. ${m.example ? "Used in a sentence: " + m.example + "." : ""} Again, the word is ${m.word}.`;
function speak() { if (S.cur) say(script(S.cur)); }
function renderStudent() {
  const me = S.people.find(p => p.id === S.me); if (!me) return;
  const mine = m => m.p1 === me.id || m.p2 === me.id;
  const m = S.matches.find(x => x.status === "live" && mine(x)), next = S.matches.find(x => x.status === "pending" && mine(x));
  S.cur = m || null;
  const dq = S.localDQ || me.status === "disqualified", sent = m && S.sent === m.id + ":" + m.attempt;
  const key = [me.status, dq, m?.id, m?.attempt, sent, next?.id, me.wins, me.losses, S.contest.status].join("|");
  if (key === S.key) return; S.key = key;
  const opp = x => esc(nm(x.p1 === me.id ? x.p2 : x.p1));
  let h;
  if (dq) h = `<div class="center"><div class="big">🚫</div><h2 class="title sm">Disqualified</h2><p class="sub">${esc(S.reason || "A security rule was broken.")}</p></div>`;
  else if (me.status === "champion") h = `<div class="center"><div class="big">🏆</div><h2 class="title sm">You won the tournament</h2></div>`;
  else if (me.status === "eliminated") h = `<div class="center"><div class="big">👏</div><h2 class="title sm">You're out</h2><p class="sub">Two losses ends a run. Thanks for playing, ${esc(me.name)}.</p></div>`;
  else if (m) h = `<p class="sub" style="margin-bottom:18px">Round ${m.round} · versus <b>${opp(m)}</b></p>
    <div class="wordcard"><button class="btn" data-act="speak">🔊 Hear AI Master</button><p>${esc(m.definition)}</p>${m.example ? `<p><em>“${esc(m.example)}”</em></p>` : ""}</div>
    ${sent ? `<p class="sub">Answer sent. Waiting for your opponent…</p>` : `<input id="ans" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Type the word" onpaste="return false"><button class="btn" data-act="submit">Submit answer</button>`}`;
  else h = `<div class="center"><div class="big">⏳</div><h2 class="title sm">You're in</h2><p class="sub">${esc(me.name)}<br>${next ? `Next: <b>${opp(next)}</b>. Waiting for the teacher to start your match.` : me.wins || me.losses ? "Waiting for the next round." : "Waiting for the teacher to start the contest."}</p></div>`;
  $("#student").innerHTML = h;
  if (m && !sent) $("#ans")?.focus();
}
let lastV = 0;
function violation(reason) {
  if (S.role !== "student" || !S.cur || S.localDQ || Date.now() - lastV < 2500) return;
  lastV = Date.now();
  const strict = S.contest.security_mode === "strict" || S.warned;
  if (!strict) { S.warned = true; toast("Warning: leaving this screen again will disqualify you."); }
  else { S.localDQ = true; S.reason = reason; }
  sb.from("security_events").insert({ contest_id: S.contest.id, contestant_id: S.me, reason, severity: strict ? "dq" : "warning" }).then(() => { });
  render();
}
document.addEventListener("visibilitychange", () => document.hidden && violation("The contest tab was hidden."));
window.addEventListener("blur", () => setTimeout(() => !document.hasFocus() && violation("The contest window lost focus."), 400));

/* ---------- projector UI ---------- */
function renderProjector() {
  const c = S.contest, live = S.matches.find(m => m.status === "live");
  const done = S.matches.filter(m => m.status === "done" && m.p2).sort((a, b) => (b.finished_at || "").localeCompare(a.finished_at || ""))[0];
  const pend = S.matches.find(m => m.status === "pending");
  const champ = S.people.find(p => p.status === "champion");
  const vs = m => `<div class="vs">${esc(nm(m.p1))}<em>vs</em>${esc(nm(m.p2))}</div>`;
  let stage;
  if (champ) stage = `<div class="big">🏆</div><div class="vs">${esc(champ.name)}</div><p class="sub">Tournament champion</p>`;
  else if (live) stage = `<p class="sub">Round ${live.round} · Listen to AI Master and spell</p>${vs(live)}<div class="mask">${"_ ".repeat(live.word.length).trim()}</div><p class="sub" style="margin-top:20px">${live.word.length} letters · attempt ${live.attempt}</p>`;
  else if (done && (!pend || S.matches.length)) stage = `<p class="sub">Last result</p>${vs(done)}<p class="sub" style="margin-top:20px"><b>${esc(nm(done.winner))}</b> advances · the word was <b>${esc(done.word)}</b></p>`;
  else if (pend) stage = `<p class="sub">Up next</p>${vs(pend)}`;
  else stage = `<p class="sub">Join with the code above</p><div class="chips">${S.people.map(p => `<span class="chip">${esc(p.name)}</span>`).join("") || "<span class='empty'>Waiting for contestants…</span>"}</div><p class="sub" style="margin-top:20px">${S.people.length} of ${c.capacity} joined</p>`;
  const alive = S.people.filter(p => p.status === "active").length;
  $("#projector").innerHTML = `<div class="ph"><div><h3 style="font-size:40px">${esc(c.name)}</h3><span class="sub" style="margin:0">${alive} in the running</span></div>
    <div class="center"><span class="sub" style="margin:0">Contest code</span><div class="code">${esc(c.code)}</div></div>
    <div style="display:flex;gap:10px;flex-wrap:wrap"><button class="btn ${S.voiceOn ? "ok" : "ghost"}" data-act="voice">${S.voiceOn ? "🔊 AI Master is on" : "🔊 Enable AI Master voice"}</button>${S.voiceOn ? '<button class="btn ghost" data-act="repeat">Repeat</button>' : ""}<button class="btn ghost" data-act="full">Fullscreen (F)</button></div></div>
    <div class="stage">${stage}</div>${bracketHtml()}`;
  if (S.voiceOn && live) { const k = live.id + ":" + live.attempt; if (S.said !== k) { S.said = k; say(script(live)); } }
}
async function openProjector(code) {
  const { data } = await sb.from("contests").select("*").eq("code", code.toUpperCase()).maybeSingle();
  if (!data) return toast("No contest found for that code.");
  leave(); S.role = "projector"; S.contest = data;
  pill("LIVE"); show("projector"); subscribe(); doRefresh();
}

/* ---------- actions ---------- */
async function loadTeacherContest() {
  const { data: { user } } = await sb.auth.getUser();
  const { data } = await sb.from("contests").select("*").eq("owner_id", user.id).order("created_at", { ascending: false }).limit(1);
  leave(); S.role = "teacher"; S.contest = data?.[0] || null; show("teacher");
  if (S.contest) { subscribe(); doRefresh(); } else renderTeacher();
}
async function lookup(word) {
  try {
    const r = await fetch("https://api.dictionaryapi.dev/api/v2/entries/en/" + encodeURIComponent(word));
    if (!r.ok) return null;
    let def = "", ex = "";
    for (const e of await r.json()) for (const m of e.meanings || []) for (const d of m.definitions || []) {
      if (!def) def = `(${m.partOfSpeech}) ${d.definition}`;
      if (!ex && d.example) ex = d.example;
    }
    return def ? { definition: def, example: ex } : null;
  } catch { return null; }
}
async function askMaster(words) {
  const out = {};
  for (let i = 0; i < words.length; i += 25) {
    const { data, error } = await sb.functions.invoke("ai-master", { body: { words: words.slice(i, i + 25) } });
    if (error || !data?.results) { S.aiDown = true; continue; }
    data.results.forEach(r => { if (r.definition) out[norm(r.word)] = r; });
  }
  return out;
}
const genCode = () => Array.from({ length: 6 }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[Math.floor(Math.random() * 32)]).join("");
const act = {
  async teacherLogin() {
    const { data, error } = await sb.auth.signInWithPassword({ email: val("tEmail"), password: $("#tPass").value });
    if (error) return toast("Sign-in failed: " + error.message);
    if (data.user.is_anonymous) return toast("This is not a teacher account.");
    loadTeacherContest();
  },
  async logout() { await sb.auth.signOut(); go("landing"); },
  async join() {
    const code = val("sCode").toUpperCase(), name = val("sName");
    if (!code || !name) return toast("Enter the contest code and your name.");
    let { data: { session } } = await sb.auth.getSession();
    if (!session) { const r = await sb.auth.signInAnonymously(); if (r.error) return toast("Could not start a student session. Is anonymous sign-in enabled?"); session = r.data.session; }
    const { data: c } = await sb.from("contests").select("*").eq("code", code).maybeSingle();
    if (!c) return toast("Invalid contest code.");
    let { data: p, error } = await sb.from("contestants").insert({ contest_id: c.id, name, student_no: val("sNo") }).select().single();
    if (error) {
      const r = await sb.from("contestants").select("*").eq("contest_id", c.id).eq("user_id", session.user.id).maybeSingle();
      if (!r.data) return toast(c.status !== "lobby" ? "This contest has already started." : "The contest is full.");
      p = r.data;
    }
    localStorage.sd_me = JSON.stringify({ contest: c.id, id: p.id });
    leave(); Object.assign(S, { role: "student", contest: c, me: p.id }); show("student"); subscribe(); doRefresh();
  },
  projector() { openProjector(val("pCode")); },
  tab(d) { S.tab = d.id; S.creating = false; renderTeacher(); },
  newContest() { S.creating = true; renderTeacher(); },
  cancelNew() { S.creating = false; renderTeacher(); },
  async createContest() {
    const name = val("cName"), cap = parseInt(val("cCap"), 10);
    if (!name) return toast("Enter a contest name.");
    if (!cap || cap < 2) return toast("Enter the number of students (at least 2).");
    const { data, error } = await sb.from("contests").insert({ name, code: genCode(), capacity: cap, security_mode: $("#cSec").value }).select().single();
    if (error) return toast("Could not create contest: " + error.message);
    S.creating = false; S.tab = "overview"; S.contest = data; S.people = []; S.matches = []; S.words = []; S.answers = []; S.events = [];
    subscribe(); doRefresh(); toast("Contest created.");
  },
  async setCap() {
    const n = parseInt(val("capIn"), 10);
    if (!n || n < Math.max(2, S.people.length)) return toast(`Enter at least ${Math.max(2, S.people.length)} (students already joined).`);
    const { error } = await sb.from("contests").update({ capacity: n }).eq("id", S.contest.id);
    if (error) return toast(error.message);
    toast("Number of students updated."); doRefresh();
  },
  copy() { navigator.clipboard.writeText(S.contest.code); toast("Code copied."); },
  openProjector() { window.open(`${location.pathname}?projector=${S.contest.code}`, "_blank"); },
  async addWords() {
    const lines = val("wBulk").split("\n").flatMap(l => l.includes("|") ? [l] : l.split(","));
    const items = lines.map(x => x.trim()).filter(Boolean);
    if (!items.length) return toast("Type a word first.");
    const have = new Set(S.words.map(w => norm(w.word))), rows = [], nf = [], noEx = [];
    S.aiDown = false;
    const todo = items.filter(it => !it.includes("|") && !have.has(norm(it)));
    let ai = {};
    if (todo.length) { toast("AI Master is writing the definitions…"); ai = await askMaster(todo); }
    for (const it of items) {
      const r = it.split("|").map(x => x.trim()), word = r[0];
      if (!word || have.has(norm(word))) continue;
      have.add(norm(word));
      let def = r[1], ex = r.slice(2).join(" | ");
      if (!def) {
        const d = ai[norm(word)] || await lookup(word);
        if (!d) { nf.push(word); continue; }
        def = d.definition; ex = d.example;
      }
      if (!ex) noEx.push(word);
      rows.push({ contest_id: S.contest.id, word, definition: def, example: ex });
    }
    if (rows.length) {
      const { error } = await sb.from("words").insert(rows);
      if (error) return toast(error.message);
      $("#wBulk").value = "";
    }
    toast([`${rows.length} word(s) added.`, S.aiDown && "AI Master is unavailable, so the dictionary was used.", nf.length && `No dictionary entry: ${nf.join(", ")}.`, noEx.length && `No example sentence: ${noEx.join(", ")} (use Edit).`].filter(Boolean).join(" "));
    doRefresh();
  },
  async editWord(d) {
    const w = S.words.find(x => x.id === d.id); if (!w) return;
    const def = prompt("Definition", w.definition); if (def === null) return;
    const ex = prompt("Example sentence", w.example); if (ex === null) return;
    await sb.from("words").update({ definition: def.trim(), example: ex.trim() }).eq("id", w.id);
    refresh();
  },
  async delWord(d) { await sb.from("words").delete().eq("id", d.id); },
  nextRound,
  async start(d) {
    const w = await pickWord(); if (!w) return;
    await sb.from("matches").update({ status: "live", attempt: 1, word: w.word, definition: w.definition, example: w.example }).eq("id", d.id);
  },
  async force(d) { const m = S.matches.find(x => x.id === d.id), w = m[d.w]; await finish(m, w, d.w === "p1" ? m.p2 : m.p1); refresh(); },
  speak,
  voice() {
    S.voiceOn = !S.voiceOn; S.said = null;
    if (!S.voiceOn) speechSynthesis.cancel();
    else if (!S.matches.some(m => m.status === "live")) say("Hello, I am AI Master. I will read the words for you.");
    renderProjector();
  },
  repeat() { const l = S.matches.find(m => m.status === "live"); if (l) say(script(l)); },
  sayMatch(d) { const m = S.matches.find(x => x.id === d.id); if (m) say(script(m)); },
  sayWord(d) { const w = S.words.find(x => x.id === d.id); if (w) say(script(w)); },
  async submit() {
    const v = val("ans"), m = S.cur; if (!v || !m) return toast("Type your answer first.");
    const { error } = await sb.from("answers").insert({ contest_id: S.contest.id, match_id: m.id, contestant_id: S.me, attempt: m.attempt, answer: v });
    if (error) return toast("Could not send your answer. Try again.");
    S.sent = m.id + ":" + m.attempt; render();
  },
  full() { document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen(); }
};
document.addEventListener("click", e => {
  const t = e.target.closest("[data-go],[data-act]"); if (!t) return;
  if (t.dataset.go) go(t.dataset.go); else act[t.dataset.act]?.(t.dataset);
});
document.addEventListener("keydown", e => {
  if (e.key === "Enter" && e.target.id === "ans") act.submit();
  if ((e.key === "f" || e.key === "F") && S.role === "projector") act.full();
});
setInterval(() => S.contest && doRefresh(), 8000);   // safety net if a realtime event is missed

/* ---------- start ---------- */
(async () => {
  if (CFG.SUPABASE_URL.includes("YOUR-PROJECT")) return toast("Add your Supabase URL and anon key to config.js.");
  const code = new URLSearchParams(location.search).get("projector");
  if (code) return openProjector(code);
  const { data: { session } } = await sb.auth.getSession();
  if (session && !session.user.is_anonymous) return loadTeacherContest();
  const me = JSON.parse(localStorage.sd_me || "null");
  if (session && me) {
    const { data: c } = await sb.from("contests").select("*").eq("id", me.contest).maybeSingle();
    if (c) { Object.assign(S, { role: "student", contest: c, me: me.id }); show("student"); subscribe(); doRefresh(); }
  }
})();
