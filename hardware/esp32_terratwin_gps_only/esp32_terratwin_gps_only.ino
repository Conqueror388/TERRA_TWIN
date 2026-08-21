/*
 * TerraTwin AI — ESP32 + NEO-6M Field Unit (GPS-ONLY, no LEDs/buzzer/OLED)
 * A stripped-down variant for the minimal 4-wire setup:
 *     NEO-6M RX -> ESP32 TX2 (GPIO17)  [optional]
 *     NEO-6M TX -> ESP32 RX2 (GPIO16)
 *     NEO-6M VCC -> 3V3
 *     NEO-6M GND -> GND
 *
 * Same contract as the full sketch: it only reports the worker's position
 * to the backend; the backend's DigSafe risk engine decides the risk and
 * the response is logged to Serial. No on-device beeps or lights — the
 * HIGH/CRITICAL alert still lands in the backend's incident feed and Live
 * Monitoring dashboard.
 *
 * FLOW
 *   NEO-6M --serial--> ESP32 --Wi-Fi/HTTP POST--> Node.js backend
 *                                                  |
 *                                        DigSafe risk engine
 *                                                  |
 *   ESP32 <--JSON {riskLevel, alert}--  -> printed to Serial Monitor
 *
 * LIBRARIES (Arduino Library Manager)
 *   - TinyGPSPlus    by Mikal Hart
 *   - ArduinoJson    by Benoit Blanchon
 *   - WiFi + HTTPClient (bundled with ESP32 board package)
 */

#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <TinyGPSPlus.h>

// ---------------------------------------------------------------- CONFIG

const char* WIFI_SSID = "YOUR_WIFI_SSID";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";

// Point this at your backend. Use your laptop's LAN IP (ipconfig) when the
// ESP32 is on the same network, e.g. http://192.168.1.5:4000/api/devices/gps
const char* BACKEND_GPS_URL = "http://192.168.1.5:4000/api/devices/gps";

const char* DEVICE_ID = "ESP32-001";

const unsigned long GPS_POST_INTERVAL_MS = 4000; // how often to check in

// ---------------------------------------------------------------- STATE

TinyGPSPlus gps;
HardwareSerial GPSSerial(2); // UART2: RX2=16, TX2=17

unsigned long lastPostAt = 0;

void setup() {
  Serial.begin(115200);
  GPSSerial.begin(9600, SERIAL_8N1, 16, 17);
  connectWifi();
}

void loop() {
  // Feed the GPS parser continuously.
  while (GPSSerial.available() > 0) {
    gps.encode(GPSSerial.read());
  }

  if (millis() - lastPostAt >= GPS_POST_INTERVAL_MS) {
    lastPostAt = millis();
    if (gps.location.isValid()) {
      checkIn(gps.location.lat(), gps.location.lng());
    } else {
      Serial.println("[GPS] No fix yet — waiting for satellites...");
    }
  }
}

void connectWifi() {
  Serial.printf("[WiFi] Connecting to %s", WIFI_SSID);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 40) {
    delay(250);
    Serial.print(".");
    attempts++;
  }
  Serial.println();
  Serial.println(WiFi.status() == WL_CONNECTED ? "[WiFi] Connected." : "[WiFi] FAILED to connect.");
}

void checkIn(double lat, double lng) {
  if (WiFi.status() != WL_CONNECTED) {
    connectWifi();
    if (WiFi.status() != WL_CONNECTED) return;
  }

  StaticJsonDocument<256> body;
  body["deviceId"] = DEVICE_ID;
  body["latitude"] = lat;
  body["longitude"] = lng;
  body["timestamp"] = (unsigned long)(millis()); // swap for real epoch time via NTP if available

  String payload;
  serializeJson(body, payload);

  HTTPClient http;
  http.begin(BACKEND_GPS_URL);
  http.addHeader("Content-Type", "application/json");
  int status = http.POST(payload);

  if (status == 200) {
    String response = http.getString();
    handleResponse(response);
  } else {
    Serial.printf("[HTTP] POST failed, status=%d\n", status);
  }

  http.end();
}

void handleResponse(const String& json) {
  StaticJsonDocument<512> doc;
  DeserializationError err = deserializeJson(doc, json);
  if (err) {
    Serial.println("[JSON] Failed to parse backend response.");
    return;
  }

  bool alert = doc["alert"] | false;
  const char* riskLevel = doc["riskLevel"] | "UNKNOWN";
  int score = doc["digSafeScore"] | -1;
  // The risk driver is threat*; fall back to nearest* for older backends.
  const char* utilityType = doc["threatUtilityType"] | doc["nearestUtilityType"] | "";
  float utilityDepth = doc["threatUtilityDepth"] | doc["nearestUtilityDepth"] | 0.0;

  Serial.printf("[Risk] score=%d level=%s alert=%d\n", score, riskLevel, alert);
  if (alert) {
    Serial.printf("  !! HIGH RISK — threat %s pipe at %.1fm — stop / verify\n", utilityType, utilityDepth);
  } else {
    Serial.printf("  Clear — score %d/100 (%s)\n", score, riskLevel);
  }
}
