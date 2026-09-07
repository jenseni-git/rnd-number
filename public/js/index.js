// ---- CONFIG: point this at your deployed Worker ----
// const API_BASE = "http://127.0.0.1:8787"; // for local dev
const API_BASE = "https://rnd-number.jenseni.workers.dev"; // for production
// -----------------------------------------------------

const btnA = document.getElementById("btnA");
const btnB = document.getElementById("btnB");
const statusEl = document.getElementById("status");
const sessionCountEl = document.getElementById("sessionCount");

let currentToken = null;
let sessionCount = 0;
let turnstileToken = null;
let voteTimestamps = [];

function onTurnstileSuccess(token) {
  turnstileToken = token;
  if (statusEl.textContent === "Still verifying, one sec...") {
    statusEl.textContent = "";
  }
}

function getSessionId() {
  let id = localStorage.getItem("np_session_id");
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem("np_session_id", id);
  }
  return id;
}
const sessionId = getSessionId();

let errCount = 0;
async function loadPair() {
  statusEl.textContent = "";
  btnA.disabled = true;
  btnB.disabled = true;
  btnA.textContent = "...";
  btnB.textContent = "...";

  try {
    const res = await fetch(`${API_BASE}/pair`);
    if (!res.ok) throw new Error("failed to load pair");
    const data = await res.json();

    currentToken = data.token;
    btnA.textContent = data.numA;
    btnB.textContent = data.numB;
    btnA.disabled = false;
    btnB.disabled = false;
    errCount = 0;
  } catch (err) {
    if (errCount > 0) {
      statusEl.textContent =
        "Error loading numbers. Try contacting the site owner if this keeps happening.";
      setTimeout(loadPair, 2000);
    } else {
      statusEl.textContent = "Couldn't load a pair - retrying";
    }
    errCount += 1;
  }
}

async function vote(choice) {
  if (!currentToken) return;
  if (!turnstileToken) {
    statusEl.textContent = "Still verifying, one sec...";
    return;
  }

  const now = Date.now();
  voteTimestamps = voteTimestamps.filter((t) => now - t < 10000);

  if (voteTimestamps.length >= 10) {
    statusEl.textContent = "Slow down a sec...";
    btnA.disabled = true;
    btnB.disabled = true;
    setTimeout(() => {
      statusEl.textContent = "";
      btnA.disabled = false;
      btnB.disabled = false;
    }, 2000);
    return;
  }

  voteTimestamps.push(now);

  btnA.disabled = true;
  btnB.disabled = true;

  try {
    const res = await fetch(`${API_BASE}/vote`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: currentToken,
        choice,
        session_id: sessionId,
        turnstile_token: turnstileToken,
      }),
    });

    if (res.status === 409) {
      statusEl.textContent = "Pair expired, loading a new one.";
    } else if (res.status === 403) {
      statusEl.textContent = "Verification failed, retrying...";
    } else if (res.status === 429) {
      statusEl.textContent = "Slow down a sec...";
    } else if (!res.ok) {
      throw new Error("vote failed");
    } else {
      sessionCount += 1;
      sessionCountEl.textContent = sessionCount;
    }
  } catch (err) {
    statusEl.textContent = "Vote failed. Please try again.";
  }

  turnstileToken = null;
  if (window.turnstile) {
    turnstile.execute(".cf-turnstile");
  }

  loadPair();
}

btnA.addEventListener("click", () => vote(1));
btnB.addEventListener("click", () => vote(2));

window.onloadTurnstileCallback = function () {
  turnstile.execute(".cf-turnstile");
};

loadPair();
