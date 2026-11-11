export type FlightProviderName = "AMADEUS" | "KIWI" | "SERPAPI";

export interface UnifiedFlightOffer {
  externalId: string;
  provider: FlightProviderName;
  origin?: string;
  destination?: string;
  priceMYR: number;
  priceUSD: number;
  departureDate: string; // YYYY-MM-DD
  departureTime: string; // ISO or YYYY-MM-DD HH:mm
  arrivalTime: string; // ISO or YYYY-MM-DD HH:mm
  airlines: string[];
  flightNumbers: string[];
  transitAirports: string[];
  layoverDurationsHours: number[];
  totalDurationHours: number;
  checkedBaggageKg: number | null;
  baggageVerified: boolean;
  isSinglePNR: boolean;
  bagsRecheckRequired: boolean;
  bookingLink: string;
}

export interface FlightSearchContext {
  originIata?: string;
  destinationIata?: string;
  dateFrom?: string;
  dateTo?: string;
  datesPerRun?: number;
}

export interface FlightProvider {
  readonly name: FlightProviderName | "MOCK";
  isConfigured(): boolean;
  search(context?: FlightSearchContext): Promise<UnifiedFlightOffer[]>;
}
