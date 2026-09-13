# Collecting results, and fixing the API from your own domain

Two Cloudflare Workers. They are independent — deploy either, both, or neither.

| | what it fixes |
|---|---|
| **CORS proxy** | "fetch by player ID" failing on any domain that is not carpet's |
| **Collector** | nowhere to send a result, and no leaderboard to see one on |

Neither is required to use the planner. Without the proxy, load a backup file instead of
fetching by ID. Without the collector, the Share card saves a file you can post anywhere.

---

## 1. The CORS proxy

### Why it breaks

The game's API sends no CORS headers, so browser requests go through a Worker that adds
them. The default is upstream's, and it only accepts requests from origins on its own
allowlist — see `wasmegg/_proxy/index.js`:

```
https://…wasmegg-carpet.netlify.app
https://…eicoop-carpet.netlify.app
https://…eicowop.netlify.app
http://localhost(:port)
http://127.0.0.1(:port)
http://192.168.x.x(:port)
```

**`localhost` and `192.168.*` are already allowed**, so a plain local build works. What does
not work is anything else: a custom domain, a Cloudflare tunnel, a Netlify preview under your
own account, a LAN host on `10.x`. Those are refused by the proxy and the app looks broken
rather than looking like a deployment that needs its own.

### Deploying your own

Upstream's proxy source is in this repo at `wasmegg/_proxy/index.js`. Copy it out, add your
origin to `isAllowedOrigin`, and deploy:

```bash
mkdir egg-proxy && cd egg-proxy
cp ../wasmegg/_proxy/index.js .
```

Add your own origin to the allowlist in `index.js`:

```js
function isAllowedOrigin(origin) {
  return (
    origin?.match(/^https:\/\/egg\.example\.org$/) ||      // <- yours
    origin?.match(/^https:\/\/([\w-]+--)?wasmegg-carpet.netlify.app$/) ||
    // … leave the rest
  );
}
```

`wrangler.toml`:

```toml
name = "egg-proxy"
main = "index.js"
compatibility_date = "2026-01-01"
```

```bash
npx wrangler deploy
```

### Pointing the app at it

Build with the env var set. Unset, nothing changes and upstream's proxy is used:

```bash
VITE_EGG_PROXY=https://egg-proxy.<you>.workers.dev pnpm fastbuild
```

`VITE_EGG_AUTH_PROXY` does the same for the authenticated endpoints, which only the contract
tools need — the ascension planner does not.

**Check it worked** by watching the network tab: requests should go to your Worker, and a
player-ID fetch should return a backup instead of a CORS error.

---

## 2. The collector

One Worker plus one KV namespace, holding `POST /submit`, a JSON leaderboard API, and the
leaderboard page itself. The dataset is a few thousand small objects, so KV is enough and a
database would be borrowing trouble.

```bash
cd collector
npx wrangler kv namespace create SUBMISSIONS   # paste the printed id into wrangler.toml
npx wrangler deploy
```

Then build the app pointing at it:

```bash
VITE_SUBMIT_URL=https://ascension-chain-collector.<you>.workers.dev/submit pnpm fastbuild
```

Without `VITE_SUBMIT_URL` the panel **hides the Submit button entirely** and offers only
"Save the file instead". That is the right default for a fork nobody has configured: there is
no sensible global collector, and a button that silently posts somewhere would be worse than
no button.

### Endpoints

| | |
|---|---|
| `POST /submit` | one submission; validated, scrubbed, rate-limited to one per IP per minute |
| `GET /leaderboard?final=490&limit=50` | best chain per submitter, already in duration order |
| `GET /all` | everything, for your own analysis |
| `GET /` | the leaderboard page |

### What is stored, and what is not

A submission is built in the app by **whitelist** (`src/search/submission.ts`) — a fresh
object with a fixed list of fields — not by stripping things out of the CSV. A field added to
the CSV later cannot leak by being forgotten about.

**The player ID is not in it, and never was**: `buildChainsCsv` has no `playerId` in its
metadata and never printed one. The Worker still sweeps `EI\d{16}` out of every body before
writing, for the case where someone posts a hand-made payload.

Stored: chain, ascension count, duration, local start/end, timezone, TE range, effort tier,
schedule window, whether shifts were held, waiting hours, artifact and stone counts, per-leg
strategy and peak delivery, chains priced, an optional 40-character nickname.

Not stored: IP addresses beyond a rate-limit key that expires after 60 seconds, headers,
cookies, or anything derived from the connection.

**Still identifying, and the app says so before the button is pressed.** The artifact
inventory with exact counts is close to a fingerprint among people who know each other; the
timezone and local plan start give a region and a daily rhythm; the availability window says
when someone is awake. The inventory is included because a duration is meaningless without
knowing what it was simulated with — 740 days on a full T4L set is a different claim from 740
days on commons.

If you change what is stored, **change the consent text in the panel to match**. People agreed
to a specific list.

### Reading the leaderboard honestly

Durations are not comparable between accounts. A chain's length depends on artifacts,
research and starting TE at least as much as on the chain, and on whether the run was
constrained to the player's waking hours. It answers "what shapes are winning for people",
not "who is best". The page says so under the table.

`waiting` blank means the submission carried no per-leg detail — a chain replayed from a saved
checkpoint keeps none. That is **unknown**, not zero, and it sorts accordingly.

---

## Testing the Worker without deploying

```bash
npx wrangler dev            # from collector/
```

`worker.js` is a single file with no build step and no dependencies, so a plain Node harness
with a `Map` standing in for KV exercises it end to end — that is how the validation, the rate
limit, the duration ordering and the ID redaction were checked before this was committed.
