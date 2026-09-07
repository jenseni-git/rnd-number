/**
 * Number Picker API - Cloudflare Worker
 *
 * Endpoints:
 *   GET  /pair    -> { numA, numB, token, expires }
 *   POST /vote    -> { ok: true }  body: { token, choice, session_id }
 *
 * The server generates every pair and signs it with an HMAC token.
 * /vote only accepts choices tied to a token it actually issued,
 * that hasn't expired and hasn't already been redeemed.
 */

const encoder = new TextEncoder();

// ---- CORS -------------------------------------------------------------

function corsHeaders(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function json(data, status, env) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(env),
    },
  });
}

// ---- Crypto helpers -----------------------------------------------------

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

function toBase64Url(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function signPayload(payload, secret) {
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return toBase64Url(sig);
}

async function verifyToken(token, secret) {
  // token format: base64url(payload) + "." + base64url(signature)
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payloadB64, sig] = parts;

  const payload = atob(payloadB64.replace(/-/g, "+").replace(/_/g, "/"));
  const expectedSig = await signPayload(payload, secret);

  if (expectedSig !== sig) return null; // tampered or wrong secret

  const [numAStr, numBStr, expiryStr, nonce] = payload.split(":");
  const expiry = parseInt(expiryStr, 10);
  if (Date.now() > expiry) return null; // expired

  return {
    numA: parseInt(numAStr, 10),
    numB: parseInt(numBStr, 10),
    nonce,
  };
}

// ---- IP hashing (no raw IPs stored) -------------------------------------

async function hashIp(ip, secret) {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(ip + secret)
  );
  return toBase64Url(buf);
}

// ---- Route handlers -------------------------------------------------------

async function checkRateLimit(ip, env, ctx) {
  const key = `rl:${ip}`;
  const current = await env.RATE_LIMIT_KV.get(key);
  const count = current ? parseInt(current, 10) : 0;

  if (count >= 60) return false; // 60 requests/minute cap

  ctx.waitUntil(
    env.RATE_LIMIT_KV.put(key, String(count + 1), { expirationTtl: 60 })
  );
  return true;
}

async function checkBurstLimit(sessionId, env, ctx) {
  const key = `burst:${sessionId}`;
  const current = await env.RATE_LIMIT_KV.get(key);
  const count = current ? parseInt(current, 10) : 0;

  if (count >= 10) return false; // 10 votes / 10 seconds per session

  ctx.waitUntil(
    env.RATE_LIMIT_KV.put(key, String(count + 1), { expirationTtl: 10 })
  );
  return true;
}


// ---- Turnstile server-side verification ----------------------------------

async function verifyTurnstile(turnstileToken, ip, env) {
  if (!turnstileToken) return false;

  const formData = new FormData();
  formData.append("secret", env.TURNSTILE_SECRET_KEY);
  formData.append("response", turnstileToken);
  formData.append("remoteip", ip);

  const res = await fetch(
    "https://challenges.cloudflare.com/turnstile/v0/siteverify",
    { method: "POST", body: formData }
  );

  const outcome = await res.json();
  return outcome.success === true;
}

async function handlePair(request, env, ctx) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const allowed = await checkRateLimit(ip, env, ctx);
  if (!allowed) {
    return json({ error: "rate limit exceeded" }, 429, env);
  }

  const min = parseInt(env.NUM_MIN, 10);
  const max = parseInt(env.NUM_MAX, 10);
  const ttlMs = parseInt(env.PAIR_TTL_SECONDS, 10) * 1000;

  const numA = min + Math.floor(Math.random() * (max - min + 1));
  let numB = min + Math.floor(Math.random() * (max - min + 1));
  // avoid identical pairs
  while (numB === numA) {
    numB = min + Math.floor(Math.random() * (max - min + 1));
  }

  const expiry = Date.now() + ttlMs;
  const nonce = crypto.randomUUID();
  const payload = `${numA}:${numB}:${expiry}:${nonce}`;
  const payloadB64 = toBase64Url(encoder.encode(payload));
  const sig = await signPayload(payload, env.TOKEN_SECRET);
  const token = `${payloadB64}.${sig}`;

  return json({ numA, numB, token, expires: expiry }, 200, env);
}

async function handleVote(request, env, ctx) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON" }, 400, env);
  }

  const {
    token,
    choice,
    session_id: sessionId,
    turnstile_token: turnstileToken,
  } = body || {};

  if (!token || (choice !== 1 && choice !== 2) || !sessionId) {
    return json({ error: "missing or invalid fields" }, 400, env);
  }

  const ip = request.headers.get("CF-Connecting-IP") || "unknown";

  const allowed = await checkRateLimit(ip, env, ctx);
  if (!allowed) {
    return json({ error: "rate limit exceeded" }, 429, env);
  }

  const burstAllowed = await checkBurstLimit(sessionId, env, ctx);
  if (!burstAllowed) {
    return json({ error: "slow down" }, 429, env);
  }

  const turnstileOk = await verifyTurnstile(turnstileToken, ip, env);
  if (!turnstileOk) {
    return json({ error: "turnstile verification failed" }, 403, env);
  }


  const verified = await verifyToken(token, env.TOKEN_SECRET);
  if (!verified) {
    return json({ error: "token invalid or expired" }, 400, env);
  }

  const ipHash = await hashIp(ip, env.TOKEN_SECRET);

  try {
    await env.DB.prepare(
      `INSERT INTO votes (session_id, ip_hash, num_a, num_b, choice, nonce, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        sessionId,
        ipHash,
        verified.numA,
        verified.numB,
        choice,
        verified.nonce,
        Date.now()
      )
      .run();
  } catch (err) {
    // UNIQUE constraint on `nonce` fails if this token was already redeemed.
    return json({ error: "token already used" }, 409, env);
  }

  return json({ ok: true }, 200, env);
}

// ---- Entry point ----------------------------------------------------------

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(env) });
    }

    if (url.pathname === "/pair" && request.method === "GET") {
      return handlePair(request, env, ctx);
    }

    if (url.pathname === "/vote" && request.method === "POST") {
      return handleVote(request, env, ctx);
    }

    return json({ error: "not found" }, 404, env);
  },
};
