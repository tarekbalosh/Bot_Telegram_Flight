import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  checkSearchCooldown,
  getEffectiveTarget,
  handleTelegramUpdate,
  isAuthorizedChat,
  parseTelegramCommand,
  TelegramUpdate,
  validateTargetPrice,
} from "../services/telegram-commands";
import { TelegramMessagePayload } from "../services/telegram";
import { UnifiedFlightOffer } from "../types/flight";

describe("Telegram Interactive Commands (telegram-commands.ts)", () => {
  describe("parseTelegramCommand & validateTargetPrice", () => {
    it("parses standard commands and /command@BotName forms with arguments", () => {
      assert.deepEqual(parseTelegramCommand("/start"), {
        command: "start",
        rawCommand: "/start",
        args: "",
      });
      assert.deepEqual(parseTelegramCommand("/help@DamascusFlightsBot"), {
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

      // Invalid cases
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

  describe("getEffectiveTarget fallback & persistence", () => {
    it("returns DB value when TARGET_PRICE_MYR exists in Setting", async () => {
      const target = await getEffectiveTarget({
        fallbackTargetMyr: 2500,
        store: {
          findUnique: async ({ where }) =>
            where.key === "TARGET_PRICE_MYR"
              ? { key: "TARGET_PRICE_MYR", value: "1950" }
              : null,
        },
      });
      assert.equal(target, 1950);
    });

    it("falls back to env.TARGET_PRICE_MYR when DB row is missing, invalid, or store throws", async () => {
      const missingTarget = await getEffectiveTarget({
        fallbackTargetMyr: 2500,
        store: {
          findUnique: async () => null,
        },
      });
      assert.equal(missingTarget, 2500);

      const invalidTarget = await getEffectiveTarget({
        fallbackTargetMyr: 2500,
        store: {
          findUnique: async () => ({
            key: "TARGET_PRICE_MYR",
            value: "not-a-number",
          }),
        },
      });
      assert.equal(invalidTarget, 2500);

      const errorTarget = await getEffectiveTarget({
        fallbackTargetMyr: 2500,
        store: {
          findUnique: async () => {
            throw new Error("DB connection failed");
          },
        },
      });
      assert.equal(errorTarget, 2500);
    });
  });

  describe("Command Execution (/search, /target, /top, /budget, /status, unknown)", () => {
    it("handles /target@BotName 2100 and rejects out-of-range /target 100", async () => {
      const replies: string[] = [];
      let savedTarget: number | null = null;

      await handleTelegramUpdate(
        {
          update_id: 1,
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
          update_id: 2,
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

      // 4. Allowed: replies "⏳ جاري البحث..." immediately and invokes runFlightTrackerAgent({ forceNotify: true })
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

    it("renders /top from DB offers without calling SerpApi and replies with help hint for unknown commands", async () => {
      const payloads: TelegramMessagePayload[] = [];
      const mockOffer: UnifiedFlightOffer = {
        externalId: "ext-top-1",
        provider: "SERPAPI",
        origin: "KUL",
        destination: "DAM",
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
      assert.ok(payloads[0].reply_markup?.inline_keyboard.length === 1);

      // Unknown command
      payloads.length = 0;
      await handleTelegramUpdate(
        {
          update_id: 21,
          message: { chat: { id: 12345 }, text: "/nonexistent" },
        },
        {
          authorizedChatId: "12345",
          sendMessage: async (p) => {
            payloads.push(p);
            return { ok: true };
          },
        }
      );
      assert.equal(payloads.length, 1);
      assert.ok(payloads[0].text.includes("/help"));
    });
  });
});

