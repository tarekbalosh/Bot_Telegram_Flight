import { env } from "../config/env";
import { UnifiedFlightOffer } from "../types/flight";
import {
  AIRPORT_ARABIC_NAMES,
  formatAirportWithCode,
  getAirportNameAr,
} from "../utils/airports";

export {
  AIRPORT_ARABIC_NAMES,
  formatAirportWithCode,
  getAirportNameAr,
} from "../utils/airports";

export function formatReportTitle(
  originIata: string = env.ORIGIN_IATA,
  destinationIata: string = env.DESTINATION_IATA
): string {
  const origAr = getAirportNameAr(originIata);
  const destAr = getAirportNameAr(destinationIata);
  return `✈️ تقرير أرخص رحلات الطيران (${origAr} ➔ ${destAr})`;
}

export function formatRouteHeader(
  originIata: string = env.ORIGIN_IATA,
  destinationIata: string = env.DESTINATION_IATA
): string {
  const origLabel = formatAirportWithCode(originIata);
  const destLabel = formatAirportWithCode(destinationIata);
  return `المسار: ${origLabel} ⬅️ ${destLabel} — اتجاه واحد`;
}

export function formatNoMatchingFlightsTitle(
  originIata: string = env.ORIGIN_IATA,
  destinationIata: string = env.DESTINATION_IATA
): string {
  const orig = originIata.trim().toUpperCase();
  const dest = destinationIata.trim().toUpperCase();
  return `⚠️ لا توجد رحلات مطابقة للشروط حالياً (${orig} ➔ ${dest})`;
}

export function formatNoMatchingFlightsBody(
  destinationIata: string = env.DESTINATION_IATA
): string {
  const destAr = getAirportNameAr(destinationIata);
  return `لم يتم العثور على أي رحلات بتذكرة موحدة (PNR واحد) مع شحن الحقائب إلى ${destAr} ومدة ترانزيت مناسبة ضمن التواريخ المحددة.`;
}

export function formatBaggageVerifiedText(
  kg: number,
  destinationNameAr: string = getAirportNameAr(env.DESTINATION_IATA)
): string {
  return `✅ تذكرة موحدة — استلام الحقائب في ${destinationNameAr} (${kg} كغ)`;
}

export function formatSingleTicketConfirmText(
  destinationNameAr: string = getAirportNameAr(env.DESTINATION_IATA)
): string {
  return `تأكيد: شحن الحقائب مباشرة إلى ${destinationNameAr} بدون استلام في الترانزيت`;
}

export const ARABIC_STRINGS = {
  get reportTitle(): string {
    return formatReportTitle();
  },
  get routeHeader(): string {
    return formatRouteHeader();
  },
  lowestPriceLabel: "أقل سعر متاح",
  targetBeatenBadge: "تم تحقيق السعر المستهدف ✅",
  targetNotBeatenBadge: "السعر الحالي أعلى من السعر المستهدف 🎯",
  flightHeaderPrefix: "الرحلة",
  dateLabel: "التاريخ",
  timingLabel: "التوقيت",
  priceLabel: "السعر",
  airlinesLabel: "الشركات المشغلة",
  flightNumbersLabel: "أرقام الرحلات",
  transitLabel: "محطات الترانزيت والانتظار",
  directFlight: "رحلة مباشرة بدون توقف",
  totalDurationLabel: "إجمالي مدة الرحلة",
  baggageLabel: "الحقائب والتذكرة",
  bookingLinkLabel: "رابط الحجز",
  bookButtonPrefix: "حجز الرحلة",
  bookNowButton: "احجز الآن ✈️",
  hoursUnit: "ساعة",
  kgUnit: "كغ",
  myrUnit: "ر.م",
  usdUnit: "دولار",
  get noMatchingFlightsTitle(): string {
    return formatNoMatchingFlightsTitle();
  },
  get noMatchingFlightsBody(): string {
    return formatNoMatchingFlightsBody();
  },
  baggageVerifiedTemplate: (
    kg: number,
    destinationIataOrNameAr?: string
  ): string => {
    const destNameAr = destinationIataOrNameAr
      ? getAirportNameAr(destinationIataOrNameAr)
      : getAirportNameAr(env.DESTINATION_IATA);
    return formatBaggageVerifiedText(kg, destNameAr);
  },
  baggageUnverifiedWarning:
    "⚠️ تذكرة موحدة — تحقق من وزن الحقيبة قبل الحجز",
  get baggageSingleTicketConfirm(): string {
    return formatSingleTicketConfirmText();
  },
  telegramTestSuccess: "✅ تم ربط البوت بنجاح",
  emailFooterNote:
    "جميع الرحلات المعروضة أعلاه مفحوصة آلياً: تذكرة موحدة (Single PNR) بدون إعادة تسليم الحقائب في مطار الترانزيت.",
} as const;

/**
 * Escapes dynamic values for safe inclusion in Telegram HTML and Email HTML.
 */
export function escapeHtml(value: string | number | null | undefined): string {
  if (value === null || value === undefined) {
    return "";
  }
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Wraps an LTR fragment (flight number, IATA code, price, URL) in Unicode LTR isolate marks
 * so bidirectional Arabic text does not scramble characters.
 */
export function wrapLtr(text: string): string {
  return `\u2066${text}\u2069`;
}

/**
 * Formats a number with thousands separators and up to 2 decimal places (e.g. 1,234.56 or 2,150).
 */
export function formatPrice(amount: number, decimals: number = 2): string {
  if (!Number.isFinite(amount)) {
    return "0.00";
  }
  const hasFraction = Math.round(amount * 100) % 100 !== 0;
  const fractionDigits = hasFraction ? decimals : 0;
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: decimals,
  }).format(amount);
}

/**
 * Always formats with 2 decimals (e.g., 1,234.56).
 */
export function formatPriceFixed(amount: number): string {
  if (!Number.isFinite(amount)) {
    return "0.00";
  }
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

/**
 * Formats YYYY-MM-DD into a clear Arabic/ISO date display.
 */
export function formatFlightDate(dateStr: string): string {
  const trimmed = dateStr.trim();
  const match = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return trimmed;
  }
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const dateObj = new Date(Date.UTC(y, m - 1, d));
  if (Number.isNaN(dateObj.getTime())) {
    return trimmed;
  }
  try {
    const weekdayAr = new Intl.DateTimeFormat("ar-SY", {
      weekday: "long",
      timeZone: "UTC",
    }).format(dateObj);
    return `${weekdayAr} ${wrapLtr(trimmed)}`;
  } catch {
    return wrapLtr(trimmed);
  }
}

export function formatAirportLabel(iata: string): string {
  return formatAirportWithCode(iata);
}

/**
 * Formats transit stations and layover durations in Arabic:
 * e.g. "إسطنبول (IST) — انتظار 3.5 ساعة"
 */
export function formatTransitSummary(
  transitAirports: string[],
  layoverDurationsHours: number[]
): string {
  if (transitAirports.length === 0) {
    return ARABIC_STRINGS.directFlight;
  }

  const parts = transitAirports.map((code, index) => {
    const label = formatAirportLabel(code);
    const hours = layoverDurationsHours[index];
    if (typeof hours === "number" && Number.isFinite(hours) && hours > 0) {
      const cleanHours = Math.round(hours * 10) / 10;
      return `${label} — انتظار ${cleanHours} ${ARABIC_STRINGS.hoursUnit}`;
    }
    return label;
  });

  return parts.join(" ، ");
}

/**
 * Formats airlines and flight numbers cleanly.
 */
export function formatAirlinesSummary(
  airlines: string[],
  flightNumbers: string[]
): string {
  const airlineStr = airlines.length > 0 ? airlines.join(" + ") : "غير محدد";
  if (flightNumbers.length === 0) {
    return airlineStr;
  }
  const fnStr = wrapLtr(`(${flightNumbers.join(" / ")})`);
  return `${airlineStr} ${fnStr}`;
}

/**
 * Formats the Arabic baggage verification badge line using the destination's Arabic name:
 * - verified:   "✅ تذكرة موحدة — استلام الحقائب في {destinationNameAr} (23 كغ)"
 * - unverified: "⚠️ تذكرة موحدة — تحقق من وزن الحقيبة قبل الحجز"
 */
export function formatBaggageLine(
  offer: Pick<UnifiedFlightOffer, "checkedBaggageKg" | "baggageVerified"> & {
    destination?: string;
  },
  destinationIata?: string
): string {
  if (
    offer.baggageVerified &&
    typeof offer.checkedBaggageKg === "number" &&
    offer.checkedBaggageKg > 0
  ) {
    const destCode =
      destinationIata?.trim() ||
      offer.destination?.trim() ||
      env.DESTINATION_IATA;
    const destinationNameAr = getAirportNameAr(destCode);
    return formatBaggageVerifiedText(offer.checkedBaggageKg, destinationNameAr);
  }
  return ARABIC_STRINGS.baggageUnverifiedWarning;
}

export function isValidHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}
