import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  detectSelfTransfer,
  parseBaggage,
  parseSerpApiResponse,
  SerpApiFlightsResponse,
} from "../providers/serpapi";

const realisticFixture: SerpApiFlightsResponse = {
  search_metadata: {
    id: "673f1234abcd",
    status: "Success",
    google_flights_url:
      "https://www.google.com/travel/flights?hl=en&gl=my&curr=MYR",
  },
  best_flights: [
    {
      flights: [
        {
          departure_airport: {
            name: "Kuala Lumpur International Airport",
            id: "KUL",
            time: "2026-12-10 02:45",
          },
          arrival_airport: {
            name: "Hamad International Airport",
            id: "DOH",
            time: "2026-12-10 05:35",
          },
          duration: 470,
          airline: "Qatar Airways",
          flight_number: "QR 853",
          extensions: ["Average legroom (31 in)", "Wi-Fi for a fee"],
        },
        {
          departure_airport: {
            name: "Hamad International Airport",
            id: "DOH",
            time: "2026-12-10 09:05",
          },
          arrival_airport: {
            name: "Damascus International Airport",
            id: "DAM",
            time: "2026-12-10 12:15",
          },
          duration: 190,
          airline: "Qatar Airways",
          flight_number: "QR 410",
          extensions: ["Average legroom (31 in)"],
        },
      ],
      layovers: [
        {
          duration: 210, // 3.5 hours
          name: "Hamad International Airport",
          id: "DOH",
        },
      ],
      total_duration: 870, // 14.5 hours
      price: 2180,
      type: "One way",
      extensions: ["1 checked bag included", "Carbon emissions estimate: 510 kg"],
    },
  ],
  other_flights: [
    {
      flights: [
        {
          departure_airport: {
            name: "Kuala Lumpur International Airport",
            id: "KUL",
            time: "2026-12-10 08:00",
          },
          arrival_airport: {
            name: "Sharjah International Airport",
            id: "SHJ",
            time: "2026-12-10 11:30",
          },
          duration: 450,
          airline: "AirAsia X",
          flight_number: "D7 192",
          extensions: ["Self transfer at SHJ"],
        },
        {
          departure_airport: {
            name: "Sharjah International Airport",
            id: "SHJ",
            time: "2026-12-10 15:00",
          },
          arrival_airport: {
            name: "Damascus International Airport",
            id: "DAM",
            time: "2026-12-10 17:30",
          },
          duration: 210,
          airline: "Cham Wings",
          flight_number: "6Q 512",
        },
      ],
      layovers: [
        {
          duration: 210,
          name: "Sharjah International Airport",
          id: "SHJ",
        },
      ],
      total_duration: 870,
      price: 1620,
      type: "One way",
      extensions: ["Separate tickets booked together", "Checked baggage for a fee"],
    },
    {
      flights: [
        {
          departure_airport: { id: "KUL", time: "2026-12-10 19:15" },
          arrival_airport: { id: "IST", time: "2026-12-11 01:30" },
          duration: 675,
          airline: "Turkish Airlines",
          flight_number: "TK 61",
          extensions: ["30 kg checked baggage included"],
        },
        {
          departure_airport: { id: "IST", time: "2026-12-11 06:00" },
          arrival_airport: { id: "DAM", time: "2026-12-11 08:15" },
          duration: 135,
          airline: "Turkish Airlines",
          flight_number: "TK 846",
        },
      ],
      layovers: [
        {
          duration: 270, // 4.5 hours
          name: "Istanbul Airport",
          id: "IST",
        },
      ],
      total_duration: 1080, // 18 hours
      price: 2490,
      type: "One way",
    },
  ],
};

describe("SerpApi Google Flights Parser", () => {
  it("parses best_flights and other_flights with prices, USD conversion, and layover minutes->hours", () => {
    const offers = parseSerpApiResponse(realisticFixture, {
      outboundDate: "2026-12-10",
      originIata: "KUL",
      destinationIata: "DAM",
      usdRate: 0.22,
    });

    assert.equal(offers.length, 3);

    // First offer: Qatar Airways
    const qr = offers[0];
    assert.equal(qr.priceMYR, 2180);
    assert.equal(qr.priceUSD, 479.6);
    assert.deepEqual(qr.transitAirports, ["DOH"]);
    assert.deepEqual(qr.layoverDurationsHours, [3.5]);
    assert.equal(qr.totalDurationHours, 14.5);
    assert.equal(qr.checkedBaggageKg, 23);
    assert.equal(qr.baggageVerified, true);
    assert.equal(qr.isSinglePNR, true);
    assert.equal(qr.bagsRecheckRequired, false);
    assert.equal(
      qr.bookingLink,
      "https://www.google.com/travel/flights?hl=en&gl=my&curr=MYR"
    );

    // Second offer: Self-transfer option
    const selfTransfer = offers[1];
    assert.equal(selfTransfer.priceMYR, 1620);
    assert.equal(selfTransfer.isSinglePNR, false);
    assert.equal(selfTransfer.bagsRecheckRequired, true);
    assert.equal(selfTransfer.checkedBaggageKg, 0);
    assert.equal(selfTransfer.baggageVerified, true);

    // Third offer: Explicit 30 kg checked baggage
    const tk = offers[2];
    assert.equal(tk.priceMYR, 2490);
    assert.deepEqual(tk.layoverDurationsHours, [4.5]);
    assert.equal(tk.totalDurationHours, 18);
    assert.equal(tk.checkedBaggageKg, 30);
    assert.equal(tk.baggageVerified, true);
  });

  it("parses diverse baggage extension strings accurately", () => {
    assert.deepEqual(
      parseBaggage({ extensions: ["2 checked bags included"] }),
      { kg: 46, verified: true }
    );
    assert.deepEqual(
      parseBaggage({ extensions: ["1 free checked bag"] }),
      { kg: 23, verified: true }
    );
    assert.deepEqual(
      parseBaggage({ extensions: ["Checked baggage 25 kg included"] }),
      { kg: 25, verified: true }
    );
    assert.deepEqual(
      parseBaggage({ extensions: ["30 kg checked bag"] }),
      { kg: 30, verified: true }
    );
    assert.deepEqual(
      parseBaggage({ extensions: ["No checked bag included"] }),
      { kg: 0, verified: true }
    );
    assert.deepEqual(
      parseBaggage({ extensions: ["Checked baggage for a fee"] }),
      { kg: 0, verified: true }
    );
    assert.deepEqual(
      parseBaggage({ extensions: ["Wi-Fi for a fee", "In-seat power"] }),
      { kg: null, verified: false }
    );
  });

  it("detects self-transfer and separate tickets case-insensitively", () => {
    assert.equal(
      detectSelfTransfer({ extensions: ["Self-transfer in Dubai"] }),
      true
    );
    assert.equal(
      detectSelfTransfer({ extensions: ["Booked as separate tickets"] }),
      true
    );
    assert.equal(
      detectSelfTransfer({ extensions: ["1 checked bag included"] }),
      false
    );
  });

  it("returns empty array when SerpApi reports no results found", () => {
    const empty = parseSerpApiResponse(
      { error: "Google Flights hasn't returned any results for this query." },
      {
        outboundDate: "2026-12-10",
        originIata: "KUL",
        destinationIata: "DAM",
        usdRate: 0.22,
      }
    );
    assert.deepEqual(empty, []);
  });
});

