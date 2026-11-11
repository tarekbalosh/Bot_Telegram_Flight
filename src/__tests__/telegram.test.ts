import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildInlineKeyboard,
  buildTelegramPayloads,
  groupOffersByItinerary,
} from "../services/telegram";
import { UnifiedFlightOffer } from "../types/flight";
import { maskSecrets } from "../utils/logger";

function createTestOffer(
  index: number,
  overrides: Partial<UnifiedFlightOffer> = {}
): UnifiedFlightOffer {
  return {
    externalId: `ext-${index}`,
    provider: "SERPAPI",
    origin: "SIN",
    destination: "DXB",
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
  it("groups offers by distinct itinerary (same airlines + flight numbers + times), listing all dates in one line with lowest price", () => {
    const sameItineraryDay1 = createTestOffer(1, {
      departureDate: "2026-12-12",
      departureTime: "2026-12-12 02:45",
      arrivalTime: "2026-12-12 14:15",
      airlines: ["Qatar Airways"],
      flightNumbers: ["QR 853", "QR 410"],
      priceMYR: 2250,
      priceUSD: 495,
    });
    const sameItineraryDay2Cheaper = createTestOffer(2, {
      departureDate: "2026-12-05",
      departureTime: "2026-12-05 02:45",
      arrivalTime: "2026-12-05 14:15",
      airlines: ["Qatar Airways"],
      flightNumbers: ["QR 853", "QR 410"],
      priceMYR: 1980,
      priceUSD: 435.6,
    });
    const secondItinerary = createTestOffer(3, {
      departureDate: "2026-12-15",
      departureTime: "2026-12-15 19:15",
      arrivalTime: "2026-12-16 08:15",
      airlines: ["Turkish Airlines"],
      flightNumbers: ["TK 61", "TK 846"],
      priceMYR: 2100,
      priceUSD: 462,
    });

    const groups = groupOffersByItinerary(
      [sameItineraryDay1, secondItinerary, sameItineraryDay2Cheaper],
      5
    );
    assert.equal(groups.length, 2);
    assert.equal(groups[0].representative.priceMYR, 1980);
    assert.deepEqual(groups[0].dates, ["2026-12-05", "2026-12-12"]);
    assert.equal(groups[1].representative.priceMYR, 2100);

    const payloads = buildTelegramPayloads(
      [sameItineraryDay1, secondItinerary, sameItineraryDay2Cheaper],
      { targetPriceMyr: 2500, topN: 5 }
    );
    assert.equal(payloads.length, 1);
    const text = payloads[0].text;
    assert.ok(text.includes("2026-12-05"));
    assert.ok(text.includes("2026-12-12"));
    assert.ok(text.includes("1,980"));
    assert.ok(text.includes("الرحلة #1"));
    assert.ok(text.includes("الرحلة #2"));
    assert.ok(!text.includes("الرحلة #3"));
  });

  it("renders up to topN (default 5) distinct itineraries in a single message when under 4096 chars and attaches inline keyboard", () => {
    const offers = [
      createTestOffer(1),
      createTestOffer(2),
      createTestOffer(3),
      createTestOffer(4),
      createTestOffer(5),
      createTestOffer(6),
    ];

    const payloads = buildTelegramPayloads(offers, {
      targetPriceMyr: 2500,
      topN: 5,
    });
    assert.equal(payloads.length, 1);
    assert.ok(payloads[0].text.length <= 4096);
    assert.ok(payloads[0].text.includes("الرحلة #1"));
    assert.ok(payloads[0].text.includes("الرحلة #5"));
    assert.ok(!payloads[0].text.includes("الرحلة #6"));
    assert.ok(payloads[0].text.includes("تم تحقيق السعر المستهدف ✅"));

    const keyboard = payloads[0].reply_markup?.inline_keyboard;
    assert.ok(keyboard);
    assert.equal(keyboard.length, 5);
    assert.ok(keyboard[0][0].text.includes("احجز"));
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

    const payloads = buildTelegramPayloads(offers, {
      targetPriceMyr: 2500,
      maxLen: 550,
    });

    assert.ok(payloads.length >= 2);
    for (let i = 0; i < payloads.length - 1; i++) {
      assert.equal(payloads[i].reply_markup, undefined);
      assert.ok(payloads[i].text.length <= 550);
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
