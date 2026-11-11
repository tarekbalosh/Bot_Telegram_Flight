import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildInlineKeyboard, buildTelegramPayloads } from "../services/telegram";
import { UnifiedFlightOffer } from "../types/flight";
import { maskSecrets } from "../utils/logger";

function createTestOffer(
  index: number,
  overrides: Partial<UnifiedFlightOffer> = {}
): UnifiedFlightOffer {
  return {
    externalId: `ext-${index}`,
    provider: "SERPAPI",
    origin: "KUL",
    destination: "DAM",
    priceMYR: 2000 + index * 100,
    priceUSD: 440 + index * 22,
    departureDate: `2026-12-1${index}`,
    departureTime: `2026-12-1${index} 02:45`,
    arrivalTime: `2026-12-1${index} 14:15`,
    airlines: ["Qatar Airways"],
    flightNumbers: [`QR 85${index}`, `QR 41${index}`],
    transitAirports: ["DOH"],
    layoverDurationsHours: [3.5],
    totalDurationHours: 14.5,
    checkedBaggageKg: 23,
    baggageVerified: true,
    isSinglePNR: true,
    bagsRecheckRequired: false,
    bookingLink: `https://www.google.com/travel/flights?id=${index}`,
    ...overrides,
  };
}

describe("Telegram Service (telegram.ts)", () => {
  it("renders top 3 flights in a single message when under 4096 chars and attaches inline keyboard", () => {
    const offers = [
      createTestOffer(1),
      createTestOffer(2),
      createTestOffer(3),
      createTestOffer(4),
    ];

    const payloads = buildTelegramPayloads(offers, { targetPriceMyr: 2500 });
    assert.equal(payloads.length, 1);
    assert.ok(payloads[0].text.length <= 4096);
    assert.ok(payloads[0].text.includes("الرحلة #1"));
    assert.ok(payloads[0].text.includes("الرحلة #2"));
    assert.ok(payloads[0].text.includes("الرحلة #3"));
    assert.ok(!payloads[0].text.includes("الرحلة #4"));
    assert.ok(payloads[0].text.includes("تم تحقيق السعر المستهدف ✅"));

    const keyboard = payloads[0].reply_markup?.inline_keyboard;
    assert.ok(keyboard);
    assert.equal(keyboard.length, 3);
    assert.equal(keyboard[0][0].text, "حجز الرحلة #1 ✈️");
    assert.equal(
      keyboard[0][0].url,
      "https://www.google.com/travel/flights?id=1"
    );
  });

  it("splits messages on flight boundaries when message exceeds maxLen and puts keyboard only on the last message", () => {
    const offers = [
      createTestOffer(1),
      createTestOffer(2),
      createTestOffer(3),
    ];

    // Force a tight maxLen so flights cannot all fit in one message
    const payloads = buildTelegramPayloads(offers, {
      targetPriceMyr: 2500,
      maxLen: 750,
    });

    assert.ok(payloads.length >= 2);
    for (let i = 0; i < payloads.length - 1; i++) {
      assert.equal(payloads[i].reply_markup, undefined);
      assert.ok(payloads[i].text.length <= 750);
    }

    const lastPayload = payloads[payloads.length - 1];
    assert.ok(lastPayload.reply_markup);
    assert.equal(lastPayload.reply_markup.inline_keyboard.length, 3);
  });

  it("escapes dynamic HTML characters in airlines, flight numbers, and booking links", () => {
    const maliciousOffer = createTestOffer(1, {
      airlines: [`Airline <script>&"bad"</script>`],
      flightNumbers: [`QR <123>`],
      bookingLink: `https://www.google.com/travel/flights?a=1&b=2`,
    });

    const payloads = buildTelegramPayloads([maliciousOffer]);
    const text = payloads[0].text;

    assert.ok(!text.includes("<script>"));
    assert.ok(
      text.includes("Airline &lt;script&gt;&amp;&quot;bad&quot;&lt;/script&gt;")
    );
    assert.ok(text.includes("QR &lt;123&gt;"));
    assert.ok(
      text.includes("https://www.google.com/travel/flights?a=1&amp;b=2")
    );
  });

  it("only includes valid http(s) URLs in inline keyboard", () => {
    const offers = [
      createTestOffer(1, { bookingLink: "https://example.com/flight1" }),
      createTestOffer(2, { bookingLink: "javascript:alert(1)" }),
    ];
    const kb = buildInlineKeyboard(offers);
    assert.ok(kb);
    assert.equal(kb.inline_keyboard.length, 1);
    assert.equal(kb.inline_keyboard[0][0].url, "https://example.com/flight1");
  });

  it("masks Telegram bot token in URLs and error strings", () => {
    const urlWithToken =
      "Request failed: POST https://api.telegram.org/bot123456789:AAHfiqksKZ8WmR2z_abc123-XYZ/sendMessage";
    const masked = maskSecrets(urlWithToken);
    assert.ok(!masked.includes("123456789:AAHfiqksKZ8WmR2z_abc123-XYZ"));
    assert.ok(masked.includes("bot[REDACTED]/sendMessage"));
  });
});

