export const DEFAULT_ORIGIN_IATA = "KUL";
export const DEFAULT_DESTINATION_IATA = "DAM";
export const DEFAULT_ROUTE_KEY = `${DEFAULT_ORIGIN_IATA}-${DEFAULT_DESTINATION_IATA}`;

/**
 * Arabic names for ~100 common airports/cities across Gulf, Levant, Turkey,
 * Asia, Africa, Europe, and North America.
 */
export const AIRPORT_ARABIC_NAMES: Readonly<Record<string, string>> = {
  // Gulf (الخليج العربي)
  DXB: "دبي",
  DWC: "دبي آل مكتوم",
  AUH: "أبوظبي",
  SHJ: "الشارقة",
  RKT: "رأس الخيمة",
  FJR: "الفجيرة",
  DOH: "الدوحة",
  BAH: "البحرين",
  KWI: "الكويت",
  MCT: "مسقط",
  SLL: "صلالة",
  RUH: "الرياض",
  JED: "جدة",
  DMM: "الدمام",
  MED: "المدينة المنورة",
  AHB: "أبها",
  TIF: "الطائف",
  ELQ: "القصيم",
  GIZ: "جازان",
  TUU: "تبوك",

  // Levant, Iraq & Yemen (الشام والعراق واليمن)
  DAM: "دمشق",
  ALP: "حلب",
  LTK: "اللاذقية",
  KAC: "القامشلي",
  BEY: "بيروت",
  AMM: "عمّان",
  AQJ: "العقبة",
  BGW: "بغداد",
  EBL: "أربيل",
  BSR: "البصرة",
  NJF: "النجف",
  ISU: "السليمانية",
  SAH: "صنعاء",
  ADE: "عدن",

  // Turkey (تركيا)
  IST: "إسطنبول",
  SAW: "إسطنبول صبيحة",
  ESB: "أنقرة",
  AYT: "أنطاليا",
  ADB: "إزمير",
  TZX: "طرابزون",
  GZT: "غازي عنتاب",
  ADA: "أضنة",
  BJV: "بودروم",
  DLM: "دالامان",

  // Africa (أفريقيا)
  CAI: "القاهرة",
  SPX: "سفنكس الجيزة",
  HBE: "الإسكندرية",
  HRG: "الغردقة",
  SSH: "شرم الشيخ",
  LXR: "الأقصر",
  ASW: "أسوان",
  KRT: "الخرطوم",
  PZU: "بورتسودان",
  TUN: "تونس",
  ALG: "الجزائر",
  ORN: "وهران",
  CMN: "الدار البيضاء",
  RAK: "مراكش",
  RBA: "الرباط",
  TNG: "طنجة",
  TIP: "طرابلس",
  BEN: "بنغازي",
  ADD: "أديس أبابا",
  NBO: "نيروبي",
  JNB: "جوهانسبرغ",
  CPT: "كيب تاون",
  DAR: "دار السلام",
  EBB: "عنتيبي",
  LOS: "لاغوس",
  ACC: "أكرا",
  DKR: "داكار",

  // Southeast & East & South Asia (آسيا)
  KUL: "كوالالمبور",
  SZB: "سوبانغ كوالالمبور",
  PEN: "بينانغ",
  LGK: "لنكاوي",
  BKI: "كوتا كينابالو",
  KCH: "كوتشينغ",
  JHB: "جوهور باهرو",
  SIN: "سنغافورة",
  BKK: "بانكوك",
  DMK: "بانكوك دون موينغ",
  HKT: "بوكيت",
  CNX: "تشيانغ ماي",
  CGK: "جاكرتا",
  DPS: "بالي",
  SUB: "سورابايا",
  MNL: "مانيلا",
  CEB: "سيبو",
  SGN: "هو تشي منه",
  HAN: "هانوي",
  PNH: "بنوم بنه",
  RGN: "يانغون",
  HKG: "هونغ كونغ",
  MFM: "ماكاو",
  TPE: "تايبيه",
  PEK: "بكين",
  PKX: "بكين داشينغ",
  PVG: "شنغهاي",
  CAN: "غوانزو",
  SZX: "شينزن",
  ICN: "سيول",
  GMP: "سيول غيمبو",
  NRT: "طوكيو ناريتا",
  HND: "طوكيو هانيدا",
  KIX: "أوساكا",
  DEL: "نيودلهي",
  BOM: "مومباي",
  BLR: "بنغالور",
  MAA: "تشيناي",
  HYD: "حيدر آباد",
  COK: "كوتشي",
  CMB: "كولومبو",
  MLE: "المالديف",
  DAC: "دكا",
  KHI: "كراتشي",
  LHE: "لاهور",
  ISB: "إسلام آباد",
  TAS: "طشقند",
  ALA: "ألماتي",
  GYD: "باكو",
  TBS: "تبليسي",
  EVN: "يريفان",

  // Europe & North America & Oceania (أوروبا وأمريكا وأستراليا)
  LHR: "لندن هيثرو",
  LGW: "لندن غاتويك",
  STN: "لندن ستانستد",
  MAN: "مانشستر",
  CDG: "باريس",
  ORY: "باريس أورلي",
  FRA: "فرانكفورت",
  MUC: "ميونخ",
  BER: "برلين",
  DUS: "دوسلدورف",
  HAM: "هامبورغ",
  AMS: "أمستردام",
  BRU: "بروكسل",
  ZRH: "زيورخ",
  GVA: "جنيف",
  VIE: "فيينا",
  FCO: "روما",
  MXP: "ميلانو",
  MAD: "مدريد",
  BCN: "برشلونة",
  LIS: "لشبونة",
  ATH: "أثينا",
  LCA: "لارنكا",
  OTP: "بوخارست",
  SOF: "صوفيا",
  BEG: "بلغراد",
  WAW: "وارسو",
  PRG: "براغ",
  BUD: "بودابست",
  ARN: "ستوكهولم",
  CPH: "كوبنهاغن",
  OSL: "أوسلو",
  HEL: "هلسنكي",
  DUB: "دبلن",
  SVO: "موسكو",
  DME: "موسكو دوموديدوفو",
  JFK: "نيويورك",
  EWR: "نيويورك نيوارك",
  IAD: "واشنطن",
  ORD: "شيكاغو",
  LAX: "لوس أنجلوس",
  SFO: "سان فرانسيسكو",
  YYZ: "تورونتو",
  YUL: "مونتريال",
  SYD: "سيدني",
  MEL: "ملبورن",
};

export interface RouteInfo {
  origin: string;
  destination: string;
  routeKey: string;
  originNameAr: string;
  destinationNameAr: string;
}

export function isValidIataCode(code: string | undefined | null): boolean {
  if (!code || typeof code !== "string") {
    return false;
  }
  return /^[A-Z]{3}$/.test(code.trim().toUpperCase());
}

/**
 * Returns the Arabic name for an airport/city IATA code, falling back to the uppercase IATA code when unknown.
 */
export function getAirportNameAr(iata: string): string {
  const code = (iata ?? "").trim().toUpperCase();
  if (!code) {
    return "";
  }
  return AIRPORT_ARABIC_NAMES[code] ?? code;
}

/**
 * Formats an IATA code as "الاسم العربي (CODE)" when known, or "CODE" when unknown.
 */
export function formatAirportWithCode(iata: string): string {
  const code = (iata ?? "").trim().toUpperCase();
  if (!code) {
    return "";
  }
  const arName = AIRPORT_ARABIC_NAMES[code];
  if (arName) {
    return `${arName} (${code})`;
  }
  return code;
}

export function buildRouteInfo(origin: string, destination: string): RouteInfo {
  const orig = origin.trim().toUpperCase();
  const dest = destination.trim().toUpperCase();
  return {
    origin: orig,
    destination: dest,
    routeKey: `${orig}-${dest}`,
    originNameAr: getAirportNameAr(orig),
    destinationNameAr: getAirportNameAr(dest),
  };
}

/**
 * Parses a route string like "ORIGIN-DEST" or "ORIGIN DEST" into a RouteInfo object.
 * Returns null if the format is invalid or if origin === destination.
 */
export function parseRouteKey(raw: string | undefined | null): RouteInfo | null {
  if (!raw || typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.trim().toUpperCase();
  const match = trimmed.match(/^([A-Z]{3})(?:\s*[-–—>\s]\s*|\s+)([A-Z]{3})$/);
  if (!match) {
    return null;
  }
  const [, origin, destination] = match;
  if (origin === destination) {
    return null;
  }
  return buildRouteInfo(origin, destination);
}

export interface RouteValidationResult {
  ok: boolean;
  route?: RouteInfo;
  reason?: "missing" | "invalid_format" | "same_airport";
}

/**
 * Validates arguments to `/route <ORIGIN> <DEST>` (also accepts `ORIGIN-DEST`).
 */
export function validateRouteArgs(rawArgs: string): RouteValidationResult {
  const trimmed = (rawArgs ?? "").trim();
  if (!trimmed) {
    return { ok: false, reason: "missing" };
  }

  const tokens = trimmed
    .split(/[\s\-–—>,]+/)
    .map((t) => t.trim())
    .filter(Boolean);

  if (tokens.length !== 2) {
    return { ok: false, reason: "invalid_format" };
  }

  const [rawOrigin, rawDest] = tokens;
  if (!isValidIataCode(rawOrigin) || !isValidIataCode(rawDest)) {
    return { ok: false, reason: "invalid_format" };
  }

  const origin = rawOrigin.toUpperCase();
  const destination = rawDest.toUpperCase();

  if (origin === destination) {
    return { ok: false, reason: "same_airport" };
  }

  return {
    ok: true,
    route: buildRouteInfo(origin, destination),
  };
}

/**
 * Resolves the list of watched routes from WATCH_ROUTES env string and the primary route.
 * If WATCH_ROUTES is unset/empty, returns [primaryRoute].
 * If WATCH_ROUTES is set, parses comma-separated route pairs and ensures primaryRoute is included first.
 */
export function parseWatchRoutes(
  watchRoutesRaw: string | undefined | null,
  primaryRoute: RouteInfo
): RouteInfo[] {
  const byKey = new Map<string, RouteInfo>();
  byKey.set(primaryRoute.routeKey, primaryRoute);

  if (!watchRoutesRaw || !watchRoutesRaw.trim()) {
    return [primaryRoute];
  }

  const entries = watchRoutesRaw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  for (const entry of entries) {
    const parsed = parseRouteKey(entry);
    if (parsed && !byKey.has(parsed.routeKey)) {
      byKey.set(parsed.routeKey, parsed);
    }
  }

  return Array.from(byKey.values());
}

/**
 * Splits totalDatesPerRun across routeCount routes so the sum of per-route date queries
 * never exceeds totalDatesPerRun.
 */
export function splitDatesPerRunAcrossRoutes(
  totalDatesPerRun: number,
  routeCount: number
): number[] {
  if (routeCount <= 0 || totalDatesPerRun <= 0) {
    return [];
  }
  if (routeCount === 1) {
    return [totalDatesPerRun];
  }

  const base = Math.floor(totalDatesPerRun / routeCount);
  const remainder = totalDatesPerRun % routeCount;

  return Array.from({ length: routeCount }, (_, idx) =>
    base + (idx < remainder ? 1 : 0)
  );
}

