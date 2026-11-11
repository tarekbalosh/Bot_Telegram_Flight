# Flight Tracker Agent — Build Spec for Claude Code (KUL ➔ DAM) — Telegram + Email edition

> Put this file in an empty folder, start `claude` there, and say:
> **"Read FLIGHT_TRACKER_BUILD_SPEC_TELEGRAM.md and implement everything, phase by phase, until the Definition of Done (section 9) is fully met."**

---

## 1. Mission

Build a production-ready, autonomous TypeScript agent that:

1. Searches **one-way** flights **Kuala Lumpur (KUL) ➔ Damascus (DAM)** inside a date range.
2. **Strictly** keeps only itineraries that are one ticket (single PNR / true interline), with checked baggage through to DAM (no self-transfer, no bag re-check), and sane layovers.
3. Stores offers and a **price history** in PostgreSQL (Neon) through Prisma.
4. Sends **Arabic** reports via a **Telegram bot** and **Email (Resend)**.
5. Runs as a long-lived cron worker, as a one-shot command, or as a dry run with mock data.

## 2. Operating Rules for Claude Code

- Write complete, working code for every file. No `// TODO`, no stubs, no "implement later".
- Work phase by phase (section 6). Keep a task list. After each phase run that phase's **Verify** commands and fix every failure before moving on.
- Never ask the user for secrets and never write real secrets anywhere. Only `.env.example` is created; `.gitignore` must contain `.env`, `node_modules`, `dist`, `dist-preview`.
- The user may not have keys yet. The project must therefore **compile, pass tests, and run end-to-end with `--dry-run` using mock data, with no keys and no database**.
- If `DATABASE_URL` is present in `.env`, also verify DB steps (`db:push`, a live run with `--no-notify`). If it is absent, skip those and say so in the final report.
- Use a small logger (`src/utils/logger.ts`) that prefixes every line with an ISO timestamp and level. Never log secrets (mask the Telegram token, which appears inside request URLs, in any logged URL or error message).
- All outbound HTTP uses Axios with a 30 s timeout and a shared retry helper (`src/utils/http.ts`): 3 attempts, exponential backoff, retry only on network errors, 429 and 5xx.
- Finish with a short report: what was built, what was verified, what was skipped and why.

## 3. Verified Provider Reality (checked November 2026) — IMPORTANT

| Provider | Status | Decision |
|---|---|---|
| **SerpApi (Google Flights)** | Works. Free plan = **250 searches/month**, 50/hour. | **Primary provider.** Must include a monthly budget guard (see 4.1). |
| **Amadeus Self-Service** | **Shut down on 17 Jul 2026**; keys disabled, no new registrations. Only Enterprise (sales contract) remains. | Keep adapter, **optional**, only for users who hold Enterprise credentials. Log a clear warning when configured. |
| **Kiwi Tequila** | Public self-serve closed since May 2024; invitation-only B2B partners. | Keep adapter, **optional**, only for existing partners. |
| Telegram Bot API | Free, no templates, no messaging windows; the user must press **Start** in the bot chat once. | **Primary notification channel.** |
| Resend | Without a verified domain you can only send from `onboarding@resend.dev` to the account owner's own email. | Secondary channel; document in README. |

Design the provider layer so that adding another adapter later means adding one file and one line in `providers/index.ts`.

## 4. Technical Decisions

- Node.js ≥ 20, TypeScript strict, **CommonJS output** (`module: "commonjs"`, `moduleResolution: "node"`, target `ES2022`, `outDir ./dist`, `rootDir ./src`, `strict`, `esModuleInterop`, `skipLibCheck`). Do **not** set `"type": "module"`; use extensionless imports.
- **Pin Prisma to v6** (`prisma@^6`, `@prisma/client@^6`) so `datasource db { url = env("DATABASE_URL") }` stays valid. Do not use Prisma 7 config files or adapters.
- Runtime deps: `axios dotenv zod node-cron resend @prisma/client`. Dev deps: `typescript tsx @types/node @types/node-cron prisma`. (No Telegram SDK: call the Bot API directly with Axios.)
- Tests: Node's built-in runner via `tsx --test` (no extra test framework).
- Money: SerpApi returns MYR. USD is computed with a rate from `https://api.frankfurter.app/latest?from=MYR&to=USD` (no key), cached in memory for 6 h, falling back to env `FALLBACK_MYR_TO_USD` (default `0.22`) if the call fails.
- Timezone: cron runs in `Asia/Kuala_Lumpur` (env `TZ_NAME`).

## 5. Project Layout

```
.
├── .env.example
├── .gitignore
├── README.md                      # Arabic + English
├── package.json
├── tsconfig.json
├── prisma/schema.prisma
├── .github/workflows/tracker.yml  # optional free scheduler (GitHub Actions)
└── src/
    ├── index.ts
    ├── config/{env.ts, db.ts}
    ├── types/flight.ts
    ├── utils/{logger.ts, http.ts, hash.ts, dates.ts, fx.ts}
    ├── providers/{index.ts, serpapi.ts, amadeus.ts, kiwi.ts, mock.ts}
    ├── services/{filter.ts, tracker.ts, telegram.ts, email.ts, format.ts}
    ├── scripts/telegram-setup.ts
    └── __tests__/{filter.test.ts, serpapi.parse.test.ts, format.test.ts, telegram.test.ts}
```

## 6. Phases

### Phase 1 — Scaffold
1. `npm init -y`, install dependencies (section 4), `npx prisma init --datasource-provider postgresql` (then overwrite the schema in Phase 2).
2. Create `tsconfig.json`, `.gitignore`.
3. `package.json` scripts:
   - `"start": "tsx src/index.ts"` (run now + cron, long-lived)
   - `"run:now": "tsx src/index.ts --run-now"` (force notification, then exit)
   - `"run:once": "tsx src/index.ts --once"` (one run honoring notification rules, then exit; for GitHub Actions / cron jobs)
   - `"dry-run": "tsx src/index.ts --dry-run"` (mock data, no DB, notifications printed to console)
   - `"telegram:setup": "tsx src/scripts/telegram-setup.ts"`
   - `"db:push": "prisma db push"`, `"build": "tsc"`, `"start:prod": "node dist/index.js"`
   - `"test": "tsx --test src/__tests__/*.test.ts"`, `"typecheck": "tsc --noEmit"`
   - `"postinstall": "prisma generate"`

**Verify:** `npm install` succeeds.

### Phase 2 — Environment & Database
**`.env.example`** (secret keys left **empty**, never placeholder text, so they are detected as "not configured"):

```env
# Database (Neon PostgreSQL) — use the NON-pooled connection string
DATABASE_URL=""

# Search
ORIGIN_IATA="KUL"
DESTINATION_IATA="DAM"
DATE_FROM="2026-12-01"
DATE_TO="2026-12-31"
MAX_LAYOVER_HOURS="10"
MIN_BAGGAGE_KG="20"
TARGET_PRICE_MYR="2500"
BAGGAGE_UNKNOWN_POLICY="flag"        # "flag" = keep but warn | "reject" = drop offers whose baggage can't be verified
CRON_SCHEDULE="0 8 * * *"            # daily 08:00 (fits SerpApi free plan)
TZ_NAME="Asia/Kuala_Lumpur"
FALLBACK_MYR_TO_USD="0.22"

# SerpApi (primary)
SERPAPI_KEY=""
SERPAPI_DATES_PER_RUN="6"
SERPAPI_MONTHLY_BUDGET="240"

# Optional legacy providers (Enterprise / invited partners only)
AMADEUS_CLIENT_ID=""
AMADEUS_CLIENT_SECRET=""
AMADEUS_ENV="production"             # "test" | "production"
KIWI_API_KEY=""

# Telegram (primary notification channel)
TELEGRAM_BOT_TOKEN=""                # from @BotFather
TELEGRAM_CHAT_ID=""                  # numeric; can be found with: npm run telegram:setup

# Email (Resend)
RESEND_API_KEY=""
EMAIL_FROM="Flight Agent <onboarding@resend.dev>"
EMAIL_TO=""
```

**`src/config/env.ts`** — `import "dotenv/config"`, parse with `zod`:
- Numerics via `z.coerce.number()`; enums for `AMADEUS_ENV`, `BAGGAGE_UNKNOWN_POLICY`; dates validated as `YYYY-MM-DD` and `DATE_FROM <= DATE_TO`; IATA codes 3 uppercase letters.
- Treat empty strings as `undefined` (preprocess) for every optional key.
- All DB / provider / notification secrets are optional at parse time. Export `env` plus helpers: `activeProviders()`, `telegramConfigured()` (token **and** chat id), `emailConfigured()`.
- Export `assertLiveReady()`: throws one clear bilingual (Arabic + English) error listing every missing item when running **live** (not `--dry-run`): `DATABASE_URL` missing, or no provider key at all. Notification channels that are not configured are skipped with a warning, not an error. If **no** channel is configured in live mode, log a prominent warning that results will only be stored, not delivered.

**`prisma/schema.prisma`** (PostgreSQL):
- `FlightOfferRecord`: `id String @id @default(cuid())`, `externalId String @unique`, `provider String`, `priceMYR Float`, `priceUSD Float`, `departureDate String`, `departureTime String`, `arrivalTime String`, `airlines String[]`, `flightNumbers String[]`, `transitAirports String[]`, `layoverDurationsHours Float[]`, `totalDurationHours Float`, `checkedBaggageKg Int?`, `baggageVerified Boolean`, `isSinglePNR Boolean`, `bagsRecheckRequired Boolean`, `bookingLink String`, `createdAt DateTime @default(now())`, `updatedAt DateTime @updatedAt`.
- `PriceSnapshot` (the real price **history**): `id`, `externalId String`, `priceMYR Float`, `observedAt DateTime @default(now())`, `@@index([externalId, observedAt])`, `@@index([observedAt])`.
- `NotificationLog`: `id`, `lowestPriceMYR Float`, `channel String` (`"TELEGRAM"` | `"EMAIL"`), `reason String`, `sentAt DateTime @default(now())`.
- `ApiUsage`: `key String @id` (e.g. `SERPAPI:2026-12`), `count Int @default(0)`, `updatedAt DateTime @updatedAt`.

**`src/config/db.ts`** — singleton `PrismaClient` (reuse via `globalThis` to avoid duplicates).

**Verify:** `npx prisma validate`, `npx prisma generate`, `npm run typecheck`. If `DATABASE_URL` exists: `npm run db:push`.

### Phase 3 — Types, Filter Engine, Tests

**`src/types/flight.ts`** — `UnifiedFlightOffer` mirrors `FlightOfferRecord` core fields (without ids/timestamps), with `provider: "AMADEUS" | "KIWI" | "SERPAPI"`, `checkedBaggageKg: number | null`, `baggageVerified: boolean`.

**`src/utils/hash.ts`** — `buildExternalId(offer)`: sha1 of `airlines + flightNumbers + departure ISO datetime`, **excluding provider and price**, so identical itineraries from different providers collide on purpose.

**`src/services/filter.ts`** — `filterStrictDamascusFlights(offers)`, non-negotiable rules applied in this order:
1. **Single ticket:** `isSinglePNR === true && bagsRecheckRequired === false`.
2. **Baggage to DAM:** if `checkedBaggageKg !== null` it must be `>= MIN_BAGGAGE_KG`. If it is `null` (provider could not tell): drop when `BAGGAGE_UNKNOWN_POLICY="reject"`, otherwise keep with `baggageVerified=false` (reports must then show a "verify baggage before booking" warning instead of the green badge).
3. **Layovers:** every value in `layoverDurationsHours <= MAX_LAYOVER_HOURS`.
4. **Sanity:** origin/destination match config, departure inside `[DATE_FROM, DATE_TO]`, price > 0.
5. **Dedupe + sort:** by `externalId` keep the cheaper (prefer the one with `baggageVerified=true` on equal price); sort ascending by `priceMYR`.
The function is pure (inject config values as an optional 2nd parameter, default from `env`) so it is unit-testable.

**`src/__tests__/filter.test.ts`** — cover: self-transfer rejected, recheck rejected, 15 kg rejected, unknown baggage under both policies, 12 h layover rejected, dedupe keeps cheaper, ascending order, out-of-range date rejected.

**Verify:** `npm test`, `npm run typecheck`.

### Phase 4 — Providers

Common contract: `interface FlightProvider { name; isConfigured(): boolean; search(): Promise<UnifiedFlightOffer[]> }`. Every adapter must convert provider-specific data to `UnifiedFlightOffer`, compute `priceUSD` through `utils/fx.ts`, and **never throw on an empty result** (return `[]`).

**4.1 `serpapi.ts` (primary)**
- `GET https://serpapi.com/search.json` with `engine=google_flights`, `departure_id`, `arrival_id`, `outbound_date`, `type=2` (one-way), `currency=MYR`, `hl=en`, `gl=my`, `layover_duration=0,{MAX_LAYOVER_HOURS*60}`, `api_key`.
- **Date sampling** (`utils/dates.ts`): pick `SERPAPI_DATES_PER_RUN` dates evenly spread over the range (always include first and last), rotating the offset by day-of-year so successive runs cover different days. Run searches sequentially (not in parallel) with a 1 s gap.
- **Budget guard:** before each request read/increment `ApiUsage` row `SERPAPI:YYYY-MM` (skip the request and log a warning when `count >= SERPAPI_MONTHLY_BUDGET`). Increment only after a successful response. In `--dry-run` no DB is touched.
- Parse `best_flights` + `other_flights`. Per option: segments from `flights[]` (`airline`, `flight_number`, `departure_airport.{id,time}`, `arrival_airport.{id,time}`), layovers from `layovers[]` (`duration` is **minutes** ➔ hours, airport `id` ➔ `transitAirports`), `total_duration` minutes ➔ hours, `price` ➔ `priceMYR`.
- **Self-transfer detection:** serialize the whole option (`JSON.stringify`) and test case-insensitively against a pattern list for "Self transfer" and "Separate tickets" (keep the pattern list in one exported constant). Match ➔ `isSinglePNR=false`, `bagsRecheckRequired=true` (so the filter drops it). Otherwise `isSinglePNR=true`, `bagsRecheckRequired=false`.
- **Baggage parsing** (exported pure function `parseBaggage(option)` returning `{ kg: number | null, verified: boolean }`): scan all `extensions` strings. "N checked bag(s) included" ➔ `N × 23`; an explicit "X kg" near "checked" ➔ X; "checked baggage for a fee" / "no checked bag" ➔ `0` (verified); nothing found ➔ `null`, `verified=false`.
- `bookingLink`: `search_metadata.google_flights_url`; fallback to `https://www.google.com/travel/flights?q=Flights%20from%20KUL%20to%20DAM%20on%20{date}%20oneway`.
- Handle SerpApi `error` fields: "hasn't returned any results" ➔ `[]`; auth/quota errors ➔ throw a clear error.

**4.2 `amadeus.ts` (optional)** — OAuth2 client-credentials token (cache until expiry) from `https://test.api.amadeus.com` or `https://api.amadeus.com` per `AMADEUS_ENV`. `GET /v2/shopping/flight-offers` with `originLocationCode`, `destinationLocationCode`, `departureDate`, `adults=1`, `currencyCode=MYR`, `max=50`, once per sampled date (reuse the date sampler, up to 6 dates). Baggage from `travelerPricings[0].fareDetailsBySegment[].includedCheckedBags`: use `weight` (convert `LB` ➔ kg) else `quantity × 23`; take the **minimum across segments**; absent ➔ `null`. Always `isSinglePNR: true`, `bagsRecheckRequired: false`. Booking link: Google Flights fallback link. On startup, log: "Amadeus Self-Service was retired on 2026-07-17; this adapter works only with Enterprise credentials."

**4.3 `kiwi.ts` (optional)** — `GET https://api.tequila.kiwi.com/v2/search`, header `apikey`, params `fly_from`, `fly_to`, `date_from`/`date_to` (format `dd/MM/yyyy`), `flight_type=oneway`, `curr=MYR`, `adults=1`, `is_virtual_interlining=false` (**critical**), `limit=100`, `sort=price`. Map `route[]` (`flyFrom`, `flyTo`, `airline`, `flight_no`, `local_departure`, `local_arrival`), layovers = gap between consecutive segments, `baglimit.hold_weight` ➔ checked kg (missing ➔ `null`), `bags_recheck_required` ➔ `bagsRecheckRequired`, `virtual_interlining` true ➔ `isSinglePNR=false`, `deep_link` ➔ `bookingLink`. Same "partner access only" startup warning.

**4.4 `mock.ts`** — fixtures used by `--dry-run`: at least 6 offers (2 valid with 30 kg and 23 kg, 1 self-transfer, 1 with 15 kg, 1 with 14 h layover, 1 with unknown baggage, 1 duplicate of a valid one at a higher price).

**4.5 `providers/index.ts`** — `fetchAllOffers({ dryRun })`: pick configured providers (or mock), run with `Promise.allSettled`, log per-provider status/count/duration/error, merge results.

**4.6 `serpapi.parse.test.ts`** — fixture JSON of a realistic Google Flights response; assert parsing of price, layovers (minutes ➔ hours), baggage patterns, and self-transfer detection.

**Verify:** `npm test`, `npm run typecheck`.

### Phase 5 — Arabic Notifications (Telegram + Email)

**`src/services/format.ts`** — shared pure helpers (tested in `format.test.ts`): date formatting, price formatting (`1,234.56`), airline/transit text (`إسطنبول (IST) — انتظار 3.5 ساعة`), baggage line:
- verified: `✅ تذكرة موحدة — استلام الحقائب في دمشق (23 كغ)`
- unverified: `⚠️ تذكرة موحدة — تحقق من وزن الحقيبة قبل الحجز`
- `escapeHtml()` used for every dynamic value in both Telegram HTML and email HTML.
- Keep all Arabic strings in one constants block so wording can be edited in one place.

**`src/services/telegram.ts`** — `POST https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage` with JSON body: `chat_id`, `text`, `parse_mode: "HTML"`, `link_preview_options: { is_disabled: true }`, and `reply_markup.inline_keyboard` containing one URL button per flight (`"حجز الرحلة #1 ✈️"`, …) pointing to each `bookingLink` (only valid `http(s)` URLs).
- Message for the **top 3** cheapest flights, Arabic, per flight: التاريخ، السعر (ر.م MYR والدولار USD)، الشركات المشغلة، محطات الترانزيت ومدة الانتظار، تأكيد شحن الحقائب مباشرة إلى دمشق (بدون استلام في الترانزيت) مع الوزن بالكيلوغرام (or the unverified warning), and the booking link. Header shows the lowest price and whether `TARGET_PRICE_MYR` was beaten.
- Limit: 4096 characters per message. If longer, split on flight boundaries into multiple messages (the keyboard goes on the last one). Add `telegram.test.ts` covering the splitting and HTML escaping.
- Errors: on HTTP 429 wait `parameters.retry_after` seconds then retry once; on 400/401/403/404 return a clear error (invalid token, wrong chat id, user hasn't pressed Start) with the Telegram `description`. Never include the token in logs.
- Returns `{ ok: boolean, error?: string }`, never throws.

**`src/scripts/telegram-setup.ts`** — helper for the user (`npm run telegram:setup`):
1. If `TELEGRAM_BOT_TOKEN` is missing: print Arabic + English instructions (create bot with @BotFather) and exit 1.
2. Call `getMe` and print the bot username.
3. If `TELEGRAM_CHAT_ID` is missing: call `getUpdates`, print every `chat.id` found (with name/type) and tell the user to press Start / send any message to the bot first if none are found, then copy the id into `.env`.
4. If `TELEGRAM_CHAT_ID` is set: send an Arabic test message ("✅ تم ربط البوت بنجاح") and report success or the exact error.

**`src/services/email.ts`** — `resend` SDK. Responsive RTL HTML (`<html lang="ar" dir="rtl">`, inline CSS, system Arabic-friendly font stack, max-width 640 px) plus a plain-text fallback. Contents: summary banner (lowest price MYR/USD and whether `TARGET_PRICE_MYR` was beaten: green "تم تحقيق السعر المستهدف ✅" / neutral otherwise), table of the **top 10** (`KUL ➔ DAM`: date, price, airlines, transit, baggage badge, **booking button**), green badge for verified baggage and amber badge for unverified. Subject: `✈️ أرخص رحلة KUL ➔ DAM: {price} ر.م`.

Both services never throw. In `--dry-run` they print the rendered Telegram text / email text instead of sending (and write the HTML to `./dist-preview/email.html`).

**Verify:** `npm test`, `npm run typecheck`, `npm run dry-run` shows both Arabic outputs; `npm run telegram:setup` without a token exits cleanly with instructions.

### Phase 6 — Orchestrator (`src/services/tracker.ts`)

`runFlightTrackerAgent({ forceNotify, dryRun, noNotify })`:
1. Log start; `assertLiveReady()` unless dry run.
2. `fetchAllOffers` ➔ `filterStrictDamascusFlights`. Log counts at each stage (raw ➔ valid).
3. **Read the previous lowest price FIRST** (`min(priceMYR)` over `PriceSnapshot` from earlier runs) and the last `NotificationLog` — **before** writing this run's data (otherwise the new price would compare against itself).
4. Upsert valid offers into `FlightOfferRecord` and insert a `PriceSnapshot` per offer (batch in a transaction).
5. Decide notification, with the reason recorded in `NotificationLog.reason`:
   - `FORCED` (`forceNotify`), or
   - `NEW_LOW` — current lowest `<` previous lowest, or first-ever run (baseline), or
   - `TARGET_HIT` — any offer `<= TARGET_PRICE_MYR` **and** current lowest differs from the last notified lowest (avoid repeating the same alert every run), or
   - `DAILY` — ≥ 24 h since the last notification.
6. If no valid flights: notify only when forced, with an Arabic "no matching flights" message.
7. Send Telegram and Email **independently**; one failing never blocks the other. Write a `NotificationLog` row per **successful** channel. Skip unconfigured channels with a warning.
8. Return a summary object (`rawCount`, `validCount`, `lowestPriceMYR`, `notified: string[]`). Add an in-process mutex so overlapping scheduled runs are skipped.

**Verify:** `npm run dry-run` completes with exit code 0 and logs each step; if DB available: `npm run run:once -- --no-notify` twice in a row, and confirm the second run inserted new `PriceSnapshot` rows.

### Phase 7 — Entrypoint (`src/index.ts`)
Flags: `--run-now`, `--once`, `--dry-run`, `--no-notify`.
- `--run-now` ➔ `runFlightTrackerAgent({ forceNotify: true })`, exit.
- `--once` ➔ one run with normal notification rules, exit.
- `--dry-run` ➔ forced run with mock data, no DB, no sends, exit.
- default ➔ run once on startup, then `cron.schedule(env.CRON_SCHEDULE, …, { timezone: env.TZ_NAME })`; validate the cron expression (`cron.validate`) and fail with a clear message if invalid.
- Always disconnect Prisma in `finally`; `SIGINT`/`SIGTERM` handlers stop the cron task, disconnect Prisma, exit 0. Exit code 1 on fatal errors.

### Phase 8 — Docs & Deployment
**`README.md`** — bilingual (Arabic first, then English): how to get and fill every `.env` value (Neon, SerpApi, Telegram via @BotFather + `npm run telegram:setup`, Resend), `npm run db:push`, `npm run dry-run`, `npm run run:now`, and three deployment options:
1. **GitHub Actions (free):** `.github/workflows/tracker.yml` with `schedule: cron "0 0 * * *"` (UTC = 08:00 Malaysia) + `workflow_dispatch`, Node 20, `npm ci`, `npm run run:once`, all secrets from `secrets.*`.
2. **VPS:** `npm ci && npm run build`, then `pm2 start npm --name flight-tracker -- run start:prod` (or a systemd unit — include the unit file).
3. **Render Background Worker (paid plan; free tier has no workers):** build `npm install && npm run build`, start `npm run start:prod`, env vars via dashboard.

### Phase 9 — Final Verification
Run, in order, and fix until all pass: `npx prisma validate`, `npx prisma generate`, `npm run typecheck`, `npm test`, `npm run build`, `npm run dry-run`. If `DATABASE_URL` is set: `npm run db:push` and `npm run run:once -- --no-notify`. If `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` are set: `npm run telegram:setup` (sends the test message). Then re-read this spec top to bottom and tick every item in section 9.

## 7. Notification Content Reference (Arabic)
Use real Arabic RTL-safe text; wrap LTR fragments such as flight numbers and URLs so line direction does not break.

## 8. What the Human Must Provide (Claude Code must NOT do these)
Neon `DATABASE_URL` (non-pooled), SerpApi key, Telegram bot token + chat id (create the bot with @BotFather, press Start, then run `npm run telegram:setup`), and optionally Resend key + email addresses. Amadeus/Kiwi keys are optional and usually unobtainable. Document all of this in the README.

## 9. Definition of Done
- [x] All files in section 5 exist and are complete (no TODO/placeholders).
- [x] No WhatsApp code or env variables remain anywhere in the project.
- [x] `prisma validate`, `prisma generate`, `tsc --noEmit`, `npm test`, `npm run build` all pass with zero errors.
- [x] `npm run dry-run` runs end-to-end without keys/DB: filters mock data correctly (self-transfer, low baggage, long layover dropped), prints the Arabic Telegram text and writes the RTL email HTML preview.
- [x] Filter rules 1–5 are covered by passing unit tests; SerpApi parser and Telegram splitting/escaping covered by passing tests.
- [x] Previous-lowest price is read **before** this run's snapshots are written.
- [x] SerpApi monthly budget guard implemented and default schedule fits the 250/month free plan.
- [x] Telegram messages include inline booking buttons; the token never appears in logs.
- [x] `npm run telegram:setup` discovers the chat id and sends a test message when configured.
- [x] Graceful shutdown works; invalid cron expression fails with a clear message.
- [x] `README.md` (Arabic + English) and `.github/workflows/tracker.yml` are written.
- [x] Final report lists anything that could not be verified and why.
