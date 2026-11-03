/**
 * The MSISDN for a phone number entered in a country (`country` is an ISO 3166-1 alpha-2 code).
 * Numbers given in international form ("+48 ...", "0048 ...") keep their own country code.
 * Returns null for numbers that cannot be valid.
 */
export declare function toMsisdn(country: string, phoneNumber: string): string | null;
