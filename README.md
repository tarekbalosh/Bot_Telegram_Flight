# ✈️ وكيل تتبع رحلات الطيران الذكي (كوالالمبور KUL ➔ دمشق DAM)
# Flight Tracker Autonomous Agent (KUL ➔ DAM) — Telegram + Email Edition

---

## 🇸🇦 الدليل الشامل بالعربية

### 1. نبذة عن المشروع
وكيل ذكي مستقل مبني بلغة **TypeScript** يقوم بالبحث الدوري عن رحلات الطيران **ذهاب فقط (One-Way)** من **كوالالمبور (`KUL`)** إلى **دمشق (`DAM`)** ضمن نطاق تواريخ محدد، مع تطبيق شروط صارمة غير قابلة للتفاوض:
- **تذكرة موحدة حقيقية (Single PNR / Interline):** يرفض تماماً رحلات النقل الذاتي (`Self-transfer`) أو التذاكر المنفصلة التي تتطلب استلام وإعادة شحن الحقائب في مطار الترانزيت.
- **شحن الحقائب إلى دمشق:** يشترط توفر حقيبة مشحونة لا تقل عن `MIN_BAGGAGE_KG` (افتراضياً `20 كغ`) حتى مطار دمشق، أو يضع تنبيهاً واضحاً إذا لم يفصح المزود عن وزن الحقيبة (`BAGGAGE_UNKNOWN_POLICY="flag"`).
- **ترانزيت منطقي:** يرفض أي رحلة تتجاوز مدة الانتظار في أي محطة ترانزيت `MAX_LAYOVER_HOURS` (افتراضياً `10 ساعات`).
- **سجل تاريخي للأسعار (Price History):** يحفظ العروض وسجل تغير الأسعار في قاعدة بيانات **PostgreSQL (Neon)** عبر **Prisma v6**.
- **إشعارات عربية فورية:** يرسل تقارير مفصلة باللغة العربية عبر **بوت تيليجرام (Telegram Bot)** (مع أزرار حجز تفاعلية مباشرة) و**البريد الإلكتروني (Resend)** (بتصميم HTML RTL متجاوب).

---

### 2. البدء السريع والتجربة بدون مفاتيح (`--dry-run`)

```bash
# 1. تثبيت الحزم وتوليد عميل Prisma
npm install

# 2. تجربة النظام بالكامل ببيانات تجريبية (بدون قاعدة بيانات وبدون مفاتيح API)
npm run dry-run
```
سيقوم الأمر `npm run dry-run` بتصفية العروض التجريبية، وطباعة تقرير تيليجرام بالعربية في الطرفية، وحفظ معاينة البريد الإلكتروني في الملف `./dist-preview/email.html`.

---

### 3. إعداد ملف البيئة (`.env`) خطوة بخطوة

انسخ ملف `.env.example` إلى `.env`:
```bash
cp .env.example .env
```

#### أ) قاعدة البيانات `DATABASE_URL` (Neon PostgreSQL — مجاني)
1. أنشئ حساباً مجانياً على [Neon.tech](https://neon.tech) وأنشئ مشروعاً جديداً.
2. من لوحة التحكم انسخ رابط الاتصال **غير المجمّع (Direct / Non-pooled connection string)** (بدون `-pooler` في اسم المضيف).
3. ضعه في `.env`:
   ```env
   DATABASE_URL="postgresql://user:password@ep-xyz.region.aws.neon.tech/neondb?sslmode=require"
   ```
4. ادفع مخطط الجداول إلى قاعدة البيانات:
   ```bash
   npm run db:push
   ```

#### ب) مزود البحث الأساسي `SERPAPI_KEY` (Google Flights عبر SerpApi)
1. سجّل حساباً مجانياً في [SerpApi.com](https://serpapi.com) (الخطة المجانية تمنحك **250 عملية بحث شهرياً**).
2. انسخ مفتاح الـ API وضعه في `.env`:
   ```env
   SERPAPI_KEY="your_serpapi_key_here"
   SERPAPI_DATES_PER_RUN="6"
   SERPAPI_MONTHLY_BUDGET="240"
   ```
   > **ملاحظة:** يحتوي النظام على حارس ميزانية شهري (`SERPAPI_MONTHLY_BUDGET`) مخزن في جدول `ApiUsage` يمنع تجاوز الحد المجاني، كما يقوم بتدوير التواريخ المختارة يومياً لتغطية الشهر بالكامل.

#### ج) إعداد بوت تيليجرام (`TELEGRAM_BOT_TOKEN` و `TELEGRAM_CHAT_ID`) — القناة الأساسية
1. افتح تيليجرام وابحث عن الحساب الرسمي **[@BotFather](https://t.me/BotFather)**.
2. أرسل الأمر `/newbot` واتبع التعليمات لاختيار اسم ومعرّف البوت.
3. انسخ رمز البوت (`Token`) وضعه في ملف `.env`:
   ```env
   TELEGRAM_BOT_TOKEN="123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ"
   ```
4. افتح محادثة مع البوت الجديد واضغط زر **Start** (أو أرسل أي رسالة نصية).
5. شغّل أداة الإعداد التلقائي لاكتشاف معرّف المحادثة (`TELEGRAM_CHAT_ID`):
   ```bash
   npm run telegram:setup
   ```
6. انسخ رقم `TELEGRAM_CHAT_ID` الذي سيظهر لك وضعه في `.env`، ثم أعد تشغيل `npm run telegram:setup` لإرسال رسالة الاختبار العربية (`"✅ تم ربط البوت بنجاح"`).

#### د) إعداد البريد الإلكتروني عبر Resend (`RESEND_API_KEY`) — قناة إضافية اختيارية
1. أنشئ حساباً مجانياً في [Resend.com](https://resend.com) وانسخ مفتاح الـ API.
2. **مهم جداً:** بدون توثيق نطاق خاص (Custom Domain)، يسمح Resend بالإرسال **فقط** من العنوان `onboarding@resend.dev` **وإلى البريد الإلكتروني المسجل به حسابك في Resend حصراً**.
3. إذا قمت بتوثيق نطاقك في Resend، يمكنك تغيير `EMAIL_FROM` والإرسال لأي مستلم:
   ```env
   RESEND_API_KEY="re_xxxxxxxxx"
   EMAIL_FROM="Flight Agent <onboarding@resend.dev>"
   EMAIL_TO="your-own-account-email@example.com"
   ```

#### هـ) المزودات الاختيارية القديمة (Amadeus / Kiwi)
- **Amadeus:** تم إيقاف بوابة الخدمة الذاتية المجانية (`Amadeus Self-Service`) نهائياً بتاريخ **17 يوليو 2026**. يعمل محول Amadeus فقط لمن يمتلك عقد **Enterprise** رسمي.
- **Kiwi Tequila:** التسجيل العام مغلق منذ مايو 2024 ومتاح فقط لشركاء B2B المدعوين.
- اترك مفاتيحهما فارغة في `.env` ما لم تكن تمتلك صلاحية وصول مؤسسية.

---

### 4. أوامر التشغيل المتاحة

| الأمر | الوصف |
|---|---|
| `npm run dry-run` | تشغيل تجريبي كامل ببيانات وهمية بدون قاعدة بيانات أو إرسال فعلي |
| `npm run telegram:setup` | اكتشاف `TELEGRAM_CHAT_ID` واختبار إرسال رسالة عربية على تيليجرام |
| `npm run db:push` | إنشاء/تحديث جداول قاعدة البيانات في PostgreSQL (Neon) |
| `npm run run:now` | تشغيل فوري مع إجبار إرسال الإشعارات (`FORCED`) ثم الخروج |
| `npm run run:once` | تشغيل دورة بحث واحدة وفق قواعد الإشعارات الذكية ثم الخروج (مناسب لـ GitHub Actions) |
| `npm start` | تشغيل فوري يتبعه مجدول `cron` طويل الأمد بتوقيت ماليزيا (`Asia/Kuala_Lumpur`) |
| `npm test` | تشغيل كافة اختبارات الوحدة (`tsx --test`) |
| `npm run typecheck` | فحص أنواع TypeScript (`tsc --noEmit`) |
| `npm run build` | ترجمة المشروع إلى JavaScript في مجلد `dist/` |
| `npm run start:prod` | تشغيل النسخة المترجمة للإنتاج (`node dist/index.js`) |

---

### 4.1 الأوامر التفاعلية عبر بوت تيليجرام (Interactive Telegram Commands)

عند تشغيل البرنامج في الوضع المستمر (`npm start` أو `npm run start:prod`)، يقوم البوت بالاستماع للأوامر التفاعلية عبر `getUpdates (Long-Polling)` وتسجيل قائمة الأوامر تلقائياً في قائمة تيليجرام (`setMyCommands`). لأسباب أمنية، يتجاهل البوت تماماً أي رسائل واردة من محادثات أخرى غير `TELEGRAM_CHAT_ID`.

| أمر تيليجرام | الوصف |
|---|---|
| `/start` أو `/help` | عرض رسالة الترحيب وقائمة الأوامر المتاحة بالعربية |
| `/search` | تشغيل بحث فوري الآن (`forceNotify: true`) مع إرسال رد فوري `"⏳ جاري البحث..."` (يخضع لفترة تهدئة `SEARCH_COOLDOWN_MIN` افتراضياً `30 دقيقة`، ويرفض التشغيل المتزامن أو عند نفاد رصيد SerpApi) |
| `/status` | عرض أقل سعر مسجل تاريخياً (مع التاريخ)، أقل سعر في آخر فحص، السعر المستهدف الحالي، وقت آخر إشعار، استهلاك رصيد SerpApi الشهري، وموعد الفحص المجدول القادم |
| `/top` | عرض أفضل الرحلات المحفوظة حالياً في قاعدة البيانات (مجمّعة حسب المسار مع أزرار الحجز) **بدون** استدعاء SerpApi وبدون استهلاك أي رصيد |
| `/route` | عرض المسار النشط الحالي |
| `/route <ORIGIN> <DEST>` | تغيير مسار البحث برمزي مطار IATA من 3 أحرف (مثال: `/route KUL DXB`) مع حفظ سجل الأسعار والإشعارات بشكل مستقل لكل مسار |
| `/dates` | عرض نطاق تواريخ البحث الحالي |
| `/dates <FROM> <TO>` | تعديل تواريخ البحث بصيغة `YYYY-MM-DD` (تواريخ مستقبلية، بحد أقصى 90 يوماً، مثال: `/dates 2026-12-01 2026-12-31`) |
| `/target <number>` | تعديل السعر المستهدف بالرينغيت الماليزي وحفظه في قاعدة البيانات (النطاق المسموح: `300` إلى `20000`، مثال: `/target 2200`) |
| `/budget` | عرض عدد عمليات البحث المستهلكة والمتبقية في SerpApi لهذا الشهر |

> ⚠️ **ملاحظة هامة حول الأوامر التفاعلية:** تتطلب أوامر تيليجرام التفاعلية بقاء العملية قيد التشغيل بشكل مستمر (`npm start` أو `npm run start:prod` على جهازك الشخصي أو على خادم VPS باستخدام **PM2** أو **systemd**). **لا تعمل** الأوامر التفاعلية عند الاعتماد فقط على **GitHub Actions** لأن GitHub Actions يشغّل البوت في وضع الفحص المفرد (`--once`) ثم يغلق العملية فوراً.

---

### 5. خيارات النشر والتشغيل المستمر (Deployment)

#### الخيار 1: GitHub Actions (مجاني تماماً — موصى به)
يوجد ملف جاهز في `.github/workflows/tracker.yml` يعمل يومياً الساعة `00:00 UTC` (أي `08:00 صباحاً` بتوقيت كوالالمبور) مع إمكانية التشغيل اليدوي (`workflow_dispatch`):
1. ارفع المشروع إلى مستودع GitHub خاص (Private Repository).
2. اذهب إلى **Settings ➔ Secrets and variables ➔ Actions** وأضف الأسرار التالية:
   - `DATABASE_URL`
   - `SERPAPI_KEY`
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_CHAT_ID`
   - (اختيارياً) `RESEND_API_KEY`, `EMAIL_FROM`, `EMAIL_TO`, `DATE_FROM`, `DATE_TO`, `TARGET_PRICE_MYR`
3. ادفع مخطط قاعدة البيانات مرة واحدة من جهازك عبر `npm run db:push`.

#### الخيار 2: خادم خاص (VPS — Ubuntu / Debian)
باستخدام **PM2**:
```bash
npm ci && npm run build
pm2 start npm --name flight-tracker -- run start:prod
pm2 save && pm2 startup
```

أو باستخدام خدمة **systemd** (`/etc/systemd/system/flight-tracker.service`):
```ini
[Unit]
Description=Flight Tracker Agent (KUL -> DAM)
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/opt/flight-tracker
EnvironmentFile=/opt/flight-tracker/.env
ExecStart=/usr/bin/node /opt/flight-tracker/dist/index.js
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
```
ثم فعّل الخدمة:
```bash
sudo systemctl daemon-reload
sudo systemctl enable --now flight-tracker
```

#### الخيار 3: Render Background Worker (خطة مدفوعة — لا توجد Workers مجانية)
1. أنشئ **Background Worker** جديداً في [Render](https://render.com) واربطه بالمستودع.
2. إعدادات البناء والتشغيل:
   - **Build Command:** `npm install && npm run build`
   - **Start Command:** `npm run start:prod`
3. أضف متغيرات البيئة من ملف `.env` في لوحة تحكم Render.

---
---

## 🇬🇧 English Documentation

### 1. Overview
An autonomous, production-ready TypeScript agent that searches **one-way** flights from **Kuala Lumpur (`KUL`) to Damascus (`DAM`)** within a target date window and enforces strict itinerary rules:
1. **Single ticket (Single PNR / true interline):** Automatically rejects self-transfer and separate-ticket itineraries or any route requiring bag re-check during transit.
2. **Checked baggage to DAM:** Requires at least `MIN_BAGGAGE_KG` (default `20 kg`) checked through to Damascus, or flags unknown baggage with an explicit Arabic warning when `BAGGAGE_UNKNOWN_POLICY="flag"`.
3. **Sane layovers:** Rejects any itinerary where any layover exceeds `MAX_LAYOVER_HOURS` (default `10 hours`).
4. **Price History:** Persists deduplicated offers and historical `PriceSnapshot` records in PostgreSQL (Neon) via Prisma v6.
5. **Arabic Notifications:** Delivers rich Arabic alerts via **Telegram Bot** (with inline booking buttons) and **Email (Resend)** (responsive RTL HTML + plain text fallback).

---

### 2. Quick Start (Zero-Config Dry Run)

```bash
npm install
npm run dry-run
```
`npm run dry-run` executes the full pipeline using realistic mock offers (without needing a database or API keys), prints the Arabic Telegram report and plain-text email to the console, and writes the RTL HTML email preview to `./dist-preview/email.html`.

---

### 3. Environment Configuration (`.env`)

Copy `.env.example` to `.env`:
```bash
cp .env.example .env
```

- **Neon PostgreSQL (`DATABASE_URL`):** Create a free database at [Neon.tech](https://neon.tech) and copy the **direct (non-pooled)** connection string into `DATABASE_URL`. Run `npm run db:push` to initialize the schema.
- **SerpApi (`SERPAPI_KEY`):** Get a free API key from [SerpApi](https://serpapi.com) (250 searches/month on the free plan). The built-in monthly budget guard (`SERPAPI_MONTHLY_BUDGET="240"`) tracks usage in PostgreSQL (`ApiUsage`) and samples `SERPAPI_DATES_PER_RUN="6"` dates per run, rotating interior dates by day-of-year.
- **Telegram (`TELEGRAM_BOT_TOKEN` & `TELEGRAM_CHAT_ID`):**
  1. Message **[@BotFather](https://t.me/BotFather)** on Telegram and send `/newbot`.
  2. Put the token in `TELEGRAM_BOT_TOKEN` inside `.env`.
  3. Open your new bot in Telegram and press **Start**.
  4. Run `npm run telegram:setup` to automatically discover your `TELEGRAM_CHAT_ID`.
  5. Add `TELEGRAM_CHAT_ID` to `.env` and run `npm run telegram:setup` again to send the Arabic test message (`"✅ تم ربط البوت بنجاح"`).
- **Email (`RESEND_API_KEY`, `EMAIL_FROM`, `EMAIL_TO`):**
  - Without a verified custom domain on Resend, you can only send from `onboarding@resend.dev` to the email address of the Resend account owner.
- **Optional Legacy Providers (`AMADEUS_*`, `KIWI_API_KEY`):**
  - Amadeus Self-Service was retired on **17 July 2026** (Enterprise credentials required).
  - Kiwi Tequila self-serve has been closed since May 2024 (invited B2B partners only).

---

### 4. Commands

- `npm run dry-run` — Run with mock data, no DB or API keys required.
- `npm run telegram:setup` — Discover `TELEGRAM_CHAT_ID` and send a test message.
- `npm run db:push` — Push Prisma schema to PostgreSQL.
- `npm run run:now` — Run once immediately and force notifications (`FORCED`).
- `npm run run:once` — Run once honoring notification rules (`NEW_LOW`, `TARGET_HIT`, `DAILY`), then exit.
- `npm start` — Run once on startup and continue on `CRON_SCHEDULE` in `TZ_NAME`.
- `npm test` — Run unit tests (`tsx --test`).
- `npm run typecheck` — Run TypeScript type checker (`tsc --noEmit`).
- `npm run build` / `npm run start:prod` — Compile to `dist/` and run compiled JS.

---

### 4.1 Interactive Telegram Bot Commands

When running in the default long-lived worker mode (`npm start` or `npm run start:prod`) with `TELEGRAM_COMMANDS_ENABLED="true"` (default), the bot long-polls Telegram `getUpdates` and registers its Arabic command menu via `setMyCommands`. For security, updates from any chat whose `chat.id !== TELEGRAM_CHAT_ID` are silently ignored (with a masked warning log).

| Telegram Command | Description |
|---|---|
| `/start` or `/help` | List all available bot commands in Arabic |
| `/search` | Trigger `runFlightTrackerAgent({ forceNotify: true })` immediately. Replies `"⏳ جاري البحث..."`, refuses if a run is already in progress, enforces a 30-minute cooldown (`SEARCH_COOLDOWN_MIN="30"`), and refuses if the SerpApi monthly budget is exhausted |
| `/status` | Show lowest price ever recorded (with date), lowest price from the latest run, current effective `TARGET_PRICE_MYR`, last notification time, monthly SerpApi searches used/budget, and next scheduled run time |
| `/top` | Display the current best itineraries stored in the database (up to `TELEGRAM_TOP_N`, grouped with inline booking buttons) **without** calling SerpApi (zero budget usage) |
| `/route` | Show the current active route |
| `/route <ORIGIN> <DEST>` | Validate two distinct 3-letter IATA codes (e.g. `/route KUL DXB`), persist in `Setting` (`ROUTE`), confirm with Arabic city names, and isolate price history per route |
| `/dates` | Show the current search date window |
| `/dates <FROM> <TO>` | Validate (`YYYY-MM-DD`, future dates, `from <= to`, max 90 days), persist in `Setting` (`DATE_FROM`, `DATE_TO`), and confirm |
| `/target <number>` | Validate (`300`–`20000` MYR), persist the new target price in the `Setting` table (`TARGET_PRICE_MYR`), and confirm |
| `/budget` | Show SerpApi searches used and remaining for the current month |

> ⚠️ **Important Note:** Interactive Telegram commands require the Node.js process to stay running continuously (e.g., on your own PC or a VPS managed with **PM2** / **systemd** using `npm start` or `npm run start:prod`). They do **not** work when running exclusively via **GitHub Actions** (`--once`), because GitHub Actions only starts the process for a single scheduled check and exits immediately.

---

### 5. Deployment Options

1. **GitHub Actions (Free):** Uses `.github/workflows/tracker.yml` (`cron: "0 0 * * *"` = 08:00 Malaysia time + `workflow_dispatch`). Configure repository secrets (`DATABASE_URL`, `SERPAPI_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, etc.) under *Settings ➔ Secrets and variables ➔ Actions*.
2. **VPS (PM2 or systemd):** Run `npm ci && npm run build`, then `pm2 start npm --name flight-tracker -- run start:prod` or use the systemd unit file provided above.
3. **Render Background Worker (Paid plan):** Set Build Command to `npm install && npm run build` and Start Command to `npm run start:prod`, and add environment variables in the Render dashboard.

