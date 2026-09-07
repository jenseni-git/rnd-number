# Number Picker

Server-generated random number pairs; visitors pick one repeatedly; every
choice is logged to D1 for you to export and analyze later.

## How it works

- `GET /pair` — Worker picks two random numbers, signs an HMAC token
  containing them + an expiry + a random nonce, returns all three to the
  client. The server never trusts a client-supplied pair.
- `POST /vote` — client sends back `{ token, choice, session_id }`. The
  Worker re-verifies the HMAC, checks the token hasn't expired, and inserts
  a row into D1. The `nonce` column has a `UNIQUE` constraint, so replaying
  the same token twice fails at the database level (returns HTTP 409).
- `session_id` is a random UUID generated client-side and stored in
  `localStorage`, so you can group "all votes from one visitor" later
  without accounts or cookies.
- `ip_hash` is `SHA-256(ip + secret)` — lets you dedupe/rate-limit by
  visitor without storing raw IPs.

## Deploy steps

1. **Install Wrangler** (Cloudflare's CLI), if you don't have it:
   ```
   npm install -g wrangler
   wrangler login
   ```

2. **Create the D1 database:**
   ```
   wrangler d1 create number-picker-db
   ```
   Copy the `database_id` it prints into `wrangler.toml`.

3. **Apply the schema:**
   ```
   wrangler d1 execute number-picker-db --file=./schema.sql --remote
   ```

4. **Set the token secret** (used to sign/verify pair tokens — pick any
   long random string):
   ```
   wrangler secret put TOKEN_SECRET
   ```

5. **Set `ALLOWED_ORIGIN`** in `wrangler.toml` to your actual Cloudflare
   Pages URL once you know it (e.g. `https://number-picker.pages.dev`).

6. **Deploy the Worker:**
   ```
   wrangler deploy
   ```
   Note the `*.workers.dev` URL it gives you.

7. **Update the frontend:** in `public/index.html`, set `API_BASE` to that
   Worker URL.

8. **Deploy the frontend to Cloudflare Pages:**
   - Push this repo to GitHub.
   - In the Cloudflare dashboard: Pages → Create project → connect the
     repo → set build output directory to `public` (no build command
     needed, it's static).
   - Cloudflare will auto-deploy on every push.

## Bot / abuse mitigation already built in

- Every pair must be fetched from the server first — a bot can't just POST
  arbitrary numbers, it has to round-trip through `/pair` and get a valid
  signed token.
- Tokens expire (`PAIR_TTL_SECONDS`, default 120s) and can only be
  redeemed once (DB-enforced via the `nonce` UNIQUE constraint).
- IPs are hashed, not stored raw.

## Recommended extra layer (configured in the Cloudflare dashboard, no code)

- **Bot Fight Mode** — Security → Bots → turn on (free tier).
- **Rate limiting rule** — Security → WAF → Rate limiting rules → limit
  `/vote` and `/pair` to e.g. 60 requests/minute per IP.

## Exporting your data

```
wrangler d1 export number-picker-db --remote --output=votes.sql
```
or query directly:
```
wrangler d1 execute number-picker-db --remote \
  --command="SELECT * FROM votes" --json > votes.json
```

## Notes / things to tune before going live

- `NUM_MIN` / `NUM_MAX` in `wrangler.toml` control the number range.
- Numbers can never repeat within a pair (enforced in `handlePair`).
- If you want a live results view later, add a `GET /results` endpoint
  that runs an aggregate query — deliberately left out here since you said
  raw data export is enough.
