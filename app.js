/* SpellDuel – Supabase client app (teacher, student) */
const CFG = window.SPELLDUEL_CONFIG;
const sb = supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const norm = s => String(s || "").trim().toLowerCase();
const val = id => $("#" + id)?.value.trim() || "";
const S = { role: null, contest: null, people: [], matches: [], words: [], answers: [], events: [], me: null, tab: "overview", ch: null, busy: false, drills: [], drillSel: null, dWords: [], dAttempts: [], drillErr: null, drill: null };
sb.auth.onAuthStateChange((_e, sess) => { S.token = sess?.access_token; });
const nm = id => S.people.find(p => p.id === id)?.name;
const TTS = "speechSynthesis" in window && "SpeechSynthesisUtterance" in window;
const LS = { get: k => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { } }, del: k => { try { localStorage.removeItem(k); } catch { } } };

/* ---------- UI helpers ---------- */
let tt;
function toast(t) { const e = $("#toast"); e.textContent = t; e.classList.add("show"); clearTimeout(tt); tt = setTimeout(() => e.classList.remove("show"), Math.max(2800, t.length * 70)); }
function pill(t, c = "") { $("#pill").textContent = t; $("#pill").className = "pill " + c; }
function show(id) {
  document.querySelectorAll(".screen").forEach(s => s.classList.toggle("active", s.id === id));
  $("#hLogout").hidden = !["teacher", "student"].includes(id);
}
function go(id) {
  if (id === "landing") { leave(); pill("READY"); }
  show(id);
}
function leave() {
  if (TTS) speechSynthesis.cancel();
  if (S.ch) sb.removeChannel(S.ch);
  Object.assign(S, { ch: null, role: null, contest: null, people: [], matches: [], words: [], answers: [], events: [], me: null, drills: [], drillSel: null, dWords: [], dAttempts: [], drillErr: null, drill: null, key: null, cur: null, localDQ: false, warned: false, sent: null, reason: null });
}
const statusPill = () => { const s = S.contest?.status || "lobby"; pill(s.toUpperCase(), s === "finished" ? "off" : ""); };

/* ---------- realtime + data ---------- */
function subscribe() {
  if (S.ch) sb.removeChannel(S.ch);
  const id = S.contest.id;
  let ch = sb.channel("contest-" + id);
  ["contestants", "matches", "words", "answers", "security_events", "match_secrets"].forEach(t =>
    ch = ch.on("postgres_changes", { event: "*", schema: "public", table: t, filter: `contest_id=eq.${id}` }, refresh));
  ch = ch.on("postgres_changes", { event: "*", schema: "public", table: "contests", filter: `id=eq.${id}` }, refresh);
  if (S.role === "teacher") ch = ch.on("postgres_changes", { event: "*", schema: "public", table: "drill_attempts" }, refresh);
  S.ch = ch.subscribe();
}
let rt;
function refresh() { clearTimeout(rt); rt = setTimeout(doRefresh, 120); }
async function doRefresh() {
  if (!S.contest) return;
  const id = S.contest.id, t = S.role === "teacher";
  const q = tb => t || ["contestants", "matches"].includes(tb) || (tb === "match_secrets" && S.role === "student") ? sb.from(tb).select("*").eq("contest_id", id).order("created_at") : Promise.resolve({ data: [] });
  // Students get their secret word through a database function (my_live_secrets); it does not depend on table policies.
  const secQ = async () => {
    if (S.role !== "student") return q("match_secrets");
    const r = await sb.rpc("my_live_secrets", { cid: id });
    if (!r.error) { S.secErr = null; return r; }
    S.secErr = r.error.message;
    return sb.from("match_secrets").select("*").eq("contest_id", id);
  };
  const [k, p, m, w, a, e, sc] = await Promise.all([sb.from("contests").select("*").eq("id", id).single(), q("contestants"), q("matches"), q("words"), q("answers"), q("security_events"), secQ()]);
  if (!k.data) return;
  Object.assign(S, { contest: k.data, people: p.data || [], matches: m.data || [], words: w.data || [], answers: a.data || [], events: e.data || [] });
  // The secret word/definition/example live in match_secrets; only the teacher and the two duelists can read them.
  const sec = sc.data || [];
  const by = new Map(sec.map(r => [r.match_id, r]));
  S.matches.forEach(mm => { const r = by.get(mm.id); Object.assign(mm, r && r.attempt === mm.attempt ? { word: r.word, definition: r.definition, example: r.example } : { word: mm.revealed_word || null, definition: null, example: null }); });
  if (t && S.tab === "drills") await loadDrills();
  if (t) await reconcile();
  render();
}
function render() {
  if (!S.contest) return;
  statusPill();
  if (S.role === "teacher") renderTeacher();
  else if (S.role === "student") renderStudent();
}

/* ---------- teacher: judging + bracket engine ---------- */
const shuffle = arr => { for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; } return arr; };
// One random word for a single duel (sudden-death tie-breaks). Avoids words currently live in other duels.
async function pickWord() {
  if (!S.words.length) { toast("Add words to the word bank first."); return null; }
  const live = new Set(S.matches.filter(m => m.status === "live").map(m => norm(m.word)));
  let pool = S.words.filter(w => !w.used && !live.has(norm(w.word)));
  if (!pool.length) { await sb.from("words").update({ used: false }).eq("contest_id", S.contest.id); S.words.forEach(w => w.used = false); pool = S.words.filter(w => !live.has(norm(w.word))); }
  if (!pool.length) pool = S.words;
  const w = pool[Math.floor(Math.random() * pool.length)];
  w.used = true;
  await sb.from("words").update({ used: true }).eq("id", w.id);
  return w;
}
// n different random words, one per pair, so no two duels in a round get the same word.
async function pickWords(n) {
  if (S.words.length < n) { toast(`Add at least ${n} words to the word bank (one per pair).`); return null; }
  let chosen = shuffle(S.words.filter(w => !w.used)).slice(0, n);
  if (chosen.length < n) {                                                   // bank ran out: start a new cycle
    const ids = new Set(chosen.map(w => w.id));
    await sb.from("words").update({ used: false }).eq("contest_id", S.contest.id);
    S.words.forEach(w => w.used = false);
    chosen = chosen.concat(shuffle(S.words.filter(w => !ids.has(w.id))).slice(0, n - chosen.length));
  }
  await sb.from("words").update({ used: true }).in("id", chosen.map(w => w.id));
  chosen.forEach(w => w.used = true);
  return chosen;
}
async function finish(m, w, l, dq) {
  await sb.from("matches").update({ status: "done", winner: w, finished_at: new Date().toISOString(), revealed_word: m.word || null }).eq("id", m.id);
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
      if (!a1 || !a2 || m.word == null) continue;
      const ok1 = norm(a1.answer) === norm(m.word), ok2 = norm(a2.answer) === norm(m.word);
      if (ok1 !== ok2) await finish(m, ok1 ? m.p1 : m.p2, ok1 ? m.p2 : m.p1);
      else {                                                                // tie → sudden-death word
        const w = await pickWord();
        if (w) {
          await sb.from("match_secrets").upsert({ match_id: m.id, contest_id: S.contest.id, attempt: m.attempt + 1, word: w.word, definition: w.definition, example: w.example });
          await sb.from("matches").update({ attempt: m.attempt + 1, word_len: w.word.length }).eq("id", m.id);
        }
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
  if (S.matches.some(m => m.status !== "done")) return toast("Finish the current matches first.");
  const act = S.people.filter(p => p.status === "active");
  if (act.length < 2) return toast("Need at least 2 active contestants.");
  const round = Math.max(0, ...S.matches.map(m => m.round)) + 1, cid = S.contest.id, rows = [];
  const had = new Set(S.matches.filter(m => !m.p2).map(m => m.p1));
  const upper = act.filter(p => p.losses === 0), lower = act.filter(p => p.losses === 1);
  const pair = (grp, bracket) => {
    grp = shuffle(grp.slice());
    if (grp.length % 2) {                                                      // odd group → one bye (nobody gets a second one first)
      const pool = grp.filter(p => !had.has(p.id)), b = (pool.length ? pool : grp)[Math.floor(Math.random() * (pool.length || grp.length))];
      grp.splice(grp.indexOf(b), 1); had.add(b.id);
      rows.push({ contest_id: cid, round, p1: b.id, p2: null, status: "done", winner: b.id, bracket });
    }
    for (let i = 0; i < grp.length; i += 2) rows.push({ contest_id: cid, round, p1: grp[i].id, p2: grp[i + 1].id, status: "pending", bracket });
  };
  if (upper.length === 1 && lower.length === 1) rows.push({ contest_id: cid, round, p1: upper[0].id, p2: lower[0].id, status: "pending", bracket: "final" });   // upper champion vs lower champion
  else { pair(upper, "upper"); pair(lower, "lower"); }
  const { error } = await sb.from("matches").insert(rows);
  if (error) return toast("Could not create round: " + error.message);
  await sb.from("contests").update({ status: "live" }).eq("id", cid);
  toast(`Round ${round} ready. Press "Start all duels".`);
}
async function startAll() {
  const pend = S.matches.filter(m => m.status === "pending" && m.p2);
  if (!pend.length) return toast("There are no pending duels to start.");
  const ws = await pickWords(pend.length); if (!ws) return;
  // 1) write every secret word first, 2) flip every duel to live in parallel, so all pairs begin together
  const { error } = await sb.from("match_secrets").upsert(pend.map((m, i) => ({ match_id: m.id, contest_id: S.contest.id, attempt: 1, word: ws[i].word, definition: ws[i].definition, example: ws[i].example })));
  if (error) return toast(error.message);
  const res = await Promise.all(pend.map((m, i) => sb.from("matches").update({ status: "live", attempt: 1, word_len: ws[i].word.length }).eq("id", m.id)));
  const bad = res.find(r => r.error);
  toast(bad ? bad.error.message : `${pend.length} duel${pend.length > 1 ? "s" : ""} started at the same time.`);
}

/* ---------- teacher UI ---------- */
function bracketHtml(list = S.matches, empty = "Nothing here yet.") {
  const rounds = [...new Set(list.map(m => m.round))].sort((a, b) => a - b);
  if (!rounds.length) return `<p class="empty">${empty}</p>`;
  const line = (m, k) => {
    const id = m[k], cls = m.status === "done" && id ? (m.winner === id ? "win" : "lose") : "";
    return `<div class="pl ${cls}">${esc(id ? nm(id) : "Bye")}</div>`;
  };
  return `<div class="bracket">${rounds.map(r => `<div class="col"><h4>Round ${r}</h4>${list.filter(m => m.round === r).map(m =>
    `<div class="mbox ${m.status}">${m.status === "live" ? '<div class="lvb">● LIVE</div>' : ""}${line(m, "p1")}${line(m, "p2")}</div>`).join("")}</div>`).join("")}</div>`;
}
function bracketsHtml() {
  const by = b => S.matches.filter(m => (m.bracket || "upper") === b);
  const sec = (t, cls, list, empty) => `<div class="bsec ${cls}"><h3>${t}</h3>${bracketHtml(list, empty)}</div>`;
  const fin = by("final");
  return sec("Upper bracket", "up", by("upper"), "The upper bracket appears once round 1 starts. Everyone begins here.") +
    sec("Lower bracket", "low", by("lower"), "Players who lose once drop down to the lower bracket.") +
    (fin.length ? sec("Grand final", "fin", fin, "") : "");
}
function renderTeacher() {
  const ae = document.activeElement;
  if (ae && ae.closest("#teacher") && /INPUT|TEXTAREA|SELECT/.test(ae.tagName)) return;
  const c = S.contest, tabs = [["overview", "Overview"], ["contestants", "Contestants"], ["words", "Word bank"], ["drills", "Practice & Quiz"], ["matches", "Matches"], ["security", "Security"], ["projector", "Projector"]];
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
      <div class="card center"><p class="sub" style="margin-bottom:8px">Contest code</p><div class="code">${esc(c.code)}</div>
      <p class="sub" style="margin:10px 0 18px">Show the live display on the big screen from the Projector tab.</p>
      <button class="btn ghost" data-act="copy">Copy code</button> <button class="btn" data-act="tab" data-id="projector">Open projector</button></div>`;
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
    const last = Math.max(0, ...S.matches.map(m => m.round)), cur = S.matches.filter(m => m.round === last && m.p2), pending = cur.some(m => m.status === "pending");
    body = `<div class="row"><h3>${last ? "Round " + last : "Matches"}</h3><div style="display:flex;gap:10px;flex-wrap:wrap"><button class="btn ${pending ? "ghost" : ""}" data-act="nextRound">${last ? "Start next round" : "Start round 1"}</button>${pending ? '<button class="btn ok" data-act="startAll">Start all duels ▶</button>' : ""}</div></div>
      ${cur.map(m => {
        const got = S.answers.filter(a => a.match_id === m.id && a.attempt === m.attempt).length;
        return `<div class="card row"><div><b>${esc(nm(m.p1))}</b> vs <b>${esc(nm(m.p2))}</b> <span class="tag ${m.status}">${m.status}</span> <span class="tag">${m.bracket || "upper"}</span>
        ${m.status === "live" ? `<br><small>${m.word_len ? m.word_len + " letters" : "Word hidden"} · attempt ${m.attempt} · ${got}/2 answers</small>` : ""}</div>
        <div>
        ${m.status !== "done" ? `<button class="btn ghost sm" data-act="force" data-id="${m.id}" data-w="p1">${esc(nm(m.p1))} wins</button> <button class="btn ghost sm" data-act="force" data-id="${m.id}" data-w="p2">${esc(nm(m.p2))} wins</button>` : ""}</div></div>`;
      }).join("")}<br>${bracketsHtml()}`;
  } else if (S.tab === "drills") {
    body = drillsHtml();
  } else if (S.tab === "projector") {
    body = projectorHtml();
  } else {
    body = `<h3>Security monitor</h3><br>${S.events.length ? S.events.slice().reverse().map(e =>
      `<div class="card" style="margin-bottom:12px"><b>${esc(nm(e.contestant_id))}</b> <span class="tag ${e.severity === "dq" ? "disqualified" : ""}">${e.severity === "dq" ? "disqualified" : "warning"}</span><p>${esc(e.reason)}</p><small>${new Date(e.created_at).toLocaleString()}</small></div>`).join("")
      : `<p class="empty">No security violations.</p>`}`;
  }
  $("#teacher").innerHTML = (c && !S.creating ? `<nav class="tabs">${tabs.map(([k, l]) => `<button class="tab ${S.tab === k ? "on" : ""}" data-act="tab" data-id="${k}">${l}</button>`).join("")}</nav>` : "") + body;
}

/* ---------- teacher: practice & quiz ---------- */
async function loadDrills() {
  const r = await sb.from("drills").select("*").order("created_at", { ascending: false });
  S.drillErr = r.error ? r.error.message : null;
  S.drills = r.data || [];
  if (S.drillSel && !S.drills.some(d => d.id === S.drillSel)) S.drillSel = null;
  if (S.drillSel) {
    const [w, a] = await Promise.all([
      sb.from("drill_words").select("*").eq("drill_id", S.drillSel).order("created_at"),
      sb.from("drill_attempts").select("*").eq("drill_id", S.drillSel).order("created_at")]);
    S.dWords = w.data || []; S.dAttempts = a.data || [];
  } else { S.dWords = []; S.dAttempts = []; }
}
async function reloadDrills() { await loadDrills(); renderTeacher(); }
const kindName = k => k === "quiz" ? "Quiz" : "Practice";
function drillsHtml() {
  if (S.drillErr) return `<h3>Practice &amp; Quiz</h3><br><div class="card"><p>These modules need a one-time database setup. Open <b>drills.sql</b>, paste it into Supabase → SQL Editor, run it, then reload this page.</p><small>${esc(S.drillErr)}</small></div>`;
  const d = S.drills.find(x => x.id === S.drillSel);
  if (d) return drillDetailHtml(d);
  return `<h3>Practice &amp; Quiz</h3><br>
    <p class="sub" style="text-align:left;margin-bottom:14px">Make a practice or quiz, add its words, and give students the code. Each student gets their own random words.</p>
    <div class="card" style="margin-bottom:24px"><div style="max-width:520px">
      <input id="dName" placeholder="Name (e.g. Week 3 words)">
      <select id="dKind"><option value="practice">Practice (students see right/wrong after each word)</option><option value="quiz">Quiz (score shown at the end, teacher sees results)</option></select>
      <input id="dCount" type="number" min="1" max="200" inputmode="numeric" placeholder="Number of words per student (e.g. 10)">
      <button class="btn" data-act="createDrill">Create</button></div></div>
    ${S.drills.length ? S.drills.map(d => `<div class="card row" style="margin-bottom:14px"><div><b>${esc(d.name)}</b> <span class="tag">${kindName(d.kind)}</span> <span class="tag ${d.status === "open" ? "active" : "eliminated"}">${d.status}</span>
      <br><small>${d.item_count} words per student · code <b>${esc(d.code)}</b></small></div>
      <button class="btn ghost sm" data-act="openDrill" data-id="${d.id}">Manage</button></div>`).join("") : `<p class="empty">No practice or quiz yet.</p>`}`;
}
function drillDetailHtml(d) {
  const few = S.dWords.length < d.item_count;
  const rows = S.dAttempts.slice().sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return `<div class="row"><div><button class="btn ghost sm" data-act="backDrills">← All</button> <h3 style="display:inline;margin-left:10px">${esc(d.name)}</h3> <span class="tag">${kindName(d.kind)}</span> <span class="tag ${d.status === "open" ? "active" : "eliminated"}">${d.status}</span></div>
    <div style="display:flex;gap:10px;flex-wrap:wrap"><button class="btn ghost sm" data-act="toggleDrill">${d.status === "open" ? "Close (stop answers)" : "Re-open"}</button><button class="btn ghost sm" data-act="delDrill">Delete</button></div></div>
    <div class="card center" style="margin-bottom:22px"><p class="sub" style="margin-bottom:8px">${kindName(d.kind)} code</p><div class="code">${esc(d.code)}</div>
      <p class="sub" style="margin:10px 0 14px">Students tap Student, then enter this code and their name.</p><button class="btn ghost" data-act="copyDrill">Copy code</button></div>
    <div class="card row" style="margin-bottom:22px"><div><b>Number of ${d.kind === "quiz" ? "quiz items" : "words to practice"}</b><br><small>Each student gets this many random words from your list.</small></div>
      <div style="display:flex;gap:10px;align-items:center"><input id="dCountIn" type="number" min="1" max="200" value="${d.item_count}" style="width:110px;margin:0"><button class="btn ghost sm" data-act="setDrillCount">Update</button></div></div>
    ${few ? `<div class="card" style="margin-bottom:22px;border-color:var(--amber)"><b>Add more words.</b> You have ${S.dWords.length} but each student needs ${d.item_count}. Students with fewer words available will get all of them.</div>` : ""}
    <h3>Words (${S.dWords.length})</h3><br>
    <textarea id="dBulk" placeholder="necessary&#10;One word per line, or separate them with commas. AI Master writes the definition and example."></textarea>
    <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:18px"><button class="btn" data-act="dAddWords">Add words</button>${S.words.length ? '<button class="btn ghost" data-act="dImport">Import contest word bank</button>' : ""}</div>
    <table><tr><th>Word</th><th>Definition</th><th>Example</th><th></th></tr>${S.dWords.map(w =>
      `<tr><td><b>${esc(w.word)}</b></td><td>${esc(w.definition)}</td><td>${w.example ? esc(w.example) : '<span class="tag disqualified">no example</span>'}</td><td><button class="btn ghost sm" data-act="dSayWord" data-id="${w.id}">🔊</button> <button class="btn ghost sm" data-act="dEditWord" data-id="${w.id}">Edit</button> <button class="btn ghost sm" data-act="dDelWord" data-id="${w.id}">Delete</button></td></tr>`).join("")}</table>
    <br><h3>Results (${rows.length})</h3><br>
    ${rows.length ? `<table><tr><th>#</th><th>Name</th><th>Student no.</th><th>Progress</th><th>Score</th><th>Status</th><th></th></tr>${rows.map((a, i) =>
      `<tr><td>${i + 1}</td><td><b>${esc(a.name)}</b></td><td>${esc(a.student_no)}</td><td>${a.answered}/${a.word_ids.length}</td><td><b>${a.score}</b>/${a.answered}</td><td><span class="tag ${a.status === "done" ? "active" : ""}">${a.status === "done" ? "finished" : "in progress"}</span></td><td><button class="btn ghost sm" data-act="dDelAttempt" data-id="${a.id}">Remove</button></td></tr>`).join("")}</table>`
      : `<p class="empty">No students yet. Share the code ${esc(d.code)}.</p>`}`;
}
const curDrill = () => S.drills.find(x => x.id === S.drillSel);

/* ---------- student: practice & quiz ---------- */
async function joinDrill(code, name) {
  const meta = { code, name, no: val("sNo") };
  const r = await sb.rpc("drill_join", { p_code: code, p_name: name, p_no: meta.no, p_restart: false });
  if (r.error) { const m = r.error.message || ""; return toast(/Invalid code|does not exist|schema cache|Could not find/i.test(m) ? "Invalid code. Check it with your teacher." : m); }
  LS.del("sd_me");
  await openDrillAttempt(r.data, meta);
}
async function openDrillAttempt(att, meta) {
  const r = await sb.rpc("drill_items", { p_attempt: att.attempt_id });
  if (r.error) return toast(r.error.message);
  leave();
  S.role = "drill";
  const items = r.data || [], first = items.findIndex(i => i.given == null);
  S.drill = { att: att.attempt_id, kind: att.kind, title: att.name, meta, items, idx: first < 0 ? items.length : first, fb: null, shown: {}, busy: false };
  LS.set("sd_drill", JSON.stringify(meta));
  show("student"); pill(kindName(att.kind).toUpperCase()); drawDrill();
}
async function reloadDrillItems() {
  const D = S.drill, r = await sb.rpc("drill_items", { p_attempt: D.att });
  if (!r.error && r.data) D.items = r.data;
}
function drawDrill() {
  const D = S.drill; if (!D) return;
  const n = D.items.length, quiz = D.kind === "quiz";
  let h;
  if (!n) h = `<div class="center"><div class="big">📭</div><h2 class="title sm">No words</h2><p class="sub">The teacher has not added any words yet.</p></div>`;
  else if (D.idx >= n) {
    const ok = D.items.filter(i => i.correct).length, hidden = D.items.every(i => i.correct == null);
    const missed = D.items.filter(i => i.correct === false);
    h = `<div class="center"><div class="big">${quiz ? "📝" : "🎉"}</div><h2 class="title sm">${quiz ? "Quiz finished" : "Practice finished"}</h2>
      ${hidden ? `<p class="sub">Your answers were sent to your teacher, ${esc(D.meta.name)}.</p>` : `<p class="sub">${esc(D.meta.name)}, you scored<br><b style="font-size:44px;color:var(--navy)">${ok} / ${n}</b></p>`}</div>
      ${!quiz && missed.length ? `<div class="card" style="margin-bottom:18px"><b>Words to review</b>${missed.map(i => `<p style="margin:8px 0 0">${esc(i.word)} <small>(you typed: ${esc(i.given)})</small></p>`).join("")}</div>` : ""}
      ${quiz ? "" : `<button class="btn" data-act="drillAgain">Practice again (new random words)</button>`}`;
  } else {
    const it = D.items[D.idx], fb = D.fb, last = D.idx === n - 1;
    h = `<p class="sub" style="margin-bottom:8px">${kindName(D.kind)} · ${esc(D.title)}</p>
      <div class="dbar"><i style="width:${Math.round(D.idx / n * 100)}%"></i></div>
      <p class="sub" style="margin:8px 0 14px">Word ${D.idx + 1} of ${n}</p>
      <div class="wordcard"><button class="btn" data-act="drillSpeak">🔊 AI Master</button><p id="defText"${D.shown[it.word_id] ? "" : " hidden"}>${esc(it.definition)}</p>
        <p class="sub" style="font-size:16px;margin:12px 0 0">Press AI Master to see and hear the definition and a sentence. You can press it again to repeat.</p></div>
      ${fb ? `<div class="card center" style="margin-bottom:16px"><div class="big" style="font-size:56px">${fb.ok ? "✅" : "❌"}</div><h3>${fb.ok ? "Correct!" : "Not quite"}</h3>${fb.ok ? "" : `<p>You typed: <b>${esc(fb.given)}</b></p>`}<p>The word is <b>${esc(fb.word)}</b></p></div>
        <button class="btn" data-act="drillNext">${last ? "See results" : "Next word"}</button>`
        : `<input id="ans" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Type the word" onpaste="return false"><button class="btn" data-act="submit">${quiz && last ? "Submit and finish" : "Submit answer"}</button>`}`;
  }
  $("#student").innerHTML = h;
  $("#ans")?.focus();
}
async function drillSubmit() {
  const D = S.drill, it = D?.items[D.idx], v = val("ans");
  if (!it || D.busy) return;
  if (!v) return toast("Type your answer first.");
  D.busy = true;
  const r = await sb.rpc("drill_answer", { p_attempt: D.att, p_word_id: it.word_id, p_answer: v });
  D.busy = false;
  if (r.error) return toast(r.error.message);
  it.given = v;
  if (D.kind === "practice") {
    it.correct = r.data.correct;
    D.fb = { ok: r.data.correct, word: r.data.word, given: v };
  } else {
    D.idx++;
    if (D.idx >= D.items.length) await reloadDrillItems();
  }
  drawDrill();
}

/* ---------- student UI ---------- */
let VOICE = null;
function pickVoice() {
  const v = speechSynthesis.getVoices().filter(x => /^en([-_]|$)/i.test(x.lang));
  const local = v.filter(x => x.localService);          // on-device voices work even with a weak connection
  const pool = local.length ? local : v;
  VOICE = pool.find(x => /aria|jenny|zira|samantha|libby|sonia|hazel|susan|karen|moira|tessa|female|google us english/i.test(x.name))
    || pool.find(x => /^en[-_]US/i.test(x.lang)) || pool[0] || null;
}
if (TTS) { speechSynthesis.onvoiceschanged = pickVoice; pickVoice(); }
// Accepts one string or an array of short parts. Each part is its own utterance, because browsers
// silently drop or cut off long utterances. Everything is queued inside the tap, which phones require.
function say(parts) {
  if (!TTS) return toast("This browser cannot read aloud.");
  const list = (Array.isArray(parts) ? parts : [parts]).filter(Boolean);
  if (!VOICE) pickVoice();
  const run = () => {
    speechSynthesis.resume();
    list.forEach(t => {
      const u = new SpeechSynthesisUtterance(t);
      u.lang = (VOICE && VOICE.lang ? VOICE.lang : "en-US").replace("_", "-");
      if (VOICE) u.voice = VOICE;
      u.rate = .85; u.pitch = 1.05; u.volume = 1;
      u.onerror = e => { if (!["canceled", "interrupted"].includes(e.error)) toast("Could not play the audio (" + e.error + "). Check the volume and try again."); };
      speechSynthesis.speak(u);
    });
  };
  // Chrome drops a speak() that comes straight after cancel(), so only cancel (and wait a moment) if something is playing.
  if (speechSynthesis.speaking || speechSynthesis.pending) { speechSynthesis.cancel(); setTimeout(run, 150); } else run();
}
const script = m => {
  const def = (m.definition || "").trim().replace(/^\(([^)]+)\)\s*/, "$1: ").replace(/[.!?]+$/, "");
  const ex = (m.example || "").trim();
  return [`The word is ${m.word}.`, def && `${def}.`, ex && `Used in a sentence: ${ex}`, `Again, the word is ${m.word}.`].filter(Boolean);
};
function speak() {
  const m = S.cur; if (!m) return;
  if (!m.word || !m.definition) {
    toast(S.secErr ? "Could not load your word: " + S.secErr + " (the teacher must run the SQL fix in Supabase)." : "AI Master is still getting your word. Try again in a moment.");
    refresh(); return;
  }
  say(script(m));
}
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
    <div class="wordcard"><button class="btn" data-act="speak">🔊 AI Master</button><p>${esc(m.definition)}</p><p class="sub" style="font-size:16px;margin:12px 0 0">Press AI Master to hear the word, its definition and a sentence. You can press it again to repeat.</p></div>
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
  reportEvent({ contest_id: S.contest.id, contestant_id: S.me, reason, severity: strict ? "dq" : "warning" });
  render();
}
// keepalive lets the request finish even while the phone is sending the browser to the background;
// if it still fails, the event is kept on the device and re-sent when the student returns.
function reportEvent(ev) {
  LS.set("sd_unsent", JSON.stringify(ev));
  if (!S.token) return;
  fetch(`${CFG.SUPABASE_URL}/rest/v1/security_events`, {
    method: "POST", keepalive: true,
    headers: { apikey: CFG.SUPABASE_ANON_KEY, Authorization: "Bearer " + S.token, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify(ev)
  }).then(r => { if (r.ok) LS.del("sd_unsent"); }).catch(() => { });
}
function flush() {
  const ev = JSON.parse(LS.get("sd_unsent") || "null"); if (!ev) return;
  sb.from("security_events").insert(ev).then(({ error }) => { if (!error) LS.del("sd_unsent"); });
}
window.addEventListener("online", flush);
document.addEventListener("visibilitychange", () => { if (document.hidden) violation("The contest tab was hidden."); else flush(); });
window.addEventListener("blur", () => setTimeout(() => !document.hasFocus() && violation("The contest window lost focus."), 400));

/* ---------- projector UI (brackets only: no words, no voice) ---------- */
function projectorHtml() {
  const c = S.contest, champ = S.people.find(p => p.status === "champion");
  const alive = S.people.filter(p => p.status === "active").length;
  return `<div class="proj"><div class="ph"><div><h3 style="font-size:40px">${esc(c.name)}</h3><span class="sub" style="margin:0">${champ ? "🏆 Champion: " + esc(champ.name) : alive + " in the running"}</span></div>
    <div class="center"><span class="sub" style="margin:0">Contest code</span><div class="code">${esc(c.code)}</div></div>
    <button class="btn ghost" data-act="full">Fullscreen (F)</button></div>${bracketsHtml()}</div>`;
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
    if (error || !data?.results) {
      S.aiDown = true;
      try { S.aiErr = (await error.context.json()).error; } catch { S.aiErr = error?.message || data?.error || "no reply"; }
      continue;
    }
    data.results.forEach(r => { if (r.definition) out[norm(r.word)] = r; });
  }
  return out;
}
// Reads the "one word per line / comma" box, asks AI Master (then the free dictionary) for definitions + examples.
async function collectWords(inputId, existing, base) {
  const lines = val(inputId).split("\n").flatMap(l => l.includes("|") ? [l] : l.split(","));
  const items = lines.map(x => x.trim()).filter(Boolean);
  if (!items.length) { toast("Type a word first."); return null; }
  const have = new Set(existing.map(w => norm(w.word))), rows = [], nf = [], noEx = [];
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
    rows.push({ ...base, word, definition: def, example: ex });
  }
  return { rows, notes: [S.aiDown && `AI Master is unavailable (${S.aiErr}), so the dictionary was used.`, nf.length && `No dictionary entry: ${nf.join(", ")}.`, noEx.length && `No example sentence: ${noEx.join(", ")} (use Edit).`].filter(Boolean) };
}
const genCode = () => Array.from({ length: 6 }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[Math.floor(Math.random() * 32)]).join("");
const act = {
  async teacherLogin() {
    const { data, error } = await sb.auth.signInWithPassword({ email: val("tEmail"), password: $("#tPass").value });
    if (error) return toast("Sign-in failed: " + error.message);
    if (data.user.is_anonymous) return toast("This is not a teacher account.");
    loadTeacherContest();
  },
  async logout() {
    const quizOn = S.role === "drill" && S.drill?.kind === "quiz" && S.drill.idx < S.drill.items.length;
    if ((S.role === "student" || quizOn) && !S.armed) {          // two taps, no popup (a popup would count as leaving the screen)
      S.armed = true; setTimeout(() => S.armed = false, 4000);
      return toast(quizOn ? "Tap Log out again to confirm. Your quiz is not finished." : "Tap Log out again to confirm. You may not be able to rejoin once the contest has started.");
    }
    S.armed = false; LS.del("sd_me"); LS.del("sd_unsent"); LS.del("sd_drill");
    await sb.auth.signOut(); go("landing");
  },
  async join() {
    const code = val("sCode").toUpperCase(), name = val("sName");
    if (!code || !name) return toast("Enter the contest code and your name.");
    let { data: { session } } = await sb.auth.getSession();
    if (!session) { const r = await sb.auth.signInAnonymously(); if (r.error) return toast("Could not start a student session. Is anonymous sign-in enabled?"); session = r.data.session; }
    const { data: c } = await sb.from("contests").select("*").eq("code", code).maybeSingle();
    if (!c) return joinDrill(code, name);
    let { data: p, error } = await sb.from("contestants").insert({ contest_id: c.id, name, student_no: val("sNo") }).select().single();
    if (error) {
      const r = await sb.from("contestants").select("*").eq("contest_id", c.id).eq("user_id", session.user.id).maybeSingle();
      if (!r.data) return toast(c.status !== "lobby" ? "This contest has already started." : "The contest is full.");
      p = r.data;
    }
    LS.set("sd_me", JSON.stringify({ contest: c.id, id: p.id })); LS.del("sd_drill");
    leave(); Object.assign(S, { role: "student", contest: c, me: p.id }); show("student"); subscribe(); doRefresh();
  },
  tab(d) { S.tab = d.id; S.creating = false; renderTeacher(); if (d.id === "drills") reloadDrills(); },
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
  async addWords() {
    const r = await collectWords("wBulk", S.words, { contest_id: S.contest.id }); if (!r) return;
    if (r.rows.length) {
      const { error } = await sb.from("words").insert(r.rows);
      if (error) return toast(error.message);
      $("#wBulk").value = "";
    }
    toast([`${r.rows.length} word(s) added.`, ...r.notes].filter(Boolean).join(" "));
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
  startAll,
  async force(d) { const m = S.matches.find(x => x.id === d.id), w = m[d.w]; await finish(m, w, d.w === "p1" ? m.p2 : m.p1); refresh(); },
  speak,
  drillSpeak() {
    const D = S.drill, it = D?.items[D.idx]; if (!it) return;
    D.shown[it.word_id] = true;
    const p = $("#defText"); if (p) p.hidden = false;       // the definition appears; the example sentence is voice-only
    say(script(it));
  },
  drillNext() { const D = S.drill; if (!D) return; D.fb = null; D.idx++; drawDrill(); },
  async drillAgain() {
    const M = S.drill?.meta; if (!M) return;
    const r = await sb.rpc("drill_join", { p_code: M.code, p_name: M.name, p_no: M.no, p_restart: true });
    if (r.error) return toast(r.error.message);
    await openDrillAttempt(r.data, M);
  },
  async createDrill() {
    const name = val("dName"), kind = $("#dKind").value, n = parseInt(val("dCount"), 10);
    if (!name) return toast("Enter a name.");
    if (!n || n < 1) return toast("Enter how many words each student gets.");
    let res;
    for (let i = 0; i < 3; i++) {                                   // retry in the unlikely case of a duplicate code
      res = await sb.from("drills").insert({ name, kind, item_count: n, code: genCode() }).select().single();
      if (!res.error || res.error.code !== "23505") break;
    }
    if (res.error) return toast("Could not create: " + res.error.message);
    S.drillSel = res.data.id; await reloadDrills(); toast(`${kindName(kind)} created. Now add its words.`);
  },
  openDrill(d) { S.drillSel = d.id; reloadDrills(); },
  backDrills() { S.drillSel = null; reloadDrills(); },
  async setDrillCount() {
    const n = parseInt(val("dCountIn"), 10); if (!n || n < 1) return toast("Enter a number of 1 or more.");
    const { error } = await sb.from("drills").update({ item_count: n }).eq("id", S.drillSel);
    if (error) return toast(error.message);
    toast("Updated. Students who already joined keep their words."); reloadDrills();
  },
  async toggleDrill() {
    const d = curDrill(); if (!d) return;
    const { error } = await sb.from("drills").update({ status: d.status === "open" ? "closed" : "open" }).eq("id", d.id);
    if (error) return toast(error.message);
    reloadDrills();
  },
  async delDrill() {
    const d = curDrill(); if (!d || !confirm(`Delete "${d.name}" and all its results?`)) return;
    const { error } = await sb.from("drills").delete().eq("id", d.id);
    if (error) return toast(error.message);
    S.drillSel = null; reloadDrills();
  },
  copyDrill() { const d = curDrill(); if (d) { navigator.clipboard.writeText(d.code); toast("Code copied."); } },
  async dAddWords() {
    const d = curDrill(); if (!d) return;
    const r = await collectWords("dBulk", S.dWords, { drill_id: d.id }); if (!r) return;
    if (r.rows.length) {
      const { error } = await sb.from("drill_words").insert(r.rows);
      if (error) return toast(error.message);
      $("#dBulk").value = "";
    }
    toast([`${r.rows.length} word(s) added.`, ...r.notes].filter(Boolean).join(" "));
    reloadDrills();
  },
  async dImport() {
    const d = curDrill(); if (!d) return;
    const have = new Set(S.dWords.map(w => norm(w.word)));
    const rows = S.words.filter(w => !have.has(norm(w.word))).map(w => ({ drill_id: d.id, word: w.word, definition: w.definition, example: w.example }));
    if (!rows.length) return toast("Nothing new to import.");
    const { error } = await sb.from("drill_words").insert(rows);
    if (error) return toast(error.message);
    toast(`${rows.length} word(s) imported.`); reloadDrills();
  },
  async dEditWord(d) {
    const w = S.dWords.find(x => x.id === d.id); if (!w) return;
    const def = prompt("Definition", w.definition); if (def === null) return;
    const ex = prompt("Example sentence", w.example || ""); if (ex === null) return;
    await sb.from("drill_words").update({ definition: def.trim(), example: ex.trim() }).eq("id", w.id);
    reloadDrills();
  },
  async dDelWord(d) { await sb.from("drill_words").delete().eq("id", d.id); reloadDrills(); },
  dSayWord(d) { const w = S.dWords.find(x => x.id === d.id); if (w) say(script(w)); },
  async dDelAttempt(d) { await sb.from("drill_attempts").delete().eq("id", d.id); reloadDrills(); },
  sayWord(d) { const w = S.words.find(x => x.id === d.id); if (w) say(script(w)); },
  async submit() {
    if (S.role === "drill") return drillSubmit();
    const v = val("ans"), m = S.cur; if (!v || !m) return toast("Type your answer first.");
    const { error } = await sb.from("answers").insert({ contest_id: S.contest.id, match_id: m.id, contestant_id: S.me, attempt: m.attempt, answer: v });
    if (error) return toast("Could not send your answer. Try again.");
    S.sent = m.id + ":" + m.attempt; render();
  },
  full() { document.fullscreenElement ? document.exitFullscreen() : $("#teacher").requestFullscreen(); }
};
document.addEventListener("click", e => {
  const t = e.target.closest("[data-go],[data-act]"); if (!t) return;
  if (t.dataset.go) go(t.dataset.go); else act[t.dataset.act]?.(t.dataset);
});
document.addEventListener("keydown", e => {
  if (e.key === "Enter" && e.target.id === "ans") act.submit();
  if ((e.key === "f" || e.key === "F") && S.role === "teacher" && S.tab === "projector" && !/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) act.full();
});
setInterval(() => S.contest && doRefresh(), 8000);   // safety net if a realtime event is missed

/* ---------- start ---------- */
(async () => {
  if (CFG.SUPABASE_URL.includes("YOUR-PROJECT")) return toast("Add your Supabase URL and anon key to config.js.");
  const { data: { session } } = await sb.auth.getSession();
  if (session && !session.user.is_anonymous) return loadTeacherContest();
  const me = JSON.parse(LS.get("sd_me") || "null");
  if (session && me) {
    const { data: c } = await sb.from("contests").select("*").eq("id", me.contest).maybeSingle();
    if (c) { Object.assign(S, { role: "student", contest: c, me: me.id }); show("student"); subscribe(); doRefresh(); flush(); }
  } else if (session) {
    const dm = JSON.parse(LS.get("sd_drill") || "null");
    if (dm) {
      const r = await sb.rpc("drill_join", { p_code: dm.code, p_name: dm.name, p_no: dm.no, p_restart: false });
      if (!r.error) await openDrillAttempt(r.data, dm); else LS.del("sd_drill");
    }
  }
})();
