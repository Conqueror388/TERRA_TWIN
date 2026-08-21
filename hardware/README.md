# TerraTwin AI — Hardware (ESP32 + NEO-6M GPS)

Implements plan sections **13 (ESP32 + GPS)** and **14 (Hardware Risk Alert)**.

## What this is actually good for

Being honest about the physics: **GPS cannot detect buried pipes or cables.**
The unit only ever knows where the worker is standing, in the open air,
above ground. Don't pitch this as "underground detection hardware" — pitch
it as **process-compliance hardware**, which is a real and useful thing a
cheap GPS module can do:

- **Geofencing** — confirm the worker is physically at the location named in
  the locate request / excavation plan, not somewhere else on the site.
- **Timestamped proof of process** — a check-in logged *before* digging
  starts is evidence the locate-request step wasn't skipped.
- **Out-of-zone alerting** — buzz/alert if active digging drifts outside the
  approved excavation footprint.

The risk-position alerting described below (comparing GPS position to the
simulated utility registry) is still in the firmware as a demo of
location-aware behavior, but it inherits the same "simulated data" caveat as
the rest of the app — see the root `README.md`. Treat it as a proof of
concept for the geofencing/compliance use case above, not as a underground
warning system in its own right.

## What this proves

The field unit demonstrates *location-aware* operation: it reports the
worker's real GPS position to the backend, and the backend's deterministic
DigSafe risk engine tells it whether the worker is standing over a
high-risk excavation zone. **The GPS module does not detect buried
pipes or cables** — it only knows where the worker is standing. Risk comes
entirely from comparing that position against the (simulated) utility
registry, exactly as it does in the web dashboard's Excavation Planner.

## Bill of materials

| Part | Notes |
|---|---|
| ESP32 dev board | Any variant with 2 free UART pins + I2C |
| NEO-6M GPS module | Needs clear sky view; first fix can take 30-60s cold |
| Green LED + ~220Ω resistor | Safe / low-medium risk indicator |
| Red LED + ~220Ω resistor | High / critical risk indicator |
| Active buzzer | 2-pin type works with `tone()` |
| Push button | Manual check-in trigger |
| SSD1306 OLED (optional) | 128x64, I2C — enable with `#define USE_OLED` |

## Wiring

```
NEO-6M   TX  -> ESP32 GPIO16 (RX2)
NEO-6M   RX  -> ESP32 GPIO17 (TX2)      [optional for GPS-only use]
NEO-6M   VCC -> 3V3 (check your module's voltage requirement)
NEO-6M   GND -> GND

Green LED -> GPIO25 -> resistor -> GND
Red LED   -> GPIO26 -> resistor -> GND
Buzzer    -> GPIO27 -> GND
Button    -> GPIO32 -> GND  (internal pull-up, active-low)

OLED (optional): SDA -> GPIO21, SCL -> GPIO22
```

## Arduino IDE setup

1. Install the **ESP32 board package** (Boards Manager → search "esp32").
2. Install libraries via Library Manager:
   - `TinyGPSPlus` (Mikal Hart)
   - `ArduinoJson` (Benoit Blanchon)
   - `Adafruit SSD1306` + `Adafruit GFX Library` — only if you wire up the OLED
3. Open `esp32_terratwin/esp32_terratwin.ino` — or, if you're running the
   minimal 4-wire GPS-only setup (no LEDs/buzzer/OLED), open
   `esp32_terratwin_gps_only/esp32_terratwin_gps_only.ino` instead. Alerts
   then appear only on the Serial Monitor and in the backend's incident feed.
4. Edit the config block near the top:
   ```cpp
   const char* WIFI_SSID = "YOUR_WIFI_SSID";
   const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";
   const char* BACKEND_GPS_URL = "http://<your-laptop-ip>:4000/api/devices/gps";
   ```
   Your laptop and the ESP32 need to be on the **same Wi-Fi network**. Find
   your laptop's LAN IP (`ipconfig` on Windows, `ifconfig`/`ip a` on
   macOS/Linux) — don't use `localhost`, the ESP32 can't resolve that.
5. Uncomment `#define USE_OLED` near the top if the OLED is wired up.
6. Select your board + port, upload.
7. Open the Serial Monitor at 115200 baud to watch GPS fix status, HTTP
   check-ins, and the risk responses coming back from the backend.

## How it behaves

- Every ~4 seconds (or immediately on button press), the unit posts its
  current GPS fix to `POST /api/devices/gps`.
- The backend runs the same DigSafe risk engine used by the web dashboard
  against a fixed "typical dig depth" (this unit only knows position, not
  a planned excavation depth — see the code comment in the `.ino` for why).
- The backend responds with `{ riskLevel, digSafeScore, alert }`.
- `alert: true` (HIGH/CRITICAL risk) → red LED on, buzzer double-beeps,
  OLED shows `RISK: HIGH` + the nearest utility type/depth + `STOP / VERIFY`.
- `alert: false` (LOW/MEDIUM risk) → green LED on, OLED shows the score.

The dashboard can read `GET /api/devices` for the latest known position of
every field unit — useful for a "Live GPS" panel showing where workers
currently are on the Live Monitoring page.

## Demo tip

If you don't want to rely on live GPS fix during a demo (satellite
acquisition can be slow indoors), you can temporarily hardcode
`gps.location.lat()/lng()` calls in `checkIn()` to a fixed coordinate near
one of the simulated utilities in `backend/src/data/utilities.js`, to
guarantee a HIGH/CRITICAL alert fires on stage.
