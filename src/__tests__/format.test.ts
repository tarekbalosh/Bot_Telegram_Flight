import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  escapeHtml,
  formatAirlinesSummary,
  formatBaggageLine,
  formatFlightDate,
  formatPrice,
  formatPriceFixed,
  formatTransitSummary,
  getAirportNameAr,
  isValidHttpUrl,
} from "../services/format";

describe("Arabic Formatter Helpers (format.ts)", () => {
  it("formats prices with thousands separators and decimal precision", () => {
    assert.equal(formatPriceFixed(1234.56), "1,234.56");
    assert.equal(formatPrice(1234.56), "1,234.56");
    assert.equal(formatPrice(2150), "2,150");
  });

  it("formats transit stations and layover durations in Arabic", () => {
    const single = formatTransitSummary(["IST"], [3.5]);
    assert.equal(single, "إسطنبول (IST) — انتظار 3.5 ساعة");

    const multi = formatTransitSummary(["DOH", "AMM"], [2.5, 1.5]);
    assert.equal(
      multi,
      "الدوحة (DOH) — انتظار 2.5 ساعة ، عمّان (AMM) — انتظار 1.5 ساعة"
    );

    const direct = formatTransitSummary([], []);
    assert.equal(direct, "رحلة مباشرة بدون توقف");
  });

  it("formats verified and unverified baggage lines dynamically using destinationNameAr", () => {
    const verifiedDxb = formatBaggageLine(
      {
        checkedBaggageKg: 23,
        baggageVerified: true,
        destination: "DXB",
      },
      "DXB"
    );
    assert.equal(
      verifiedDxb,
      `✅ تذكرة موحدة — استلام الحقائب في ${getAirportNameAr("DXB")} (23 كغ)`
    );

    const verifiedUnknownAirport = formatBaggageLine(
      {
        checkedBaggageKg: 30,
        baggageVerified: true,
        destination: "ZZZ",
      },
      "ZZZ"
    );
    assert.equal(
      verifiedUnknownAirport,
      "✅ تذكرة موحدة — استلام الحقائب في ZZZ (30 كغ)"
    );

    const unverified = formatBaggageLine({
      checkedBaggageKg: null,
      baggageVerified: false,
    });
    assert.equal(
      unverified,
      "⚠️ تذكرة موحدة — تحقق من وزن الحقيبة قبل الحجز"
    );
  });

  it("escapes HTML special characters safely", () => {
    const raw = `<script>alert("x & 'y'")</script>`;
    assert.equal(
      escapeHtml(raw),
      "&lt;script&gt;alert(&quot;x &amp; &#39;y&#39;&quot;)&lt;/script&gt;"
    );
  });

  it("formats flight dates and airlines summary", () => {
    const dateFormatted = formatFlightDate("2026-12-10");
    assert.ok(dateFormatted.includes("2026-12-10"));

    const airlines = formatAirlinesSummary(
      ["Qatar Airways", "Royal Jordanian"],
      ["QR 853", "RJ 412"]
    );
    assert.ok(airlines.includes("Qatar Airways + Royal Jordanian"));
    assert.ok(airlines.includes("QR 853 / RJ 412"));
  });

  it("validates http and https booking URLs", () => {
    assert.equal(isValidHttpUrl("https://www.google.com/travel/flights"), true);
    assert.equal(isValidHttpUrl("http://example.com/book"), true);
    assert.equal(isValidHttpUrl("javascript:alert(1)"), false);
    assert.equal(isValidHttpUrl("not-a-url"), false);
  });
});
