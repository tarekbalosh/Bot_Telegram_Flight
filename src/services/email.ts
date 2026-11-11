import fs from "fs";
import path from "path";
import { Resend } from "resend";
import { env } from "../config/env";
import { buildDefaultGoogleFlightsUrl } from "../providers/serpapi";
import { UnifiedFlightOffer } from "../types/flight";
import { logger, maskSecrets } from "../utils/logger";
import {
  ARABIC_STRINGS,
  escapeHtml,
  formatAirlinesSummary,
  formatBaggageLine,
  formatFlightDate,
  formatNoMatchingFlightsBody,
  formatNoMatchingFlightsTitle,
  formatPrice,
  formatReportTitle,
  formatRouteHeader,
  formatTransitSummary,
  isValidHttpUrl,
  wrapLtr,
} from "./format";
import { getEffectiveRoute, getEffectiveTarget } from "./settings";
import { NotificationResult } from "./telegram";

export interface RenderedEmailContent {
  subject: string;
  html: string;
  text: string;
}

export function buildEmailSubject(
  offers: UnifiedFlightOffer[],
  route?: { origin?: string; destination?: string }
): string {
  const originIata = (
    route?.origin ||
    offers[0]?.origin ||
    env.ORIGIN_IATA
  ).toUpperCase();
  const destinationIata = (
    route?.destination ||
    offers[0]?.destination ||
    env.DESTINATION_IATA
  ).toUpperCase();

  if (offers.length === 0) {
    return `✈️ ${formatNoMatchingFlightsTitle(originIata, destinationIata)}`;
  }
  const lowestPrice = formatPrice(offers[0].priceMYR);
  return `✈️ أرخص رحلة ${originIata} ➔ ${destinationIata}: ${lowestPrice} ${ARABIC_STRINGS.myrUnit}`;
}

export function renderEmailContent(
  offers: UnifiedFlightOffer[],
  targetPriceMyr: number = env.TARGET_PRICE_MYR,
  route?: { origin?: string; destination?: string }
): RenderedEmailContent {
  const top10 = offers.slice(0, 10);
  const originIata = (
    route?.origin ||
    top10[0]?.origin ||
    env.ORIGIN_IATA
  ).toUpperCase();
  const destinationIata = (
    route?.destination ||
    top10[0]?.destination ||
    env.DESTINATION_IATA
  ).toUpperCase();

  const subject = buildEmailSubject(top10, {
    origin: originIata,
    destination: destinationIata,
  });
  const reportTitle = formatReportTitle(originIata, destinationIata);
  const routeHeader = formatRouteHeader(originIata, destinationIata);
  const noFlightsTitle = formatNoMatchingFlightsTitle(
    originIata,
    destinationIata
  );
  const noFlightsBody = formatNoMatchingFlightsBody(destinationIata);

  if (top10.length === 0) {
    const text = [noFlightsTitle, "", noFlightsBody].join("\n");

    const html = `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:16px;background-color:#f4f6f9;font-family:'Segoe UI',Tahoma,'Noto Sans Arabic',Arial,sans-serif;direction:rtl;text-align:right;color:#1f2937;">
  <div style="max-width:640px;margin:0 auto;background:#ffffff;border-radius:12px;padding:24px;border:1px solid #e5e7eb;">
    <h1 style="font-size:20px;margin:0 0 12px 0;color:#b91c1c;">${escapeHtml(
      noFlightsTitle
    )}</h1>
    <p style="font-size:15px;line-height:1.6;margin:0;color:#374151;">${escapeHtml(
      noFlightsBody
    )}</p>
  </div>
</body>
</html>`;

    return { subject, html, text };
  }

  const lowest = top10[0];
  const targetBeaten = lowest.priceMYR <= targetPriceMyr;

  const bannerBg = targetBeaten ? "#ecfdf5" : "#eff6ff";
  const bannerBorder = targetBeaten ? "#10b981" : "#3b82f6";
  const bannerColor = targetBeaten ? "#065f46" : "#1e40af";
  const bannerBadgeText = targetBeaten
    ? ARABIC_STRINGS.targetBeatenBadge
    : `${ARABIC_STRINGS.targetNotBeatenBadge} (${formatPrice(targetPriceMyr)} ${
        ARABIC_STRINGS.myrUnit
      })`;

  const plainLines: string[] = [
    reportTitle,
    routeHeader,
    `${ARABIC_STRINGS.lowestPriceLabel}: ${formatPrice(lowest.priceMYR)} ${
      ARABIC_STRINGS.myrUnit
    } ($${formatPrice(lowest.priceUSD)} USD)`,
    bannerBadgeText,
    "------------------------------------------------------------",
  ];

  const rowsHtml = top10
    .map((offer, idx) => {
      const rank = idx + 1;
      const dateStr = formatFlightDate(offer.departureDate);
      const timingStr = `${offer.departureTime} ➔ ${offer.arrivalTime} (${
        Math.round(offer.totalDurationHours * 10) / 10
      } ${ARABIC_STRINGS.hoursUnit})`;
      const priceMyrStr = `${formatPrice(offer.priceMYR)} ${ARABIC_STRINGS.myrUnit}`;
      const priceUsdStr = `$${formatPrice(offer.priceUSD)} USD`;
      const airlinesStr = formatAirlinesSummary(
        offer.airlines,
        offer.flightNumbers
      );
      const transitStr = formatTransitSummary(
        offer.transitAirports,
        offer.layoverDurationsHours
      );
      const baggageStr = formatBaggageLine(offer, destinationIata);

      const isVerifiedBaggage =
        offer.baggageVerified &&
        typeof offer.checkedBaggageKg === "number" &&
        offer.checkedBaggageKg > 0;

      const badgeBg = isVerifiedBaggage ? "#d1fae5" : "#fef3c7";
      const badgeColor = isVerifiedBaggage ? "#065f46" : "#92400e";
      const badgeBorder = isVerifiedBaggage ? "#34d399" : "#f59e0b";

      const fallbackLink = buildDefaultGoogleFlightsUrl(
        originIata,
        destinationIata,
        offer.departureDate
      );
      const safeLink = isValidHttpUrl(offer.bookingLink)
        ? offer.bookingLink
        : fallbackLink;

      plainLines.push(
        `#${rank} | ${offer.departureDate} | ${priceMyrStr} (${priceUsdStr})`,
        `   ${ARABIC_STRINGS.airlinesLabel}: ${airlinesStr}`,
        `   ${ARABIC_STRINGS.transitLabel}: ${transitStr}`,
        `   ${ARABIC_STRINGS.baggageLabel}: ${baggageStr}`,
        `   ${ARABIC_STRINGS.bookingLinkLabel}: ${safeLink}`,
        ""
      );

      return `<tr style="border-bottom:1px solid #e5e7eb;">
        <td style="padding:12px 8px;vertical-align:top;font-size:13px;">
          <div style="font-weight:700;color:#111827;">#${rank} — ${escapeHtml(dateStr)}</div>
          <div style="color:#6b7280;font-size:12px;margin-top:4px;direction:ltr;text-align:right;">${escapeHtml(
            timingStr
          )}</div>
        </td>
        <td style="padding:12px 8px;vertical-align:top;font-size:13px;white-space:nowrap;">
          <div style="font-weight:700;color:#047857;font-size:15px;">${escapeHtml(
            wrapLtr(priceMyrStr)
          )}</div>
          <div style="color:#6b7280;font-size:12px;">${escapeHtml(
            wrapLtr(priceUsdStr)
          )}</div>
        </td>
        <td style="padding:12px 8px;vertical-align:top;font-size:13px;">
          <div style="font-weight:600;color:#1f2937;">${escapeHtml(airlinesStr)}</div>
          <div style="color:#4b5563;font-size:12px;margin-top:4px;">${escapeHtml(
            transitStr
          )}</div>
        </td>
        <td style="padding:12px 8px;vertical-align:top;font-size:12px;">
          <span style="display:inline-block;padding:4px 8px;border-radius:6px;background-color:${badgeBg};color:${badgeColor};border:1px solid ${badgeBorder};font-weight:600;line-height:1.4;">
            ${escapeHtml(baggageStr)}
          </span>
        </td>
        <td style="padding:12px 8px;vertical-align:middle;text-align:center;white-space:nowrap;">
          <a href="${escapeHtml(
            safeLink
          )}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:8px 12px;background-color:#2563eb;color:#ffffff;text-decoration:none;border-radius:6px;font-size:12px;font-weight:700;">
            ${escapeHtml(ARABIC_STRINGS.bookNowButton)}
          </a>
        </td>
      </tr>`;
    })
    .join("\n");

  plainLines.push(ARABIC_STRINGS.emailFooterNote);

  const html = `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:16px;background-color:#f3f4f6;font-family:'Segoe UI',Tahoma,'Noto Sans Arabic',Arial,sans-serif;direction:rtl;text-align:right;color:#1f2937;">
  <div style="max-width:640px;margin:0 auto;background-color:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e5e7eb;box-shadow:0 1px 3px rgba(0,0,0,0.06);">
    <div style="background-color:#0f172a;color:#ffffff;padding:20px 24px;">
      <h1 style="margin:0;font-size:18px;font-weight:700;">${escapeHtml(
        reportTitle
      )}</h1>
      <p style="margin:6px 0 0 0;font-size:13px;color:#cbd5e1;">${escapeHtml(
        routeHeader
      )}</p>
    </div>

    <div style="margin:16px 20px;padding:16px;border-radius:8px;background-color:${bannerBg};border:1px solid ${bannerBorder};color:${bannerColor};">
      <div style="font-size:14px;font-weight:700;margin-bottom:6px;">
        💰 ${escapeHtml(ARABIC_STRINGS.lowestPriceLabel)}:
        <span dir="ltr">${escapeHtml(formatPrice(lowest.priceMYR))} ${escapeHtml(
    ARABIC_STRINGS.myrUnit
  )}</span>
        (<span dir="ltr">$${escapeHtml(formatPrice(lowest.priceUSD))} USD</span>)
      </div>
      <div style="font-size:13px;font-weight:600;">
        ${escapeHtml(bannerBadgeText)}
      </div>
    </div>

    <div style="padding:0 16px 16px 16px;overflow-x:auto;">
      <table style="width:100%;border-collapse:collapse;text-align:right;" cellpadding="0" cellspacing="0">
        <thead>
          <tr style="background-color:#f9fafb;border-bottom:2px solid #e5e7eb;font-size:12px;color:#4b5563;">
            <th style="padding:10px 8px;">${escapeHtml(ARABIC_STRINGS.dateLabel)}</th>
            <th style="padding:10px 8px;">${escapeHtml(ARABIC_STRINGS.priceLabel)}</th>
            <th style="padding:10px 8px;">${escapeHtml(
              ARABIC_STRINGS.airlinesLabel
            )} / ${escapeHtml(ARABIC_STRINGS.transitLabel)}</th>
            <th style="padding:10px 8px;">${escapeHtml(ARABIC_STRINGS.baggageLabel)}</th>
            <th style="padding:10px 8px;text-align:center;">${escapeHtml(
              ARABIC_STRINGS.bookingLinkLabel
            )}</th>
          </tr>
        </thead>
        <tbody>
          ${rowsHtml}
        </tbody>
      </table>
    </div>

    <div style="background-color:#f9fafb;padding:14px 20px;border-top:1px solid #e5e7eb;font-size:12px;color:#6b7280;">
      ${escapeHtml(ARABIC_STRINGS.emailFooterNote)}
    </div>
  </div>
</body>
</html>`;

  return {
    subject,
    html,
    text: plainLines.join("\n"),
  };
}

export async function sendEmailReport(
  offers: UnifiedFlightOffer[],
  options?: {
    dryRun?: boolean;
    targetPriceMyr?: number;
    originIata?: string;
    destinationIata?: string;
  }
): Promise<NotificationResult> {
  try {
    const [resolvedTargetPriceMyr, effectiveRoute] = await Promise.all([
      options?.targetPriceMyr !== undefined
        ? Promise.resolve(options.targetPriceMyr)
        : options?.dryRun
        ? Promise.resolve(env.TARGET_PRICE_MYR)
        : getEffectiveTarget(),
      options?.originIata && options?.destinationIata
        ? Promise.resolve({
            origin: options.originIata,
            destination: options.destinationIata,
          })
        : getEffectiveRoute(options?.dryRun ? { store: null } : undefined),
    ]);

    const rendered = renderEmailContent(offers, resolvedTargetPriceMyr, {
      origin: options?.originIata || effectiveRoute.origin,
      destination: options?.destinationIata || effectiveRoute.destination,
    });

    if (options?.dryRun) {
      const baseDir = process.env.VERCEL ? "/tmp" : process.cwd();
      const previewDir = path.resolve(baseDir, "dist-preview");
      let previewPath = path.join(previewDir, "email.html");
      try {
        fs.mkdirSync(previewDir, { recursive: true });
        fs.writeFileSync(previewPath, rendered.html, "utf8");
      } catch {
        previewPath = "(skipped on read-only filesystem)";
      }

      console.log(
        "\n================ [DRY-RUN] EMAIL REPORT (ARABIC) ================"
      );
      console.log(`Subject: ${rendered.subject}`);
      console.log(rendered.text);
      console.log(`HTML Preview written to: ${previewPath}`);
      console.log(
        "=================================================================\n"
      );
      return { ok: true };
    }

    if (!env.RESEND_API_KEY || !env.EMAIL_FROM || !env.EMAIL_TO) {
      const msg =
        "Email is not configured (RESEND_API_KEY, EMAIL_FROM, or EMAIL_TO missing)";
      logger.warn(msg);
      return { ok: false, error: msg };
    }

    const resend = new Resend(env.RESEND_API_KEY);
    const response = await resend.emails.send({
      from: env.EMAIL_FROM,
      to: env.EMAIL_TO,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
    });

    if (response.error) {
      const errMsg = `Resend API error: ${response.error.message}`;
      logger.error("Email notification failed", { error: errMsg });
      return { ok: false, error: errMsg };
    }

    logger.info("Email report sent successfully", {
      emailId: response.data?.id,
      flightsIncluded: Math.min(10, offers.length),
    });
    return { ok: true };
  } catch (err) {
    const errorMsg =
      err instanceof Error ? maskSecrets(err.message) : String(err);
    logger.error("Unexpected error in sendEmailReport", { error: errorMsg });
    return { ok: false, error: errorMsg };
  }
}
