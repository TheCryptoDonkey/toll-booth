/**
 * Reference list of OFAC fully-sanctioned jurisdictions (ISO 3166-1 alpha-2).
 * Based on US Treasury OFAC Sanctions Programs as of March 2026.
 *
 * This is a US-only list. Operators subject to UK OFSI or EU sanctions must
 * extend it with additional jurisdictions (e.g. 'BY' for Belarus under EU
 * comprehensive sanctions).
 *
 * This constant is a point-in-time snapshot at the time of release. Sanctions
 * lists change — operators must verify against the live OFAC list and not rely
 * solely on this constant being current.
 *
 * ISO 3166-1 alpha-2 operates at the country level only. Sub-national sanctions
 * (e.g. Crimea, Donetsk, Luhansk) cannot be distinguished by country code.
 *
 * @see https://ofac.treasury.gov/sanctions-programs-and-country-information
 */
export const OFAC_SANCTIONED: readonly string[] = Object.freeze([
  'CU', // Cuba
  'IR', // Iran
  'KP', // North Korea
  'SY', // Syria
  'RU', // Russia (comprehensive sanctions)
])

/**
 * Check whether a request originates from a blocked country.
 *
 * Reads the country code from the specified header (set by the operator's
 * reverse proxy or CDN). Returns false (fail-open) if the header is absent —
 * the reverse proxy is responsible for setting the header.
 */
export function isBlockedCountry(
  headers: Record<string, string | undefined>,
  countryHeader: string,
  blockedCountries: readonly string[],
): boolean {
  if (blockedCountries.length === 0) return false

  // Case-insensitive header lookup (HTTP headers are case-insensitive)
  const headerLower = countryHeader.toLowerCase()
  const value = Object.entries(headers).find(
    ([k]) => k.toLowerCase() === headerLower,
  )?.[1]

  if (!value) return false

  const upper = value.toUpperCase()
  return blockedCountries.some(code => code.toUpperCase() === upper)
}
