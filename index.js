'use strict';

/**
 * homebridge-inpost-air (v1.1.0)
 *
 * Exposes InPost Paczkomat parcel-locker air quality sensors as HomeKit
 * accessories. Units vary: some publish PM values only, others also
 * temperature / humidity / NO2 / O3. Payload field sets can change over
 * time, so each layer (PM, gases, temperature, humidity) can be toggled
 * off in the plugin config; disabled layers are also removed from a
 * previously cached accessory on restart.
 *
 * InPost's air data sits behind Cloudflare: a POST without the session
 * cookies set by the locker page is rejected with 403. Two transports:
 *   1. fetch: GET locker page -> sensor id + cookies; POST the endpoint.
 *      (can lose cookies set on redirects)
 *   2. curl:  same flow via the system curl binary with a cookie jar -
 *      different TLS stack and reliable cookie handling; used when fetch
 *      is blocked (greencity.pl is a marketing SPA and NOT a data source).
 * If both fail, degrade to the official public ShipX API coarse level.
 */

const { execFile } = require('child_process');
const os = require('os');
const path = require('path');

const PLUGIN_NAME = 'homebridge-inpost-air';
const PLATFORM_NAME = 'InPostAir';

const POINTS_URL = 'https://inpost.pl/sites/default/files/points.json';
const SHIPX_POINT_URL = 'https://api-shipx-pl.easypack24.net/v1/points/';
const INPOST = 'https://inpost.pl';
const SHIPX_URL_REGEX = /data-shipx-url="(?:\/en)?\/shipx-point-data\/([^/]+)\/[^/]+\/air_index_level"/;

const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const DEFAULT_UA = 'homebridge-inpost-air (+https://github.com/silvetti/homebridge-inpost-air)';

const PAGE_ACCEPT =
  'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8';
const PAGE_LANG = 'pl-PL,pl;q=0.9,en-US;q=0.8,en;q=0.7';

// Coarse index levels returned by the official ShipX points API.
const SHIPX_LEVELS = {
  VERY_GOOD: 1, GOOD: 2, MODERATE: 3, SUFFICIENT: 4, BAD: 5, VERY_BAD: 5,
};

// inpost.pl 404s for "no sensor data" lockers; InPost sometimes enables a
// unit's backend later, so re-probe daily instead of giving up forever.
const NO_SENSOR_RETRY_MS = 24 * 60 * 60 * 1000;
// points.json changes rarely (new lockers); refresh the cache daily.
const POINTS_TTL_MS = 24 * 60 * 60 * 1000;

function pageHeaders(ua) {
  return { 'User-Agent': ua, 'Accept': PAGE_ACCEPT, 'Accept-Language': PAGE_LANG };
}

// Collects cookies from a response into a Cookie header value. NOTE: fetch()
// drops Set-Cookie headers seen on redirect responses, which is why the
// curl transport (cookie jar on disk) is the reliable path.
function extractCookies(res) {
  const list = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : [];
  return list.map((c) => c.split(';')[0]).join('; ') || null;
}

function curl(args) {
  return new Promise((resolve, reject) => {
    execFile('curl', ['-sS', ...args], { timeout: 40000, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const msg = err.code === 'ENOENT'
            ? 'curl binary not found'
            : (String(stderr || err.message)).trim().slice(0, 200);
          reject(new Error(msg));
          return;
        }
        resolve(stdout);
      });
  });
}

// Map Polish-specific characters before NFD stripping so slugify matches
// python-slugify/unidecode output used for locker page URLs (e.g. Lodz).
const PL_ASCII = {
  'ą': 'a', 'ć': 'c', 'ę': 'e', 'ł': 'l', 'ń': 'n',
  'ó': 'o', 'ś': 's', 'ź': 'z', 'ż': 'z',
};

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[ąćęłńóśźż]/g, (ch) => PL_ASCII[ch])
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '');
}

function lockerPageUrls(point) {
  // point fields as returned by inpost.pl points.json:
  // n = code, g = lowercase city, e = street, r = province
  const pl = slugify(`paczkomat-${point.g}-${point.n}-${point.e}-paczkomaty-${point.r}`);
  const en = slugify(`parcel-locker-${point.g}-${point.n}-${point.e}-paczkomaty-${point.r}`);
  return [`${INPOST}/${pl}`, `${INPOST}/en/${en}`];
}

function toFloat(s) {
  const v = parseFloat(s);
  return Number.isFinite(v) ? v : null;
}

// Parses lines like "PM25:12.4:49.6", "TEMPERATURE:-3.2:", "HUMIDITY:81:".
function parseSensorLines(lines) {
  const data = {};
  let m;
  for (const line of lines || []) {
    if ((m = line.match(/^PM25:([\d.]+):([\d.]+)/))) {
      data.pm25 = toFloat(m[1]);
      data.pm25Norm = toFloat(m[2]);
    } else if ((m = line.match(/^PM10:([\d.]+):([\d.]+)/))) {
      data.pm10 = toFloat(m[1]);
      data.pm10Norm = toFloat(m[2]);
    } else if ((m = line.match(/^PM1:([\d.]+):/))) {
      data.pm1 = toFloat(m[1]);
    } else if ((m = line.match(/^PM4:([\d.]+):/))) {
      data.pm4 = toFloat(m[1]);
    } else if ((m = line.match(/^TEMPERATURE:(-?[\d.]+):/))) {
      data.temperature = toFloat(m[1]);
    } else if ((m = line.match(/^PRESSURE:([\d.]+):/))) {
      data.pressure = toFloat(m[1]);
    } else if ((m = line.match(/^HUMIDITY:([\d.]+):/))) {
      data.humidity = toFloat(m[1]);
    } else if ((m = line.match(/^NO2:([\d.]+):/))) {
      data.no2 = toFloat(m[1]);
    } else if ((m = line.match(/^O3:([\d.]+):/))) {
      data.o3 = toFloat(m[1]);
    }
  }
  return data;
}

// HomeKit AirQuality from PM concentrations using Polish GIOS index bands,
// taking the worse of PM2.5 and PM10.
function pm25Level(v) {
  if (v <= 13) return 1;
  if (v <= 35) return 2;
  if (v <= 55) return 3;
  if (v <= 75) return 4;
  return 5;
}
function pm10Level(v) {
  if (v <= 20) return 1;
  if (v <= 50) return 2;
  if (v <= 80) return 3;
  if (v <= 110) return 4;
  return 5;
}

function levelFromInPostString(s) {
  if (!s || typeof s !== 'string') return null;
  const t = s.toLowerCase();
  if (/bardzo\s*z|very\s*bad/.test(t)) return 5;
  if (/z[ył]/.test(t) || /\bbad\b|\bpoor\b/.test(t)) return 5;
  if (/dostateczn|sufficient|inferior/.test(t)) return 4;
  if (/umiarkowan|moderate|fair/.test(t)) return 3;
  if (/bardzo\s*dobr|very\s*good|excellent/.test(t)) return 1;
  if (/dobr|\bgood\b/.test(t)) return 2;
  return null;
}

function levelFromShipxCode(s) {
  if (!s || typeof s !== 'string') return null;
  const code = s.trim().toUpperCase();
  if (code in SHIPX_LEVELS) return SHIPX_LEVELS[code];
  return levelFromInPostString(s);
}

function airQualityFromData(data, indexLevel) {
  const levels = [];
  if (data.pm25 != null) levels.push(pm25Level(data.pm25));
  if (data.pm10 != null) levels.push(pm10Level(data.pm10));
  if (levels.length) return Math.max(...levels);
  return levelFromInPostString(indexLevel);
}

const AQ_NAMES = ['Unknown', 'Excellent', 'Good', 'Fair', 'Inferior', 'Poor'];

class InPostAirPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;
    this.cachedAccessories = new Map();
    this.pointsCache = null;
    this.pointsCacheAt = 0;
    this.lockerInstances = [];

    const uaOpt = String(this.config.userAgent || '').trim();
    this.userAgent = uaOpt === 'browser' ? BROWSER_UA : (uaOpt || DEFAULT_UA);

    // Optional friendly names per locker code: { "ABC01A": "Street corner" }.
    this.labels = (this.config.labels && typeof this.config.labels === 'object')
      ? this.config.labels
      : {};

    // Exposure toggles: which layers (when the unit reports them) surface
    // in HomeKit. Logs always show the full payload regardless.
    const cfg = this.config;
    this.exposure = {
      pm: cfg.showPM !== false,
      gases: cfg.showGases !== false,
      temperature: cfg.showTemperature !== false,
      humidity: cfg.showHumidity !== false,
    };

    if (!Array.isArray(this.config.lockers) || this.config.lockers.length === 0) {
      this.log.warn(
        'No paczkomat locker codes configured. Add a "lockers" array of locker codes '
        + '(e.g. ["ABC01A"]) to the platform config.',
      );
    }

    this.api.on('didFinishLaunching', () => this.setup().catch(
      (err) => this.log.error('Setup failed:', err.message),
    ));
  }

  configureAccessory(accessory) {
    this.cachedAccessories.set(accessory.UUID, accessory);
  }

  async setup() {
    const codes = [...new Set(
      (this.config.lockers || []).map((c) => String(c).trim().toUpperCase()).filter(Boolean),
    )];
    const keep = new Set();

    for (const code of codes) {
      const label = this.labels[code] || `Paczkomat ${code}`;
      const uuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}:${code}`);
      keep.add(uuid);
      let accessory = this.cachedAccessories.get(uuid);
      if (!accessory) {
        this.log.info(`Adding new accessory: ${label} (${code})`);
        accessory = new this.api.platformAccessory(
          label, uuid, this.api.hap.Categories.AIR_SENSOR,
        );
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }
      this.lockerInstances.push(new InPostLockerAccessory(this, accessory, code, label));
    }

    const stale = [...this.cachedAccessories.keys()].filter((u) => !keep.has(u));
    for (const uuid of stale) {
      this.api.unregisterPlatformAccessories(
        PLUGIN_NAME, PLATFORM_NAME, [this.cachedAccessories.get(uuid)],
      );
      this.cachedAccessories.delete(uuid);
    }
  }

  async getPoints() {
    if (!this.pointsCache || (Date.now() - this.pointsCacheAt) > POINTS_TTL_MS) {
      const res = await fetch(POINTS_URL, {
        headers: pageHeaders(this.userAgent),
        signal: AbortSignal.timeout(60000),
      });
      if (!res.ok) {
        throw new Error(`points.json request failed with HTTP ${res.status}`);
      }
      const json = await res.json();
      this.pointsCache = json.items || [];
      this.pointsCacheAt = Date.now();
    }
    return this.pointsCache;
  }
}

class InPostLockerAccessory {
  constructor(platform, accessory, lockerCode, label) {
    this.platform = platform;
    this.accessory = accessory;
    this.code = lockerCode;
    this.log = platform.log;
    this.Service = platform.Service;
    this.Characteristic = platform.Characteristic;

    this.point = null;
    this.pageUrl = null;
    this.lockerId = null;
    this.cookies = null;
    this.jarPath = path.join(os.tmpdir(), `inpost-air-${lockerCode}.cookies`);

    this.refreshing = false;
    this.blocked = false;
    this.noSensorsUntil = 0;

    const info = accessory.getService(this.Service.AccessoryInformation);
    info
      .setCharacteristic(this.Characteristic.Manufacturer, 'InPost')
      .setCharacteristic(this.Characteristic.Model, 'Paczkomat air sensor')
      .setCharacteristic(this.Characteristic.SerialNumber, lockerCode);

    const C = this.Characteristic;
    const exposure = this.platform.exposure;

    // Service display names stay generic; the accessory name (locker label)
    // is what HomeKit prefixes onto tiles.
    this.airService = accessory.getService(this.Service.AirQualitySensor)
      || accessory.addService(this.Service.AirQualitySensor, 'Air Quality', 'air-quality');

    // Prune characteristics that a previous (wider) config added but that
    // are now disabled: HomeKit keeps cached characteristics around
    // otherwise.
    const prune = (chars, enabled) => {
      if (enabled) return;
      for (const ch of chars) {
        try {
          if (this.airService.testCharacteristic(ch)) {
            this.airService.removeCharacteristic(ch);
          }
        } catch {
          // ignore: characteristic may not be removable in older homebridge
        }
      }
    };
    prune([C.PM2_5Density, C.PM10Density], exposure.pm);
    prune([C.NitrogenDioxideDensity, C.OzoneDensity], exposure.gases);

    // Linked services are created only when enabled; if a previous config
    // created one that is now disabled, unlink and remove it so HomeKit
    // drops the tile too.
    const ensureService = (ctor, displayName, subtype, enabled) => {
      const existing = accessory.getService(ctor);
      if (!enabled) {
        if (existing) {
          const idx = this.airService.linkedServices.indexOf(existing);
          if (idx >= 0) {
            this.airService.linkedServices.splice(idx, 1);
          }
          accessory.removeService(existing);
        }
        return null;
      }
      return existing || accessory.addService(ctor, displayName, subtype);
    };

    this.tempService = ensureService(
      this.Service.TemperatureSensor, 'Temperature', 'temperature', exposure.temperature,
    );
    this.humService = ensureService(
      this.Service.HumiditySensor, 'Humidity', 'humidity', exposure.humidity,
    );

    for (const svc of [this.tempService, this.humService]) {
      if (svc && !this.airService.linkedServices.includes(svc)) {
        this.airService.addLinkedService(svc);
      }
    }

    if (this.tempService) {
      // Parcel lockers are outdoors: allow sub-zero winter readings.
      this.tempService
        .getCharacteristic(C.CurrentTemperature)
        .setProps({ minValue: -50, maxValue: 70 });
    }

    const minutes = Math.max(5, Number(this.platform.config.refreshIntervalMinutes) || 10);
    this.refresh();
    this.timer = setInterval(() => this.refresh(), minutes * 60 * 1000);
    if (this.timer.unref) {
      this.timer.unref();
    }
  }

  async findPoint() {
    const points = await this.platform.getPoints();
    const point = points.find((p) => p && p.n === this.code);
    if (!point) {
      throw new Error(`Locker ${this.code} was not found in the InPost points list`);
    }
    this.pageUrl = lockerPageUrls(point)[0];
    return point;
  }

  pickPageResponse(html) {
    const match = html.match(SHIPX_URL_REGEX);
    return match ? match[1] : null;
  }

  // Transport 1: Node fetch (cookies may be lost on redirect responses).
  async fetchViaFetch(problems) {
    const ua = this.platform.userAgent;
    if (!this.lockerId) {
      for (const url of lockerPageUrls(this.point)) {
        const res = await fetch(url, {
          headers: pageHeaders(ua),
          signal: AbortSignal.timeout(30000),
        });
        if (!res.ok) continue;
        this.cookies = extractCookies(res);
        const id = this.pickPageResponse(await res.text());
        if (id) {
          this.lockerId = id;
          this.pageUrl = url;
          this.log.info(`[${this.code}] Resolved sensor id ${id} via fetch`);
          break;
        }
      }
      if (!this.lockerId) {
        problems.push('fetch: locker page yielded no sensor id');
        return null;
      }
    }

    const headers = {
      ...pageHeaders(ua),
      'Accept': 'application/json, text/javascript, */*; q=0.01',
      'X-Requested-With': 'XMLHttpRequest',
      'Origin': INPOST,
      'Referer': this.pageUrl,
    };
    if (this.cookies) {
      headers.Cookie = this.cookies;
    }
    const res = await fetch(
      `${INPOST}/shipx-point-data/${this.lockerId}/${this.code}/air_index_level`,
      { method: 'POST', headers, signal: AbortSignal.timeout(30000) },
    );
    if (!res.ok) {
      problems.push(`fetch: HTTP ${res.status}`);
      if (res.status === 404) this.noSensorsUntil = Date.now() + NO_SENSOR_RETRY_MS;
      this.lockerId = null; // re-resolve next time
      return null;
    }
    const body = await res.json();
    return body;
  }

  // Transport 2: system curl with an on-disk cookie jar (proven to pass
  // Cloudflare where undici fetch gets a 403).
  async fetchViaCurl(problems) {
    if (!this.pageUrl) {
      this.pageUrl = lockerPageUrls(this.point)[0];
    }
    const html = await curl([
      '-L', '-c', this.jarPath, '-A', BROWSER_UA, this.pageUrl,
    ]);
    const id = this.pickPageResponse(html);
    if (id) {
      this.lockerId = id;
    } else if (!this.lockerId) {
      problems.push('curl: locker page yielded no sensor id');
      return null;
    }

    const out = await curl([
      '-b', this.jarPath, '-c', this.jarPath,
      '-A', BROWSER_UA,
      '-H', 'X-Requested-With: XMLHttpRequest',
      '-H', 'Accept: application/json, text/javascript, */*; q=0.01',
      '-H', `Referer: ${this.pageUrl}`,
      '-X', 'POST',
      '-w', '\n%{http_code}',
      `${INPOST}/shipx-point-data/${this.lockerId}/${this.code}/air_index_level`,
    ]);
    const nl = out.lastIndexOf('\n');
    const status = Number(out.slice(nl + 1).trim());
    const text = out.slice(0, nl);
    if (status !== 200) {
      problems.push(`curl: HTTP ${status}`);
      if (status === 404) this.noSensorsUntil = Date.now() + NO_SENSOR_RETRY_MS;
      return null;
    }
    try {
      return JSON.parse(text);
    } catch {
      problems.push(`curl: non-JSON body: ${text.slice(0, 120).replace(/\s+/g, ' ')}`);
      return null;
    }
  }

  // Degraded mode: official public ShipX API, coarse level only.
  async fetchShipxLevel() {
    try {
      const res = await fetch(`${SHIPX_POINT_URL}${encodeURIComponent(this.code)}`, {
        headers: {
          ...pageHeaders(this.platform.userAgent),
          'Accept': 'application/json',
        },
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) {
        this.log.warn(`[${this.code}] ShipX API answered HTTP ${res.status}`);
        return null;
      }
      const body = await res.json();
      if (!body || !body.air_index_level) {
        this.log.debug?.(
          `[${this.code}] ShipX API answered without air_index_level `
          + `(fields: ${body ? Object.keys(body).slice(0, 15).join(', ') : 'empty body'})`,
        );
        return null;
      }
      return body.air_index_level;
    } catch (e) {
      this.log.warn(`[${this.code}] ShipX API request failed: ${e.message}`);
      return null;
    }
  }

  async refresh() {
    // Guard against overlapping polls: Cloudflare-finicky rounds plus the
    // ShipX fallback can outlive the next interval tick, and doubled
    // requests are exactly what anti-bot systems notice first.
    if (this.refreshing) {
      this.log.debug?.(`[${this.code}] Previous poll still running; skipping this tick.`);
      return;
    }
    this.refreshing = true;
    try {
      await this.doRefresh();
    } finally {
      this.refreshing = false;
    }
  }

  async doRefresh() {
    try {
      if (!this.point) {
        this.point = await this.findPoint();
      }
      if (this.noSensorsUntil && Date.now() < this.noSensorsUntil) {
        return; // backend reported no published sensor data; retry later
      }
      this.noSensorsUntil = 0;

      const problems = [];
      let body = await this.fetchViaFetch(problems).catch((e) => {
        problems.push(`fetch: ${e.message}`);
        return null;
      });
      if (!body) {
        body = await this.fetchViaCurl(problems).catch((e) => {
          problems.push(`curl: ${e.message}`);
          return null;
        });
      }

      if (this.noSensorsUntil) {
        // Either transport got a 404 just now; lockout until tomorrow.
        this.log.warn(
          `[${this.code}] This paczkomat reports no air sensors (or data is not published); `
          + 'retrying in 24 h.',
        );
        this.markInactive();
        return;
      }

      if (body) {
        if (this.blocked) {
          this.blocked = false;
          this.log.info(`[${this.code}] Detailed sensor data recovered.`);
        }
        this.applyData(parseSensorLines(body.air_sensors), body.air_index_level, body.air_sensors);
        return;
      }

      const shipxLevel = await this.fetchShipxLevel();
      const aq = levelFromShipxCode(shipxLevel);
      if (aq != null) {
        this.airService.updateCharacteristic(this.Characteristic.StatusActive, true);
        this.airService.updateCharacteristic(this.Characteristic.AirQuality, aq);
        // Warn once when blocking starts; keep subsequent rounds quiet
        // (debug) until it recovers.
        if (!this.blocked) {
          this.blocked = true;
          this.log.warn(
            `[${this.code}] Detailed sensor data blocked (${problems.join('; ')}); `
            + `using official ShipX API level ${shipxLevel} (${AQ_NAMES[aq]}) instead.`,
          );
        } else {
          this.log.debug?.(
            `[${this.code}] Still blocked; ShipX level ${shipxLevel} (${AQ_NAMES[aq]}).`,
          );
        }
      } else {
        this.log.warn(
          `[${this.code}] Blocked everywhere and no ShipX level (${problems.join('; ')}).`,
        );
        this.markInactive();
      }
    } catch (err) {
      this.log.error(`[${this.code}] ${err.message}`);
    }
  }

  applyData(data, indexLevel, rawLines) {
    const C = this.Characteristic;
    const exposure = this.platform.exposure;
    const aq = airQualityFromData(data, indexLevel);

    this.airService.updateCharacteristic(C.StatusActive, true);
    if (aq != null) {
      this.airService.updateCharacteristic(C.AirQuality, aq);
    }
    if (exposure.pm) {
      if (data.pm25 != null) this.airService.updateCharacteristic(C.PM2_5Density, data.pm25);
      if (data.pm10 != null) this.airService.updateCharacteristic(C.PM10Density, data.pm10);
    }
    if (exposure.gases) {
      if (data.no2 != null) this.airService.updateCharacteristic(C.NitrogenDioxideDensity, data.no2);
      if (data.o3 != null) this.airService.updateCharacteristic(C.OzoneDensity, data.o3);
    }
    if (this.tempService && data.temperature != null) {
      this.tempService.updateCharacteristic(
        C.CurrentTemperature, Math.min(70, Math.max(-50, data.temperature)),
      );
    }
    if (this.humService && data.humidity != null) {
      this.humService.updateCharacteristic(
        C.CurrentRelativeHumidity, Math.min(100, Math.max(0, data.humidity)),
      );
    }

    // The log line always reports the complete payload, independent of
    // exposure settings - that is how unit capabilities are discovered.
    const parts = [
      data.temperature != null ? `${data.temperature} degC` : null,
      data.humidity != null ? `${data.humidity} pct RH` : null,
      data.pressure != null ? `${data.pressure} hPa` : null,
      `PM1=${data.pm1 ?? 'n/a'}`,
      `PM2.5=${data.pm25 ?? 'n/a'}`,
      `PM4=${data.pm4 ?? 'n/a'}`,
      `PM10=${data.pm10 ?? 'n/a'}`,
      data.no2 != null ? `NO2=${data.no2}` : null,
      data.o3 != null ? `O3=${data.o3}` : null,
    ].filter(Boolean).join(', ');
    const rawFields = Array.isArray(rawLines)
      ? rawLines.map((l) => String(l).split(':')[0]).filter(Boolean)
      : [];
    this.log.info(
      `[${this.code}] ${parts} | AQ=${aq != null ? AQ_NAMES[aq] : 'Unknown'} `
      + `| payload fields: ${rawFields.join('/') || 'none'}`,
    );
    this.log.debug?.(`[${this.code}] raw payload: ${JSON.stringify(rawLines)}`);
  }

  markInactive() {
    this.airService.updateCharacteristic(this.Characteristic.StatusActive, false);
  }
}

module.exports = (api) => {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, InPostAirPlatform);
};
