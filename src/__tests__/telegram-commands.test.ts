import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  buildRouteInfo,
  getAirportNameAr,
  isValidIataCode,
  parseRouteKey,
  parseWatchRoutes,
  splitDatesPerRunAcrossRoutes,
  validateRouteArgs,
} from "../utils/airports";
import {
  checkSearchCooldown,
  getEffectiveDates,
  getEffectiveRoute,
  getEffectiveTarget,
  getEffectiveWatchRoutes,
  handleTelegramUpdate,
  isAuthorizedChat,
  parseTelegramCommand,
  TelegramUpdate,
  validateDatesArgs,
  validateTargetPrice,
} from "../services/telegram-commands";
import { TelegramMessagePayload } from "../services/telegram";
import {
  executeSingleRouteRun,
  RoutePersistenceStore,
} from "../services/tracker";
import { UnifiedFlightOffer } from "../types/flight";

function collectSourceFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(fullPath);
    }
  }
  return files;
}

describe("Telegram Interactive Commands & Dynamic Routes", () => {
  describe("parseTelegramCommand & validateTargetPrice", () => {
    it("parses standard commands and /command@BotName forms with arguments", () => {
      assert.deepEqual(parseTelegramCommand("/start"), {
        command: "start",
        rawCommand: "/start",
        args: "",
      });
      assert.deepEqual(parseTelegramCommand("/help@GlobalFlightsBot"), {
        command: "help",
        rawCommand: "/help",
        args: "",
      });
      assert.deepEqual(parseTelegramCommand("/target@BotName 2000"), {
        command: "target",
        rawCommand: "/target",
        args: "2000",
      });
      assert.deepEqual(parseTelegramCommand("  /TARGET@My_Bot   1850.50  "), {
        command: "target",
        rawCommand: "/target",
        args: "1850.50",
      });
      assert.deepEqual(parseTelegramCommand("/route@BotName SIN DXB"), {
        command: "route",
        rawCommand: "/route",
        args: "SIN DXB",
      });
      assert.deepEqual(
        parseTelegramCommand("/dates@BotName 2026-12-01 2026-12-31"),
        {
          command: "dates",
          rawCommand: "/dates",
          args: "2026-12-01 2026-12-31",
        }
      );
      assert.deepEqual(parseTelegramCommand("/search"), {
        command: "search",
        rawCommand: "/search",
        args: "",
      });
      assert.deepEqual(parseTelegramCommand("/status"), {
        command: "status",
        rawCommand: "/status",
        args: "",
      });
      assert.deepEqual(parseTelegramCommand("/top"), {
        command: "top",
        rawCommand: "/top",
        args: "",
      });
      assert.deepEqual(parseTelegramCommand("/budget"), {
        command: "budget",
        rawCommand: "/budget",
        args: "",
      });
    });

    it("classifies unknown commands and plain text as unknown", () => {
      const unknownSlash = parseTelegramCommand("/foobar@BotName 123");
      assert.equal(unknownSlash.command, "unknown");
      assert.equal(unknownSlash.rawCommand, "/foobar");

      const plainText = parseTelegramCommand("مرحبا");
      assert.equal(plainText.command, "unknown");
    });

    it("validates /target numbers strictly within [300, 20000]", () => {
      assert.deepEqual(validateTargetPrice("2000"), { ok: true, value: 2000 });
      assert.deepEqual(validateTargetPrice("300"), { ok: true, value: 300 });
      assert.deepEqual(validateTargetPrice("20000"), {
        ok: true,
        value: 20000,
      });
      assert.deepEqual(validateTargetPrice("٢٢٥٠"), { ok: true, value: 2250 });

      assert.equal(validateTargetPrice("").ok, false);
      assert.equal(validateTargetPrice("   ").reason, "missing");
      assert.equal(validateTargetPrice("abc").reason, "not_a_number");
      assert.equal(validateTargetPrice("2000 MYR").reason, "not_a_number");
      assert.equal(validateTargetPrice("NaN").reason, "not_a_number");
      assert.equal(validateTargetPrice("-1500").reason, "out_of_range");
      assert.equal(validateTargetPrice("0").reason, "out_of_range");
      assert.equal(validateTargetPrice("299").reason, "out_of_range");
      assert.equal(validateTargetPrice("20001").reason, "out_of_range");
    });
  });

  describe("IATA validation, route parsing & date range validation", () => {
    it("validates 3-letter IATA codes, resolves Arabic airport names, and falls back to IATA code when unknown", () => {
      assert.equal(isValidIataCode("SIN"), true);
      assert.equal(isValidIataCode("dxb"), true);
      assert.equal(isValidIataCode("AB"), false);
      assert.equal(isValidIataCode("ABCD"), false);
      assert.equal(isValidIataCode("12A"), false);

      assert.equal(getAirportNameAr("DXB"), "دبي");
      assert.equal(getAirportNameAr("IST"), "إسطنبول");
      assert.equal(getAirportNameAr("CAI"), "القاهرة");
      assert.equal(getAirportNameAr("XYZ"), "XYZ");
    });

    it("parses routes and validates /route arguments (rejecting identical or malformed IATA codes)", () => {
      const valid = validateRouteArgs("sin dxb");
      assert.equal(valid.ok, true);
      assert.equal(valid.route?.routeKey, "SIN-DXB");
      assert.equal(valid.route?.originNameAr, "سنغافورة");
      assert.equal(valid.route?.destinationNameAr, "دبي");

      const validHyphen = parseRouteKey("IST-CAI");
      assert.ok(validHyphen);
      assert.equal(validHyphen.origin, "IST");
      assert.equal(validHyphen.destination, "CAI");

      const sameAirport = validateRouteArgs("DXB DXB");
      assert.equal(sameAirport.ok, false);
      assert.equal(sameAirport.reason, "same_airport");

      const badCode = validateRouteArgs("SIN DXBB");
      assert.equal(badCode.ok, false);
      assert.equal(badCode.reason, "invalid_format");

      const singleToken = validateRouteArgs("SIN");
      assert.equal(singleToken.ok, false);
      assert.equal(singleToken.reason, "invalid_format");
    });

    it("parses WATCH_ROUTES and splits SERPAPI_DATES_PER_RUN across watched routes without exceeding budget", () => {
      const primary = buildRouteInfo("SIN", "DXB");
      const watched = parseWatchRoutes("SIN-DXB, SIN-CAI, IST-AMM", primary);
      assert.deepEqual(
        watched.map((r) => r.routeKey),
        ["SIN-DXB", "SIN-CAI", "IST-AMM"]
      );

      const alloc2 = splitDatesPerRunAcrossRoutes(6, 2);
      assert.deepEqual(alloc2, [3, 3]);
      assert.equal(
        alloc2.reduce((a, b) => a + b, 0),
        6
      );

      const alloc4 = splitDatesPerRunAcrossRoutes(6, 4);
      assert.deepEqual(alloc4, [2, 2, 1, 1]);
      assert.equal(
        alloc4.reduce((a, b) => a + b, 0),
        6
      );
    });

    it("validates /dates arguments (future dates, from <= to, max 90 days)", () => {
      const refNow = new Date("2026-11-11T10:00:00.000Z");

      const valid = validateDatesArgs("2026-12-01 2026-12-31", refNow);
      assert.equal(valid.ok, true);
      assert.deepEqual(valid.dates, {
        dateFrom: "2026-12-01",
        dateTo: "2026-12-31",
      });

      const past = validateDatesArgs("2026-10-01 2026-10-15", refNow);
      assert.equal(past.ok, false);
      assert.equal(past.reason, "past_date");

      const reversed = validateDatesArgs("2026-12-20 2026-12-05", refNow);
      assert.equal(reversed.ok, false);
      assert.equal(reversed.reason, "from_after_to");

      const tooLong = validateDatesArgs("2026-12-01 2027-04-15", refNow);
      assert.equal(tooLong.ok, false);
      assert.equal(tooLong.reason, "range_too_long");

      const invalidCalendar = validateDatesArgs("2026-02-30 2026-03-10", refNow);
      assert.equal(invalidCalendar.ok, false);
      assert.equal(invalidCalendar.reason, "invalid_format");
    });
  });

  describe("checkSearchCooldown", () => {
    it("allows search when no previous manual search exists", () => {
      const res = checkSearchCooldown(null, 30, 1_700_000_000_000);
      assert.equal(res.allowed, true);
      assert.equal(res.remainingMinutes, 0);
    });

    it("blocks search when within the 30-minute cooldown window and reports remaining minutes", () => {
      const lastSearch = new Date("2026-11-11T10:00:00.000Z");
      const tenMinutesLater = new Date("2026-11-11T10:10:00.000Z").getTime();

      const res = checkSearchCooldown(lastSearch, 30, tenMinutesLater);
      assert.equal(res.allowed, false);
      assert.equal(res.remainingMinutes, 20);
    });

    it("allows search once the 30-minute cooldown has elapsed", () => {
      const lastSearch = new Date("2026-11-11T10:00:00.000Z");
      const thirtyMinutesLater = new Date("2026-11-11T10:30:00.000Z").getTime();

      const res = checkSearchCooldown(lastSearch, 30, thirtyMinutesLater);
      assert.equal(res.allowed, true);
      assert.equal(res.remainingMinutes, 0);
    });
  });

  describe("Unauthorized chat rejection", () => {
    it("ignores updates from unauthorized chat IDs without sending any reply", async () => {
      assert.equal(isAuthorizedChat(999999, "123456"), false);
      assert.equal(isAuthorizedChat("999999", "123456"), false);
      assert.equal(isAuthorizedChat(123456, "123456"), true);

      const sentPayloads: TelegramMessagePayload[] = [];
      let agentCalled = false;

      const strangerUpdate: TelegramUpdate = {
        update_id: 1001,
        message: {
          message_id: 1,
          chat: { id: 999999, type: "private", username: "stranger" },
          text: "/search",
        },
      };

      const result = await handleTelegramUpdate(strangerUpdate, {
        authorizedChatId: "123456",
        sendMessage: async (p) => {
          sentPayloads.push(p);
          return { ok: true };
        },
        runAgent: async () => {
          agentCalled = true;
          return {
            rawCount: 0,
            validCount: 0,
            lowestPriceMYR: null,
            notified: [],
          };
        },
      });

      assert.equal(result.handled, false);
      assert.equal(sentPayloads.length, 0);
      assert.equal(agentCalled, false);
    });
  });

  describe("getEffective* fallbacks (Target, Route, Dates, WatchRoutes)", () => {
    it("returns DB values when present and falls back to env/defaults when missing or invalid", async () => {
      // 1. Target price
      const dbTarget = await getEffectiveTarget({
        fallbackTargetMyr: 2500,
        store: {
          findUnique: async ({ where }) =>
            where.key === "TARGET_PRICE_MYR"
              ? { key: "TARGET_PRICE_MYR", value: "1950" }
              : null,
        },
      });
      assert.equal(dbTarget, 1950);

      const fallbackTarget = await getEffectiveTarget({
        fallbackTargetMyr: 2500,
        store: { findUnique: async () => null },
      });
      assert.equal(fallbackTarget, 2500);

      // 2. Route
      const dbRoute = await getEffectiveRoute({
        fallbackOrigin: "SIN",
        fallbackDestination: "DOH",
        store: {
          findUnique: async ({ where }) =>
            where.key === "ROUTE" ? { key: "ROUTE", value: "SIN-DXB" } : null,
        },
      });
      assert.equal(dbRoute.routeKey, "SIN-DXB");

      const fallbackRoute = await getEffectiveRoute({
        fallbackOrigin: "SIN",
        fallbackDestination: "DOH",
        store: {
          findUnique: async () => ({ key: "ROUTE", value: "INVALID" }),
        },
      });
      assert.equal(fallbackRoute.routeKey, "SIN-DOH");

      // 3. Dates
      const dbDates = await getEffectiveDates({
        fallbackDateFrom: "2026-12-01",
        fallbackDateTo: "2026-12-31",
        store: {
          findUnique: async ({ where }) => {
            if (where.key === "DATE_FROM") {
              return { key: "DATE_FROM", value: "2026-12-10" };
            }
            if (where.key === "DATE_TO") {
              return { key: "DATE_TO", value: "2026-12-25" };
            }
            return null;
          },
        },
      });
      assert.deepEqual(dbDates, {
        dateFrom: "2026-12-10",
        dateTo: "2026-12-25",
      });

      const fallbackDates = await getEffectiveDates({
        fallbackDateFrom: "2026-12-01",
        fallbackDateTo: "2026-12-31",
        store: {
          findUnique: async () => null,
        },
      });
      assert.deepEqual(fallbackDates, {
        dateFrom: "2026-12-01",
        dateTo: "2026-12-31",
      });

      // 4. Watch routes
      const watched = await getEffectiveWatchRoutes({
        fallbackOrigin: "SIN",
        fallbackDestination: "DXB",
        watchRoutesRaw: "SIN-DXB,IST-CAI",
        store: { findUnique: async () => null },
      });
      assert.deepEqual(
        watched.map((r) => r.routeKey),
        ["SIN-DXB", "IST-CAI"]
      );
    });
  });

  describe("Per-route history isolation", () => {
    it("isolates previousLowestMyr and lastNotification per route so switching routes never mixes history", async () => {
      const snapshotsByRoute = new Map<string, number[]>();
      const notifsByRoute = new Map<
        string,
        Array<{ lowestPriceMYR: number; sentAt: Date }>
      >();

      // Pre-populate Route A (SIN-DXB) with a cheap historical price of 1200 MYR and recent notification
      snapshotsByRoute.set("SIN-DXB", [1200]);
      notifsByRoute.set("SIN-DXB", [
        { lowestPriceMYR: 1200, sentAt: new Date() },
      ]);

      const memoryStore: RoutePersistenceStore = {
        async getRouteHistory(routeKey: string) {
          const prices = snapshotsByRoute.get(routeKey) ?? [];
          const notifs = notifsByRoute.get(routeKey) ?? [];
          return {
            previousLowestMyr: prices.length > 0 ? Math.min(...prices) : null,
            lastNotification:
              notifs.length > 0 ? notifs[notifs.length - 1] : null,
          };
        },
        async persistRouteOffers(routeKey, offers) {
          const list = snapshotsByRoute.get(routeKey) ?? [];
          for (const o of offers) {
            list.push(o.priceMYR);
          }
          snapshotsByRoute.set(routeKey, list);
        },
        async recordNotification({ routeKey, lowestPriceMYR }) {
          const list = notifsByRoute.get(routeKey) ?? [];
          list.push({ lowestPriceMYR, sentAt: new Date() });
          notifsByRoute.set(routeKey, list);
        },
      };

      const makeOfferForRoute = (
        origin: string,
        destination: string,
        priceMYR: number
      ): UnifiedFlightOffer => ({
        externalId: `ext-${origin}-${destination}-${priceMYR}`,
        provider: "SERPAPI",
        origin,
        destination,
        priceMYR,
        priceUSD: priceMYR * 0.22,
        departureDate: "2026-12-10",
        departureTime: "2026-12-10 08:00",
        arrivalTime: "2026-12-10 18:00",
        airlines: ["Qatar Airways"],
        flightNumbers: ["QR 101", "QR 202"],
        transitAirports: ["DOH"],
        layoverDurationsHours: [3.0],
        totalDurationHours: 10.0,
        checkedBaggageKg: 25,
        baggageVerified: true,
        isSinglePNR: true,
        bagsRecheckRequired: false,
        bookingLink: "https://www.google.com/travel/flights",
      });

      // Route A (SIN-DXB) sees 2600 MYR (> previous 1200 MYR, > target 2500, recent notif) -> no notification
      const summaryA = await executeSingleRouteRun({
        route: buildRouteInfo("SIN", "DXB"),
        dates: { dateFrom: "2026-12-01", dateTo: "2026-12-31" },
        datesPerRun: 3,
        targetPriceMyr: 2500,
        dryRun: false,
        forceNotify: false,
        noNotify: false,
        store: memoryStore,
        fetchOffersFn: async () => [makeOfferForRoute("SIN", "DXB", 2600)],
        notifyTelegramFn: async () => ({ ok: true }),
      });
      assert.equal(summaryA.reason, null);
      assert.equal(summaryA.notified.length, 0);

      // Route B (SIN-CAI) sees 2600 MYR for the first time -> triggers NEW_LOW because Route B has its own empty history!
      const summaryB = await executeSingleRouteRun({
        route: buildRouteInfo("SIN", "CAI"),
        dates: { dateFrom: "2026-12-01", dateTo: "2026-12-31" },
        datesPerRun: 3,
        targetPriceMyr: 2500,
        dryRun: false,
        forceNotify: false,
        noNotify: false,
        store: memoryStore,
        fetchOffersFn: async () => [makeOfferForRoute("SIN", "CAI", 2600)],
        notifyTelegramFn: async () => ({ ok: true }),
      });
      assert.equal(summaryB.reason, "NEW_LOW");
      assert.deepEqual(summaryB.notified, ["TELEGRAM"]);
      assert.deepEqual(snapshotsByRoute.get("SIN-CAI"), [2600]);
    });
  });

  describe("Command Execution (/route, /dates, /search, /target, /top, unknown)", () => {
    it("handles /route and /dates commands (display, validation, persistence, and Arabic confirmation)", async () => {
      const replies: string[] = [];
      let savedRouteKey: string | null = null;
      let savedDates: { dateFrom: string; dateTo: string } | null = null;

      // /route SIN DXB
      await handleTelegramUpdate(
        {
          update_id: 1,
          message: { chat: { id: 12345 }, text: "/route SIN DXB" },
        },
        {
          authorizedChatId: "12345",
          sendMessage: async (p) => {
            replies.push(p.text);
            return { ok: true };
          },
          setEffectiveRoute: async (orig, dest) => {
            const info = buildRouteInfo(orig, dest);
            savedRouteKey = info.routeKey;
            return info;
          },
        }
      );

      assert.equal(savedRouteKey, "SIN-DXB");
      assert.equal(replies.length, 1);
      assert.ok(replies[0].includes("سنغافورة (SIN)"));
      assert.ok(replies[0].includes("دبي (DXB)"));
      assert.ok(replies[0].includes("مستقل لكل مسار"));

      // /dates 2026-12-05 2026-12-25
      replies.length = 0;
      await handleTelegramUpdate(
        {
          update_id: 2,
          message: {
            chat: { id: 12345 },
            text: "/dates 2026-12-05 2026-12-25",
          },
        },
        {
          authorizedChatId: "12345",
          now: () => new Date("2026-11-11T00:00:00.000Z"),
          sendMessage: async (p) => {
            replies.push(p.text);
            return { ok: true };
          },
          setEffectiveDates: async (dateFrom, dateTo) => {
            savedDates = { dateFrom, dateTo };
            return savedDates;
          },
        }
      );

      assert.deepEqual(savedDates, {
        dateFrom: "2026-12-05",
        dateTo: "2026-12-25",
      });
      assert.equal(replies.length, 1);
      assert.ok(replies[0].includes("2026-12-05"));
      assert.ok(replies[0].includes("2026-12-25"));
    });

    it("handles /target@BotName 2100 and rejects out-of-range /target 100", async () => {
      const replies: string[] = [];
      let savedTarget: number | null = null;

      await handleTelegramUpdate(
        {
          update_id: 3,
          message: { chat: { id: 12345 }, text: "/target@MyBot 2100" },
        },
        {
          authorizedChatId: "12345",
          sendMessage: async (p) => {
            replies.push(p.text);
            return { ok: true };
          },
          setEffectiveTarget: async (val) => {
            savedTarget = val;
          },
        }
      );

      assert.equal(savedTarget, 2100);
      assert.equal(replies.length, 1);
      assert.ok(replies[0].includes("2,100"));

      replies.length = 0;
      savedTarget = null;

      await handleTelegramUpdate(
        {
          update_id: 4,
          message: { chat: { id: 12345 }, text: "/target 100" },
        },
        {
          authorizedChatId: "12345",
          sendMessage: async (p) => {
            replies.push(p.text);
            return { ok: true };
          },
          setEffectiveTarget: async (val) => {
            savedTarget = val;
          },
        }
      );

      assert.equal(savedTarget, null);
      assert.equal(replies.length, 1);
      assert.ok(replies[0].includes("غير صالحة"));
    });

    it("refuses /search when a run is already in progress, on cooldown, or when budget is exhausted", async () => {
      const replies: string[] = [];
      let agentCalls = 0;

      // 1. Mutex active
      await handleTelegramUpdate(
        {
          update_id: 10,
          message: { chat: { id: 12345 }, text: "/search" },
        },
        {
          authorizedChatId: "12345",
          isRunInProgress: () => true,
          sendMessage: async (p) => {
            replies.push(p.text);
            return { ok: true };
          },
          runAgent: async () => {
            agentCalls++;
            return {
              rawCount: 0,
              validCount: 0,
              lowestPriceMYR: null,
              notified: [],
            };
          },
        }
      );
      assert.equal(agentCalls, 0);
      assert.ok(replies[0].includes("قيد التنفيذ"));

      // 2. Cooldown active
      replies.length = 0;
      const now = new Date("2026-11-11T12:15:00.000Z");
      const lastManual = new Date("2026-11-11T12:00:00.000Z");
      await handleTelegramUpdate(
        {
          update_id: 11,
          message: { chat: { id: 12345 }, text: "/search" },
        },
        {
          authorizedChatId: "12345",
          isRunInProgress: () => false,
          now: () => now,
          cooldownMinutes: 30,
          getLastManualSearchTime: async () => lastManual,
          sendMessage: async (p) => {
            replies.push(p.text);
            return { ok: true };
          },
          runAgent: async () => {
            agentCalls++;
            return {
              rawCount: 0,
              validCount: 0,
              lowestPriceMYR: null,
              notified: [],
            };
          },
        }
      );
      assert.equal(agentCalls, 0);
      assert.ok(replies[0].includes("15 دقيقة"));

      // 3. Budget exhausted
      replies.length = 0;
      await handleTelegramUpdate(
        {
          update_id: 12,
          message: { chat: { id: 12345 }, text: "/search" },
        },
        {
          authorizedChatId: "12345",
          isRunInProgress: () => false,
          now: () => now,
          cooldownMinutes: 30,
          getLastManualSearchTime: async () => null,
          getBudgetStatus: async () => ({
            monthKey: "2026-11",
            used: 240,
            budget: 240,
            remaining: 0,
          }),
          sendMessage: async (p) => {
            replies.push(p.text);
            return { ok: true };
          },
          runAgent: async () => {
            agentCalls++;
            return {
              rawCount: 0,
              validCount: 0,
              lowestPriceMYR: null,
              notified: [],
            };
          },
        }
      );
      assert.equal(agentCalls, 0);
      assert.ok(replies[0].includes("استنفاد"));
      assert.ok(replies[0].includes("0"));

      // 4. Allowed
      replies.length = 0;
      let recordedManualSearch: Date | null = null;
      let passedForceNotify: boolean | undefined;

      await handleTelegramUpdate(
        {
          update_id: 13,
          message: { chat: { id: 12345 }, text: "/search" },
        },
        {
          authorizedChatId: "12345",
          isRunInProgress: () => false,
          now: () => now,
          cooldownMinutes: 30,
          getLastManualSearchTime: async () => null,
          setLastManualSearchTime: async (d) => {
            recordedManualSearch = d;
          },
          getBudgetStatus: async () => ({
            monthKey: "2026-11",
            used: 50,
            budget: 240,
            remaining: 190,
          }),
          sendMessage: async (p) => {
            replies.push(p.text);
            return { ok: true };
          },
          runAgent: async (opts) => {
            agentCalls++;
            passedForceNotify = opts.forceNotify;
            return {
              rawCount: 5,
              validCount: 2,
              lowestPriceMYR: 1990,
              notified: ["TELEGRAM"],
              reason: "FORCED",
            };
          },
        }
      );

      assert.equal(agentCalls, 1);
      assert.equal(passedForceNotify, true);
      assert.deepEqual(recordedManualSearch, now);
      assert.equal(replies[0], "⏳ جاري البحث...");
    });

    it("renders /top from DB offers for the active route without calling SerpApi", async () => {
      const payloads: TelegramMessagePayload[] = [];
      const mockOffer: UnifiedFlightOffer = {
        externalId: "ext-top-1",
        provider: "SERPAPI",
        origin: "SIN",
        destination: "DXB",
        priceMYR: 1950,
        priceUSD: 429,
        departureDate: "2026-12-10",
        departureTime: "2026-12-10 02:45",
        arrivalTime: "2026-12-10 14:15",
        airlines: ["Qatar Airways"],
        flightNumbers: ["QR 853", "QR 410"],
        transitAirports: ["DOH"],
        layoverDurationsHours: [3.5],
        totalDurationHours: 14.5,
        checkedBaggageKg: 25,
        baggageVerified: true,
        isSinglePNR: true,
        bagsRecheckRequired: false,
        bookingLink: "https://www.google.com/travel/flights?id=top1",
      };

      await handleTelegramUpdate(
        {
          update_id: 20,
          message: { chat: { id: 12345 }, text: "/top" },
        },
        {
          authorizedChatId: "12345",
          getEffectiveRoute: async () => buildRouteInfo("SIN", "DXB"),
          getTopOffers: async () => [mockOffer],
          getEffectiveTarget: async () => 2200,
          sendMessage: async (p) => {
            payloads.push(p);
            return { ok: true };
          },
        }
      );

      assert.equal(payloads.length, 1);
      assert.ok(payloads[0].text.includes("1,950"));
      assert.ok(payloads[0].text.includes("دبي"));
      assert.ok(payloads[0].reply_markup?.inline_keyboard.length === 1);
    });
  });

  describe("No hardcoded route strings check (grep-based test)", () => {
    it("has no hardcoded route strings in src/ outside src/utils/airports.ts", () => {
      const srcRoot = path.resolve(__dirname, "..");
      const allFiles = collectSourceFiles(srcRoot);

      // Construct forbidden tokens dynamically so this test file itself has no literal matches
      const forbiddenTokens = [
        ["K", "U", "L"].join(""),
        ["D", "A", "M"].join(""),
        ["Dama", "scus"].join(""),
        ["دم", "شق"].join(""),
        ["كوالا", "لمبور"].join(""),
      ];
      const pattern = new RegExp(forbiddenTokens.join("|"));

      const violations: string[] = [];

      for (const filePath of allFiles) {
        const relPath = path.relative(srcRoot, filePath).replace(/\\/g, "/");
        if (relPath === "utils/airports.ts") {
          continue;
        }
        const content = fs.readFileSync(filePath, "utf8");
        const lines = content.split("\n");
        lines.forEach((line, idx) => {
          if (pattern.test(line)) {
            violations.push(`${relPath}:${idx + 1}: ${line.trim()}`);
          }
        });
      }

      assert.deepEqual(
        violations,
        [],
        `Found hardcoded route strings in src/:\n${violations.join("\n")}`
      );
    });
  });
});
