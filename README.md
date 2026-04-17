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

The JYT Access-Token is bound to your WeChat identity and can only be obtained by opening JYT in WeChat and capturing the header (Proxyman, Charles, etc.). The server loads it from these sources, in priority order:

1. **Upstash Redis** (if `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` are set) — **the only backend that survives deploys on ephemeral hosts like Render free tier**
2. **Local file** `./data/jyt-token.json` — survives restarts only if the filesystem is persistent (local dev, Render with persistent disk, etc.)
3. **`JYT_ACCESS_TOKEN`** environment variable — set once via platform dashboard
4. Hardcoded default (usually expired — last resort)

When you save a token via `/admin`, it's written to Upstash (if configured) **and** the local file.

### Recommended setup for Render (free tier)

Because Render's free tier has an ephemeral filesystem, use Upstash Redis so `/admin` saves survive restarts/redeploys:

1. Sign up at https://upstash.com (free, GitHub login works)
2. Create a Redis database (any region, "Free" plan)
3. In the database's **REST API** tab, copy the `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` values
4. In Render → your service → **Environment**, add both:
   - `UPSTASH_REDIS_REST_URL` = `https://xxx.upstash.io`
   - `UPSTASH_REDIS_REST_TOKEN` = `AXXXxxxxx…`
5. Redeploy. The `/admin` page will show a green "Upstash Redis 已连接" banner when it's wired up.

After that: capture a token from WeChat/Proxyman → paste at `/admin` → it sticks forever (or until JYT invalidates it).

## Optional Environment Variables

| Var | Purpose |
|---|---|
| `PORT` | HTTP port (default 8081) |
| `ADMIN_KEY` | If set, `/admin` and `/api/admin/*` require this key via `x-admin-key` header. Leave unset for open access (fine for personal use). |
| `JYT_ACCESS_TOKEN` | Fallback token when no runtime/upstash/file token is available |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | Enables cloud persistence (see above) |
| `UPSTASH_JYT_KEY` | Redis key to store the token under (default `sinogear:jyt-access-token`) |
| `JYT_RL_IP_MAX`, `JYT_RL_IP_DAILY_MAX`, `JYT_RL_IP_CAR_MAX` | Rate limits per IP / per car (see `server.js`) |
