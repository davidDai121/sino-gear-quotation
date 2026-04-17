# Sino Gear Quotation Project

Web-based quotation generator that pulls used car data from JYT (金鱼塘) and produces branded PDF quotations.

## Project Structure

- `server.js` — Express backend (JYT scraping via Puppeteer, PDF rendering, admin)
- `public/` — static frontend
  - `index.html`, `css/style.css`, `js/script.js`
- `data/` — runtime state (gitignored; contains persisted JYT token)
- `scripts/` — diagnostic utilities

## How to Start (Local)

```bash
npm install
npm start           # http://localhost:8081
```

Admin page: http://localhost:8081/admin (set a fresh JYT token captured via Proxyman)

## JYT Token — How Storage Works

The JYT Access-Token is bound to your WeChat identity and can only be obtained by opening JYT in WeChat and capturing the header (Proxyman, Charles, etc.). There is no anonymous/guest endpoint, so the server cannot refresh it on its own.

The server loads a token from these sources, in priority order:

1. Runtime memory (set this session via `/admin`)
2. **Upstash Redis** (if `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` are set)
3. **Local file** `./data/jyt-token.json` — survives restarts only on persistent filesystems
4. **`JYT_ACCESS_TOKEN`** env var
5. Hardcoded `DEFAULT_JYT_ACCESS_TOKEN` in `server.js` (usually expired — last resort)

When you save a token via `/admin`, it writes to:

- Runtime memory (instant effect)
- GitHub via API (if `GITHUB_TOKEN` is set) — **rewrites the `DEFAULT_JYT_ACCESS_TOKEN` literal in `server.js`, commits, triggers auto-deploy on Render so the new token becomes permanent**
- Upstash (if configured)
- Local file

### Recommended setup for Render (free tier) — "edit token on the web, auto-save to code"

The simplest way to have `/admin` saves persist through Render restarts without a separate KV service: let the server commit the new token back to the source file on GitHub. Render redeploys automatically on push.

1. Go to https://github.com/settings/personal-access-tokens/new (fine-grained PAT)
2. Repository access: **Only select repositories** → pick `davidDai121/sinogear-quotation`
3. Permissions → Repository permissions → **Contents: Read and write**
4. Generate, copy the token (starts with `github_pat_...`)
5. In Render → your service → **Environment**, add:
   - `GITHUB_TOKEN` = `github_pat_...`
   - (optional) `GITHUB_REPO` = `davidDai121/sinogear-quotation` (default)
   - (optional) `GITHUB_BRANCH` = `main` (default)
6. Save. Render restarts. Open `/admin` — you should see a green banner "GitHub 自动 commit 已启用".

After that: paste a fresh token → click save → server commits + pushes → Render redeploys (1-2 min) → token is now the default. The in-memory value works immediately so you don't have to wait.

**Security note**: the repo is public, so the token is visible in commit history. This is deliberately accepted here because JYT tokens are short-lived; by the time anyone finds it, it's already invalid. If you want to be safer, make the repo private (GitHub settings → Danger Zone → Change visibility).

### Alternative: Upstash Redis

If you prefer a KV approach (doesn't touch git history): sign up at https://upstash.com, create a free Redis DB, copy the REST URL + token, set them in Render env.

## Optional Environment Variables

| Var | Purpose |
|---|---|
| `PORT` | HTTP port (default 8081) |
| `ADMIN_KEY` | If set, `/admin` and `/api/admin/*` require this key via `x-admin-key` header. Leave unset for open access (fine for personal use). |
| `JYT_ACCESS_TOKEN` | Fallback token when no runtime/upstash/file token is available |
| `GITHUB_TOKEN` | Fine-grained PAT with `contents:write` — enables auto-commit on save |
| `GITHUB_REPO` | `owner/repo` override (default `davidDai121/sinogear-quotation`) |
| `GITHUB_BRANCH` | Branch to commit to (default `main`) |
| `GITHUB_TOKEN_FILE` | File to rewrite (default `server.js`) |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | Enables cloud persistence |
| `UPSTASH_JYT_KEY` | Redis key (default `sinogear:jyt-access-token`) |
| `JYT_RL_IP_MAX`, `JYT_RL_IP_DAILY_MAX`, `JYT_RL_IP_CAR_MAX` | Rate limits per IP / per car (see `server.js`) |
