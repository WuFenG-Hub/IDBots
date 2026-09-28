/**
 * Host geolocation resolution for the get_host_location inline tool.
 *
 * Two providers, both keyless (field-tested 2026-09-28, see
 * docs/design/2026-09-28-bot-location-evaluation.md):
 * - BigDataCloud reverse-geocode-client: HTTPS, district-level on good CN
 *   data, doubles as the reverse geocoder for the OS (WGS-84) precise fix.
 * - ip-api.com: HTTP-only on the free tier, city-level; fallback only.
 *
 * Fetch is injectable so tests never touch the network; the main process's
 * global fetch already honors the system proxy (applySystemProxyWithLoopbackBypass).
 */

export type SystemFix = {
  latitude: number;
  longitude: number;
  /** OS-reported horizontal accuracy in meters, when provided. */
  accuracyMeters?: number | null;
};

type HostLocationBase = {
  granularity: 'coarse' | 'precise';
  source: 'ip' | 'system';
  provider: string;
  country: string;
  region: string;
  city: string;
  district?: string;
  latitude: number;
  longitude: number;
  timezone?: string;
  /** Human/model-readable trust note; always relay it when using the result. */
  accuracyNote: string;
  /** ISO timestamp of the successful provider call. */
  fetchedAt: string;
};

export type CoarseLocation = HostLocationBase & {
  granularity: 'coarse';
  source: 'ip';
};

export type PreciseLocation = HostLocationBase & {
  granularity: 'precise';
  source: 'system';
  accuracyMeters?: number;
};

const COARSE_ACCURACY_NOTE =
  'City-level estimate based on the host\'s public IP address (the IP\'s registered point, not the device\'s actual position). Do not use or present it as a delivery/shipping address.';

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_COARSE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_REVERSE_GEOCODE_CACHE_TTL_MS = 5 * 60 * 1000;

export type HostLocationServiceOptions = {
  fetchImpl?: typeof fetch;
  /** Millisecond clock (Date.now by default); tests inject a controllable one. */
  now?: () => number;
  timeoutMs?: number;
  coarseCacheTtlMs?: number;
  reverseGeocodeCacheTtlMs?: number;
  /** App language ('zh' / 'en'); drives provider response localization. */
  getLanguage?: () => string;
};

type BigDataCloudAdminEntry = { name?: string; order?: number; adminLevel?: number };
type BigDataCloudResponse = {
  latitude?: number;
  longitude?: number;
  countryName?: string;
  principalSubdivision?: string;
  city?: string;
  locality?: string;
  localityInfo?: {
    administrative?: BigDataCloudAdminEntry[];
    informative?: Array<{ name?: string; order?: number }>;
  };
};

type IpApiResponse = {
  status?: string;
  message?: string;
  country?: string;
  regionName?: string;
  city?: string;
  district?: string;
  lat?: number;
  lon?: number;
  timezone?: string;
  query?: string;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** IANA timezone names look like "Asia/Shanghai"; other informative entries do not. */
const TIMEZONE_NAME_RE = /^[A-Za-z_]+\/[A-Za-z_]+(?:\/[A-Za-z_]+)?$/;

export class HostLocationService {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly coarseCacheTtlMs: number;
  private readonly reverseGeocodeCacheTtlMs: number;
  private readonly getLanguage?: () => string;

  private coarseCache: { value: CoarseLocation; expiresAt: number } | null = null;
  private reverseGeocodeCache = new Map<string, { value: PreciseLocation; expiresAt: number }>();

  constructor(options: HostLocationServiceOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => Date.now());
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.coarseCacheTtlMs = options.coarseCacheTtlMs ?? DEFAULT_COARSE_CACHE_TTL_MS;
    this.reverseGeocodeCacheTtlMs = options.reverseGeocodeCacheTtlMs ?? DEFAULT_REVERSE_GEOCODE_CACHE_TTL_MS;
    this.getLanguage = options.getLanguage;
  }

  /**
   * IP-based coarse lookup: BigDataCloud first, ip-api.com on any failure.
   * The successful result is cached in memory for coarseCacheTtlMs (6h default).
   */
  async getCoarseLocation(): Promise<CoarseLocation> {
    if (this.coarseCache && this.coarseCache.expiresAt > this.now()) {
      return this.coarseCache.value;
    }
    let primaryError: unknown;
    try {
      const value = await this.fetchBigDataCloudCoarse();
      this.coarseCache = { value, expiresAt: this.now() + this.coarseCacheTtlMs };
      return value;
    } catch (error) {
      primaryError = error;
    }
    try {
      const value = await this.fetchIpApiCoarse();
      this.coarseCache = { value, expiresAt: this.now() + this.coarseCacheTtlMs };
      return value;
    } catch (fallbackError) {
      throw new Error(
        `IP-based location lookup failed — BigDataCloud: ${errorMessage(primaryError)}; ip-api.com: ${errorMessage(fallbackError)}`,
      );
    }
  }

  /**
   * Reverse-geocode an OS (WGS-84) fix through BigDataCloud — WGS-84-safe, so
   * no GCJ-02 conversion is needed. Short cache keyed by rounded coords.
   */
  async reverseGeocode(fix: SystemFix): Promise<PreciseLocation> {
    const latitude = Number(fix.latitude);
    const longitude = Number(fix.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      throw new Error(`Invalid system fix coordinates: ${fix.latitude}, ${fix.longitude}`);
    }
    const cacheKey = `${latitude.toFixed(4)},${longitude.toFixed(4)}`;
    const cached = this.reverseGeocodeCache.get(cacheKey);
    if (cached && cached.expiresAt > this.now()) {
      return cached.value;
    }
    const lang = this.language();
    const url = `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${latitude}&longitude=${longitude}&localityLanguage=${lang}`;
    const data = await this.fetchJson<BigDataCloudResponse>(url, 'BigDataCloud');
    const mapped = this.mapBigDataCloud(data);
    const accuracyMeters = typeof fix.accuracyMeters === 'number' && Number.isFinite(fix.accuracyMeters)
      ? Math.round(fix.accuracyMeters)
      : undefined;
    const value: PreciseLocation = {
      granularity: 'precise',
      source: 'system',
      provider: 'bigdatacloud',
      ...mapped,
      ...(accuracyMeters != null ? { accuracyMeters } : {}),
      accuracyNote: accuracyMeters != null
        ? `OS-reported device location (±${accuracyMeters} m), reverse-geocoded by BigDataCloud. This is NOT a confirmed delivery address — confirm the full address with the user before ordering anything.`
        : 'OS-reported device location, reverse-geocoded by BigDataCloud. This is NOT a confirmed delivery address — confirm the full address with the user before ordering anything.',
      fetchedAt: new Date(this.now()).toISOString(),
    };
    this.reverseGeocodeCache.set(cacheKey, { value, expiresAt: this.now() + this.reverseGeocodeCacheTtlMs });
    return value;
  }

  private language(): 'zh' | 'en' {
    const raw = (this.getLanguage?.() ?? 'en').toLowerCase();
    return raw.startsWith('zh') ? 'zh' : 'en';
  }

  private async fetchJson<T>(url: string, provider: string): Promise<T> {
    const response = await this.fetchImpl(url, {
      signal: AbortSignal.timeout(this.timeoutMs),
      headers: { accept: 'application/json' },
    });
    if (!response.ok) {
      throw new Error(`${provider} returned HTTP ${response.status}`);
    }
    return (await response.json()) as T;
  }

  private async fetchBigDataCloudCoarse(): Promise<CoarseLocation> {
    // Without latitude/longitude params the endpoint does an IP-based lookup.
    const url = `https://api.bigdatacloud.net/data/reverse-geocode-client?localityLanguage=${this.language()}`;
    const data = await this.fetchJson<BigDataCloudResponse>(url, 'BigDataCloud');
    const mapped = this.mapBigDataCloud(data);
    return {
      granularity: 'coarse',
      source: 'ip',
      provider: 'bigdatacloud',
      ...mapped,
      accuracyNote: COARSE_ACCURACY_NOTE,
      fetchedAt: new Date(this.now()).toISOString(),
    };
  }

  private async fetchIpApiCoarse(): Promise<CoarseLocation> {
    // The free tier is HTTP-only.
    const lang = this.language() === 'zh' ? 'zh-CN' : 'en';
    const url = `http://ip-api.com/json/?lang=${lang}&fields=status,message,country,regionName,city,district,lat,lon,timezone,query`;
    const data = await this.fetchJson<IpApiResponse>(url, 'ip-api.com');
    if (data.status !== 'success') {
      throw new Error(`ip-api.com reported status "${data.status ?? '(missing)'}"${data.message ? `: ${data.message}` : ''}`);
    }
    if (typeof data.lat !== 'number' || typeof data.lon !== 'number'
      || !Number.isFinite(data.lat) || !Number.isFinite(data.lon)) {
      throw new Error('ip-api.com returned no usable coordinates');
    }
    return {
      granularity: 'coarse',
      source: 'ip',
      provider: 'ip-api.com',
      country: data.country ?? '',
      region: data.regionName ?? '',
      city: data.city ?? '',
      ...(data.district ? { district: data.district } : {}),
      latitude: data.lat,
      longitude: data.lon,
      ...(data.timezone ? { timezone: data.timezone } : {}),
      accuracyNote: COARSE_ACCURACY_NOTE,
      fetchedAt: new Date(this.now()).toISOString(),
    };
  }

  private mapBigDataCloud(data: BigDataCloudResponse): {
    country: string;
    region: string;
    city: string;
    district?: string;
    latitude: number;
    longitude: number;
    timezone?: string;
  } {
    const { latitude, longitude } = data;
    if (typeof latitude !== 'number' || typeof longitude !== 'number'
      || !Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      throw new Error('BigDataCloud returned no usable coordinates');
    }
    const country = data.countryName ?? '';
    const region = data.principalSubdivision ?? '';
    const city = data.city || data.locality || '';

    // The district/subdistrict is the deepest administrative entry whose name
    // differs from the city (e.g. order 8 "东区街道" while the city is order 7).
    // Province/country-level names are excluded so a shallow response does not
    // mislabel the region as the district.
    const administrative = (data.localityInfo?.administrative ?? [])
      .slice()
      .sort((a, b) => (b.order ?? 0) - (a.order ?? 0));
    const districtEntry = administrative.find((entry) => {
      const name = (entry.name ?? '').trim();
      return name !== '' && name !== city && name !== region && name !== country;
    });
    const district = districtEntry?.name?.trim() || undefined;

    const timezone = (data.localityInfo?.informative ?? [])
      .map((entry) => entry.name ?? '')
      .find((name) => TIMEZONE_NAME_RE.test(name)) || undefined;

    return {
      country,
      region,
      city,
      ...(district ? { district } : {}),
      latitude,
      longitude,
      ...(timezone ? { timezone } : {}),
    };
  }
}
