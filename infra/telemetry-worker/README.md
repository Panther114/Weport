# Weport usage count and private error receiver

From this directory:

```powershell
npm install
npx wrangler login
npx wrangler d1 create weport-telemetry
```

Replace `REPLACE_WITH_D1_DATABASE_ID` in `wrangler.jsonc` with the returned UUID. Then:

```powershell
npm run migrate:remote
npx wrangler secret put ADMIN_TOKEN
npm run deploy
```

Use a random admin token of at least 32 characters. Keep it only in Cloudflare and your password manager; never bake it into the desktop app. `/v1/stats` requires `Authorization: Bearer <ADMIN_TOKEN>` and returns platform totals plus the most recent 100 anonymous error batches. `/health` checks the deployed Worker.

For local verification, run `npm run migrate:local`, put `ADMIN_TOKEN=...` in the ignored `.dev.vars`, then `npm run dev`. Root `npm run test:unit` tests the receiver's privacy validation and routing without any external requests.

## Wire the desktop build

In the root project, set the deployed Worker **origin**, including the trailing slash:

```powershell
$env:WEPORT_TELEMETRY_URL = 'https://weport-telemetry.YOUR_SUBDOMAIN.workers.dev/'
npm run build:dir
```

Set repository Actions variable `WEPORT_TELEMETRY_URL` to that same origin before releasing. The URL is compiled into the main process, never taken from a user's config. Release CI rejects missing or invalid receiver URLs for v1.2.1 onward; local builds can remain offline. No receiver has been deployed merely by adding this directory.

## Data contract

* Mandatory `POST /v1/installations`: random installation UUID and platform only. The database has exactly these two columns, with a unique UUID. Repeated launches/retries do not increment the total. No last-seen timestamp, OS version, account/device identifiers, IP address, or user-agent is recorded. Clearing the profile/reinstalling can create a new ID; multiple devices are multiple installations, so this is not a unique-person counter.
* Optional `POST /v1/errors`: batch UUID (retry deduplication), platform, app/Electron versions, and errors containing a fixed source/type/code, occurrence count, and positions in known app bundles. No installation ID joins errors to usage counts. Both sides reject arbitrary extra fields. Raw log text, filenames, source paths, function names, URLs, account/chat data, credentials, and custom error names are never included.
* The install/upgrade notice offers error reports off or on. Settings → Privacy can revoke consent; revocation clears the in-memory queue and aborts an upload. Already accepted reports cannot be recalled. Pre-consent errors are not retained for later upload. Offline reports retry in memory; they disappear on exit. Queues are bounded (500 distinct pending signatures) and repeated errors aggregate up to one million occurrences.
* Anonymous error batches expire after 30 days via the daily scheduled task. Installation IDs remain for lifetime totals. Worker application logging/observability is disabled and no request headers are stored. Cloudflare still necessarily handles connection metadata as the transport provider; configure account-level request logging separately if it is enabled elsewhere.

The public ingest endpoints use strict schemas, bounded body sizes, prepared statements, deduplicated batches, and a platform-keyed rate limiter. There is no client-side shared secret: a desktop binary cannot hide one. Counts remain estimates and can be inflated by forged UUIDs; authenticated human counts require an identity system, which this app deliberately does not collect.

Deployment references: [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/), [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/).
