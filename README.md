# homebridge-inpost-air

Homebridge plugin that exposes air quality data from **InPost Paczkomat® parcel-locker sensors** in Poland as HomeKit accessories.

InPost has been fitting Envic-Sense air quality units to Paczkomat parcel lockers across Poland since October 2021 as part of its Green City programme. Depending on the unit, a locker can report:

- PM1, PM2.5, PM10 (some units also PM4)
- Some units: NO2, O3
- Some units: temperature, humidity
- Some units: atmospheric pressure

Not every paczkomat has a sensor, some have a sensor that publishes no data (the endpoint answers 404 - the plugin retries such lockers once daily, since InPost also enables backends over time), and PM-only units are common - for those only the particulate characteristics populate in HomeKit. Payloads can also change over time: the same unit may publish PM-only one hour and full data (including temperature and humidity) the next. There is no way to know a unit's capabilities in advance; the plugin logs the exact payload fields on every poll.

## What appears in HomeKit

Per configured locker, one accessory (categorised as an air quality sensor) with:

- An **Air Quality Sensor**: AirQuality level (computed from the worse of PM2.5/PM10 using the Polish GIOS index bands) plus PM2.5, PM10 and - when reported - NO2 and O3 density
- A linked **Temperature Sensor** (only populated when the locker reports temperature)
- A linked **Humidity Sensor** (only populated when the locker reports humidity)

Each layer can be turned off in the plugin settings (see `showPM`, `showGases`, `showTemperature`, `showHumidity` below); disabling one also removes a tile that was added earlier. The Homebridge log always shows the full payload, regardless of exposure settings. Optional `labels` give each locker a friendly name, which HomeKit prefixes onto its tiles.

PM1, PM4 and pressure have no HomeKit equivalent and are logged only.

## Installation

```sh
npm install -g homebridge-inpost-air
```

or from the Homebridge UI by searching for `homebridge-inpost-air`.

To install straight from the repository:

```sh
npm install -g github:silvetti/homebridge-inpost-air
```

## Configuration

Via the Homebridge UI (Settings > InPost Air) or manually in `config.json`:

```json
{
  "platforms": [
    {
      "platform": "InPostAir",
      "name": "InPost Air",
      "lockers": ["ABC01A"],
      "labels": {
        "ABC01A": "Street corner"
      },
      "refreshIntervalMinutes": 10,
      "showPM": true,
      "showGases": true,
      "showTemperature": true,
      "showHumidity": true
    }
  ]
}
```

| Option | Description | Default |
|---|---|---|
| `lockers` | Paczkomat locker codes (visible in the InPost app or on inpost.pl) | - |
| `labels` | Optional friendly name per locker code, used for accessory and tile names | `Paczkomat <CODE>` |
| `refreshIntervalMinutes` | Poll interval, 5-60 minutes. The sensors publish roughly hourly, so 10-30 is plenty. Overlapping slow polls are skipped automatically | 10 |
| `userAgent` | Leave empty for the default honest UA (`homebridge-inpost-air (...)`), which works best against InPost's anti-bot protection. Set to `"browser"` to mimic a Chrome User-Agent instead | honest UA |
| `showPM` | Show PM2.5/PM10 density inside the Air Quality sensor | true |
| `showGases` | Show NO2/O3 density (only units that report gases) | true |
| `showTemperature` | Expose the linked Temperature tile | true |
| `showHumidity` | Expose the linked Humidity tile | true |

### Finding lockers that publish data

The official public ShipX API marks which lockers carry a live air sensor. To list working sensors in your city (replace `warszawa` with your city name):

```sh
node -e "let f=[];(async()=>{for(let p=1;;p++){const j=await(await fetch('https://api-shipx-pl.easypack24.net/v1/points?per_page=500&page='+p)).json();for(const x of j.items||[])if(x.air_index_level&&(x.address_details?.city||'').toLowerCase().includes('warszawa'))f.push(x.name+'  '+x.air_index_level+'  '+(x.address_details.street||''));if(p>=j.total_pages)break}console.log(f.sort().join('\n'))})()"
```

## How data is retrieved

There is no official API for the sensor values, so the plugin uses the same undocumented endpoint the InPost website calls, behind Cloudflare anti-bot protection. Three stages, in order:

1. **fetch transport**: reads the locker's public page on inpost.pl (URL derived from the public `points.json` list), extracts the internal sensor id from the page's `data-shipx-url` attribute, keeps the session cookies, and POSTs `inpost.pl/shipx-point-data/<id>/<code>/air_index_level`. Works out of the box on current Node.js versions; known caveat: Node's fetch drops `Set-Cookie` seen on redirect responses, which can strand the POST behind Cloudflare's 403.
2. **curl transport**: if fetch gets 403 or fails, the plugin repeats the flow with the system `curl` binary using an on-disk cookie jar (`$TMPDIR/inpost-air-<CODE>.cookies`). Uses the browser User-Agent deliberately. Passes Cloudflare where undici does not.
3. **ShipX degraded mode**: if both transports are blocked, the plugin queries the official `api-shipx-pl.easypack24.net/v1/points/<code>` endpoint for the coarse `air_index_level` string and publishes just the HomeKit AirQuality level (no PM numbers), so the accessory stays informative instead of going dark. The plugin warns once when blocking starts and again when it recovers, so logs stay quiet in a long blocked stretch.

Requirements: Node.js >= 18 (18+ for `fetch`, 22/24 tested), and `curl` present on the host for transport 2 (installed by default on Raspberry Pi OS, Docker images and macOS).

## Troubleshooting

Each poll logs one info line with every parsed value and the raw payload field list, e.g.:

```
[ABC210M] 13.3 degC, 80.6 pct RH, 1028.1 hPa, PM1=0.86, PM2.5=1.71, PM4=n/a, PM10=1.86 | AQ=Excellent | payload fields: PM1/PM25/PM10/PRESSURE/HUMIDITY/TEMPERATURE
```

- `payload fields` without `TEMPERATURE`/`HUMIDITY` = the hardware published no such data at that moment (PM-only payload)
- `reports no air sensors (or data is not published)` = backend 404 for that locker; retried automatically after 24 hours. For a permanent fix, pick a different code from the ShipX list above
- `Detailed sensor data blocked (...)` = both transports were denied and the plugin fell back to the ShipX coarse level; start `homebridge -D` to see the full raw payloads
- HomeKit tiles named after a locker code instead of something readable = set `labels`

## Publishing to npm (maintainers)

Releases publish through npm **Trusted Publishing** (OIDC) - `.github/workflows/publish.yml` runs on every published GitHub release, with no tokens stored anywhere. The trusted publisher on npmjs.com is bound to `silvetti/homebridge-inpost-air` + `publish.yml`. The one-time bootstrap (initial manual `npm publish` with 2FA) is only needed once, when creating the package.

```
bump version in package.json -> push -> create GitHub release vX.Y.Z -> done
```

npm records a provenance attestation for every release, linking the tarball to this repository.

## Caveats

- The detailed-data endpoint is **unofficial and undocumented**. It can change or disappear at any time without notice.
- Cloudflare behavior varies by client and IP; the curl transport exists because Node's `fetch` is blocked in some environments.
- This project is not affiliated with, sponsored, or endorsed by InPost. Paczkomat is a registered trademark of InPost.

## Credits

- [CyberDeer/InPost-Air](https://github.com/CyberDeer/InPost-Air) - Home Assistant integration that reverse-engineered the endpoint and payload format
- [szkocot/air-quality-map](https://github.com/szkocot/air-quality-map) - showed the honest-UA / cookieless POST works on current Node, and that the ShipX catalog marks sensor-equipped lockers
- [virusek173/Marvin](https://github.com/virusek173/Marvin) - documented the "cold POST => 403, POST with page cookies => 200" behavior
- [leshniak/inpost-air](https://github.com/leshniak/inpost-air) - earlier experiments with the same data source

## License

MIT
