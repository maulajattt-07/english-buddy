/* English Buddy — daily spoken-English practice.
   Runs entirely in the browser: Web Speech API for mic input + voice
   output, Puter.js (free, no API key) for the AI conversation and the
   end-of-session corrections. Everything you say is saved only on this
   phone, in localStorage. */
(function () {
  "use strict";

  // ---------------------------------------------------------------
  // small helpers
  // ---------------------------------------------------------------
  const $ = (id) => document.getElementById(id);
  const HISTORY_KEY = "eb_history_v1";
  const SETTINGS_KEY = "eb_settings_v1";

  function todayKey(d) {
    d = d || new Date();
    const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, "0"), day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }
  function prettyDate(key) {
    const [y, m, d] = key.split("-").map(Number);
    const dt = new Date(y, m - 1, d);
    return dt.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
  }
  function loadHistory() {
    try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || "{}"); } catch (e) { return {}; }
  }
  function saveHistory(h) {
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(h)); } catch (e) {}
  }
  function loadSettings() {
    try { return Object.assign({ rate: 0.95, voiceName: "", autoListen: true }, JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}")); }
    catch (e) { return { rate: 0.95, voiceName: "", autoListen: true }; }
  }
  function saveSettings(s) {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch (e) {}
  }
  function computeStreak(history) {
    const keys = Object.keys(history);
    if (!keys.length) return 0;
    const now = new Date();
    let cursor;
    if (history[todayKey(now)]) cursor = now;
    else {
      const y = new Date(now.getTime() - 86400000);
      if (history[todayKey(y)]) cursor = y;
      else return 0;
    }
    let streak = 0;
    while (history[todayKey(cursor)]) {
      streak++;
      cursor = new Date(cursor.getTime() - 86400000);
    }
    return streak;
  }
  function escapeHtml(s) {
    return (s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  let toastTimer = null;
  function toast(msg) {
    const t = $("toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("show"), 3200);
  }

  // ---------------------------------------------------------------
  // state
  // ---------------------------------------------------------------
  let settings = loadSettings();
  let history = loadHistory();
  let conversation = []; // {role:'user'|'assistant', content}
  let voices = [];
  let isListening = false;
  let isThinking = false;
  let aiReady = typeof window.puter !== "undefined" && window.puter.ai;

  // ---------------------------------------------------------------
  // views / nav
  // ---------------------------------------------------------------
  function showView(name) {
    document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
    $("view-" + name).classList.add("active");
  }
  $("historyBtn").addEventListener("click", () => { renderHistory(); showView("history"); });
  $("historyBackBtn").addEventListener("click", () => showView("chat"));
  $("settingsBtn").addEventListener("click", () => showView("settings"));
  $("settingsBackBtn").addEventListener("click", () => showView("chat"));
  $("reviewBackBtn").addEventListener("click", () => showView("chat"));

  // ---------------------------------------------------------------
  // header streak line
  // ---------------------------------------------------------------
  function refreshStreakLine() {
    const n = computeStreak(history);
    $("streakLine").textContent = n > 0 ? `🔥 ${n}-day streak` : "Tap the mic and say hello";
  }

  // ---------------------------------------------------------------
  // speech synthesis (AI voice output)
  // ---------------------------------------------------------------
  function loadVoices() {
    voices = (window.speechSynthesis && speechSynthesis.getVoices()) || [];
    const sel = $("voiceSelect");
    const english = voices.filter((v) => /^en/i.test(v.lang));
    const list = english.length ? english : voices;
    sel.innerHTML = "";
    list.forEach((v) => {
      const opt = document.createElement("option");
      opt.value = v.name;
      opt.textContent = `${v.name} (${v.lang})`;
      sel.appendChild(opt);
    });
    if (settings.voiceName && list.some((v) => v.name === settings.voiceName)) {
      sel.value = settings.voiceName;
    } else if (list.length) {
      settings.voiceName = list[0].name;
      saveSettings(settings);
      sel.value = settings.voiceName;
    }
  }
  if (window.speechSynthesis) {
    speechSynthesis.onvoiceschanged = loadVoices;
    loadVoices();
  }

  function speak(text, onDone) {
    if (!window.speechSynthesis) { if (onDone) onDone(); return; }
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    const chosen = voices.find((v) => v.name === settings.voiceName);
    if (chosen) u.voice = chosen;
    u.rate = Number(settings.rate) || 0.95;
    u.lang = (chosen && chosen.lang) || "en-US";
    u.onend = () => { if (onDone) onDone(); };
    u.onerror = () => { if (onDone) onDone(); };
    speechSynthesis.speak(u);
  }

  $("voiceSelect").addEventListener("change", (e) => {
    settings.voiceName = e.target.value;
    saveSettings(settings);
  });
  $("rateRange").addEventListener("input", (e) => {
    settings.rate = Number(e.target.value);
    saveSettings(settings);
  });
  $("autoListen").addEventListener("change", (e) => {
    settings.autoListen = e.target.checked;
    saveSettings(settings);
  });
  $("rateRange").value = settings.rate;
  $("autoListen").checked = settings.autoListen !== false;

  // ---------------------------------------------------------------
  // speech recognition (mic input)
  // ---------------------------------------------------------------
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let recog = null;
  let micArmedByUser = false; // true once the user has tapped mic at least once (permission context)

  if (SR) {
    recog = new SR();
    recog.lang = "en-US";
    recog.continuous = false;
    recog.interimResults = false;
    recog.maxAlternatives = 1;

    recog.onresult = (e) => {
      const transcript = e.results[0][0].transcript.trim();
      setListening(false);
      if (transcript) handleUserTurn(transcript);
    };
    recog.onerror = (e) => {
      setListening(false);
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        toast("Microphone access was blocked — you can type instead.");
        settings.autoListen = false;
        $("autoListen").checked = false;
        saveSettings(settings);
        openTypeBar();
      } else if (e.error === "no-speech") {
        setStatus("Didn't catch that — tap the mic to try again.");
      } else if (e.error !== "aborted") {
        toast("Mic error: " + e.error);
      }
    };
    recog.onend = () => setListening(false);
  }

  function setStatus(text, mode) {
    const el = $("statusStrip");
    el.textContent = text;
    el.className = mode || "";
  }

  function setListening(on) {
    isListening = on;
    $("micBtn").classList.toggle("listening", on);
    if (on) setStatus("Listening…", "listening");
    else if (!isThinking) setStatus("Tap the mic to begin");
  }

  function setThinking(on) {
    isThinking = on;
    $("micBtn").classList.toggle("thinking", on);
    $("micBtn").disabled = on;
    $("endBtn").disabled = on;
    if (on) setStatus("Thinking…");
    else setStatus("Tap the mic to begin");
  }

  function startListening() {
    if (!recog) { toast("Your browser doesn't support voice input — type instead."); openTypeBar(); return; }
    if (isListening || isThinking) return;
    micArmedByUser = true;
    try {
      recog.start();
      setListening(true);
    } catch (e) {
      // already started — ignore
    }
  }
  function stopListening() {
    if (recog && isListening) { try { recog.stop(); } catch (e) {} }
  }

  $("micBtn").addEventListener("click", () => {
    if (isThinking) return;
    if (isListening) stopListening();
    else startListening();
  });

  // ---------------------------------------------------------------
  // type-instead fallback
  // ---------------------------------------------------------------
  function openTypeBar() {
    $("typeBar").classList.add("active");
    $("typeInput").focus();
  }
  function closeTypeBar() {
    $("typeBar").classList.remove("active");
  }
  $("typeBtn").addEventListener("click", () => {
    $("typeBar").classList.contains("active") ? closeTypeBar() : openTypeBar();
  });
  function sendTyped() {
    const v = $("typeInput").value.trim();
    if (!v) return;
    $("typeInput").value = "";
    handleUserTurn(v);
  }
  $("typeSend").addEventListener("click", sendTyped);
  $("typeInput").addEventListener("keydown", (e) => { if (e.key === "Enter") sendTyped(); });

  // ---------------------------------------------------------------
  // starter chips
  // ---------------------------------------------------------------
  document.querySelectorAll(".starter-chip").forEach((btn) => {
    btn.addEventListener("click", () => handleUserTurn(btn.dataset.starter));
  });

  // ---------------------------------------------------------------
  // chat rendering
  // ---------------------------------------------------------------
  function clearEmptyState() {
    const e = $("emptyState");
    if (e) e.remove();
  }
  function addBubble(role, text) {
    clearEmptyState();
    const row = document.createElement("div");
    row.className = "bubble-row " + (role === "user" ? "user" : "ai");
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.textContent = text;
    row.appendChild(bubble);
    if (role === "assistant") {
      const btn = document.createElement("button");
      btn.className = "replay-btn";
      btn.textContent = "🔊";
      btn.setAttribute("aria-label", "Replay");
      btn.addEventListener("click", () => speak(text));
      row.appendChild(btn);
    }
    $("chatLog").appendChild(row);
    $("chatLog").scrollTop = $("chatLog").scrollHeight;
  }

  // ---------------------------------------------------------------
  // AI call helpers
  // ---------------------------------------------------------------
  function extractText(res) {
    if (!res) return "";
    if (typeof res === "string") return res;
    if (res.message && res.message.content) {
      const c = res.message.content;
      if (typeof c === "string") return c;
      if (Array.isArray(c)) return c.map((p) => (p && p.text) || "").join(" ").trim();
    }
    if (typeof res.text === "string") return res.text;
    try {
      const s = String(res);
      if (s && s !== "[object Object]") return s;
    } catch (e) {}
    return "";
  }

  const SYSTEM_PROMPT =
    "You are a warm, encouraging English conversation partner. You're chatting by voice with a non-native speaker who wants daily practice. " +
    "Keep the conversation natural and engaging: ask follow-up questions, react genuinely, share short opinions. " +
    "Keep every reply short — 2 to 4 sentences — since it will be read aloud. " +
    "IMPORTANT: do not correct grammar or vocabulary mistakes during the conversation, and do not mention that you're avoiding corrections. Just respond naturally, like a friendly native-speaker friend. Corrections happen separately, later.";

  async function handleUserTurn(text) {
    if (!text) return;
    stopListening();
    closeTypeBar();
    addBubble("user", text);
    conversation.push({ role: "user", content: text });

    if (!aiReady) {
      toast("AI isn't available right now — check your internet connection.");
      return;
    }

    setThinking(true);
    try {
      const messages = [{ role: "system", content: SYSTEM_PROMPT }, ...conversation];
      const res = await window.puter.ai.chat(messages);
      const reply = extractText(res) || "Sorry, I didn't quite get a reply there — could you say that again?";
      conversation.push({ role: "assistant", content: reply });
      addBubble("assistant", reply);
      setThinking(false);
      speak(reply, () => {
        if (settings.autoListen !== false && micArmedByUser) startListening();
      });
    } catch (err) {
      setThinking(false);
      toast("Couldn't reach the AI — try again in a moment.");
    }
  }

  // ---------------------------------------------------------------
  // finish & review
  // ---------------------------------------------------------------
  function buildTranscript() {
    return conversation
      .map((m) => (m.role === "user" ? "Learner: " : "Buddy: ") + m.content)
      .join("\n");
  }

  const CORRECTIONS_PROMPT_HEAD =
    'You are a kind, encouraging English tutor. Below is a transcript of a spoken English practice conversation. ' +
    'Look ONLY at the lines starting with "Learner:" and find real grammar, vocabulary, word-choice, or phrasing mistakes. Ignore the "Buddy:" lines completely — those are not the learner\'s words. Ignore minor things like missing punctuation from speech-to-text.\n\n' +
    "For each mistake, output exactly this block format, one after another, nothing else:\n" +
    "WRONG: <what they said>\nRIGHT: <corrected version>\nWHY: <one short, simple sentence explaining the fix>\n\n" +
    "If there are truly no worthwhile mistakes, output exactly:\nNONE: Great job — no mistakes worth flagging today!\n\nTranscript:\n";

  function parseCorrections(text) {
    if (/^\s*NONE:/i.test(text)) {
      return { none: true, message: text.replace(/^\s*NONE:\s*/i, "").trim() || "Great job — no mistakes worth flagging today!" };
    }
    const items = [];
    const blocks = text.split(/\n(?=WRONG:)/i).filter((b) => /WRONG:/i.test(b));
    for (const b of blocks) {
      const wrongM = b.match(/WRONG:\s*([\s\S]*?)(?=\n?RIGHT:|$)/i);
      const rightM = b.match(/RIGHT:\s*([\s\S]*?)(?=\n?WHY:|$)/i);
      const whyM = b.match(/WHY:\s*([\s\S]*)/i);
      if (wrongM && wrongM[1].trim()) {
        items.push({
          wrong: wrongM[1].trim(),
          right: (rightM && rightM[1].trim()) || "",
          why: (whyM && whyM[1].trim()) || "",
        });
      }
    }
    return { none: false, items, raw: text };
  }

  function renderReview(parsed) {
    const body = $("reviewBody");
    body.innerHTML = "";
    if (parsed.none) {
      const card = document.createElement("div");
      card.className = "card";
      card.innerHTML = `<h3>✅ Nice work</h3><p style="margin:0;font-size:.88rem;color:var(--muted);">${escapeHtml(parsed.message)}</p>`;
      body.appendChild(card);
      return;
    }
    if (!parsed.items.length) {
      const card = document.createElement("div");
      card.className = "card";
      card.innerHTML = `<h3>Corrections</h3><p style="margin:0;font-size:.85rem;white-space:pre-wrap;">${escapeHtml(parsed.raw || "")}</p>`;
      body.appendChild(card);
      return;
    }
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `<h3>${parsed.items.length} thing${parsed.items.length > 1 ? "s" : ""} to fix</h3>`;
    parsed.items.forEach((it) => {
      const div = document.createElement("div");
      div.className = "corr-item";
      div.innerHTML =
        `<div class="wrong">${escapeHtml(it.wrong)}</div>` +
        `<div class="right">→ ${escapeHtml(it.right)}</div>` +
        (it.why ? `<div class="why">${escapeHtml(it.why)}</div>` : "");
      card.appendChild(div);
    });
    body.appendChild(card);
  }

  $("endBtn").addEventListener("click", finishAndReview);

  async function finishAndReview() {
    const userTurns = conversation.filter((m) => m.role === "user");
    if (!userTurns.length) { toast("Have a short chat first, then finish to see corrections."); return; }
    stopListening();
    if (window.speechSynthesis) speechSynthesis.cancel();

    if (!aiReady) { toast("AI isn't available right now — check your internet connection."); return; }

    setThinking(true);
    setStatus("Preparing your corrections…");
    try {
      const prompt = CORRECTIONS_PROMPT_HEAD + buildTranscript();
      const res = await window.puter.ai.chat(prompt);
      const text = extractText(res) || "NONE: Couldn't generate corrections this time — but great job practicing today!";
      const parsed = parseCorrections(text);
      renderReview(parsed);

      // save to history (append as a session for today)
      const key = todayKey();
      if (!history[key]) history[key] = { sessions: [] };
      history[key].sessions.push({
        time: Date.now(),
        messages: conversation.slice(),
        correctionsRaw: text,
      });
      saveHistory(history);
      refreshStreakLine();

      setThinking(false);
      showView("review");

      // reset chat for next session
      conversation = [];
      resetChatLogUI();
    } catch (err) {
      setThinking(false);
      toast("Couldn't reach the AI to prepare corrections — try again shortly.");
    }
  }

  // rebuild the empty-state block (with working starter chips) after a
  // finished session, since the log was cleared out during the chat
  const EMPTY_STATE_HTML = $("emptyState") ? $("emptyState").outerHTML : "";
  function resetChatLogUI() {
    $("chatLog").innerHTML = EMPTY_STATE_HTML;
    document.querySelectorAll(".starter-chip").forEach((btn) => {
      btn.addEventListener("click", () => handleUserTurn(btn.dataset.starter));
    });
  }

  // ---------------------------------------------------------------
  // history view
  // ---------------------------------------------------------------
  function renderHistory() {
    const body = $("historyBody");
    body.innerHTML = "";
    const keys = Object.keys(history).sort().reverse();
    if (!keys.length) {
      body.innerHTML = '<div class="empty-small">No practice sessions yet — have your first chat!</div>';
      return;
    }
    keys.forEach((key) => {
      const day = history[key];
      const details = document.createElement("details");
      details.className = "card day-card";
      const totalUserTurns = day.sessions.reduce((n, s) => n + s.messages.filter((m) => m.role === "user").length, 0);
      const summary = document.createElement("summary");
      summary.innerHTML = `<span>${prettyDate(key)}</span><span class="meta">${day.sessions.length} session${day.sessions.length > 1 ? "s" : ""} · ${totalUserTurns} turns</span>`;
      details.appendChild(summary);
      day.sessions.forEach((s, i) => {
        const parsed = parseCorrections(s.correctionsRaw || "");
        const wrap = document.createElement("div");
        wrap.style.marginTop = "0.6rem";
        let html = `<div style="font-size:.78rem;font-weight:600;color:var(--muted);">Session ${i + 1} — ${new Date(s.time).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}</div>`;
        if (parsed.none) {
          html += `<div class="corr-item"><div class="right">✅ ${escapeHtml(parsed.message)}</div></div>`;
        } else if (parsed.items && parsed.items.length) {
          parsed.items.forEach((it) => {
            html += `<div class="corr-item"><div class="wrong">${escapeHtml(it.wrong)}</div><div class="right">→ ${escapeHtml(it.right)}</div>${it.why ? `<div class="why">${escapeHtml(it.why)}</div>` : ""}</div>`;
          });
        }
        wrap.innerHTML = html;
        details.appendChild(wrap);
      });
      body.appendChild(details);
    });
  }

  // ---------------------------------------------------------------
  // settings: reset
  // ---------------------------------------------------------------
  $("resetBtn").addEventListener("click", () => {
    if (!confirm("Delete all saved conversations and your streak? This can't be undone.")) return;
    history = {};
    saveHistory(history);
    refreshStreakLine();
    toast("All data cleared.");
  });

  // ---------------------------------------------------------------
  // init
  // ---------------------------------------------------------------
  refreshStreakLine();
  if (!SR) {
    toast("Voice input isn't supported in this browser — you can type instead.");
    openTypeBar();
  }
  if (!aiReady) {
    // puter.js loads asynchronously; re-check shortly after page load
    setTimeout(() => {
      aiReady = typeof window.puter !== "undefined" && window.puter.ai;
      if (!aiReady) toast("Couldn't load the AI service — check your internet and reload.");
    }, 1500);
  }

  // service worker
  if ("serviceWorker" in navigator && location.protocol === "https:") {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js").catch(() => {});
    });
  }
})();
