/*
 * TerraTwin AI — ESP32 + NEO-6M Field Unit
 * Phase 9: GPS positioning + Wi-Fi check-in
 * Phase 10: On-site risk alert (LED + buzzer + OLED)
 *
 * IMPORTANT PROTOTYPE NOTE (see implementation plan, section "Key Technical
 * Principles"): GPS does NOT detect buried pipes or cables. This unit only
 * reports the worker's position; the backend's deterministic DigSafe risk
 * engine compares that position against the (simulated) utility registry
 * and tells the firmware whether to alert. The ESP32 never decides risk
 * itself.
 *
 * FLOW
 *   NEO-6M --serial--> ESP32 --Wi-Fi/HTTP POST--> Node.js backend
 *                                                    |
 *                                          DigSafe risk engine
 *                                                    |
 *   ESP32 <--JSON {riskLevel, alert}------------------
 *   LOW/MEDIUM  -> green LED on
 *   HIGH/CRITICAL -> red LED on, buzzer on, OLED shows warning
 *
 * WIRING (adjust pins to your board)
 *   NEO-6M   TX  -> ESP32 RX2 (GPIO16)
 *   NEO-6M   RX  -> ESP32 TX2 (GPIO17)   (optional, GPS-only needs just TX)
 *   NEO-6M   VCC -> 3V3 (or 5V, check module)
 *   NEO-6M   GND -> GND
 *   Green LED ->  GPIO25  (through ~220ohm resistor to GND)
 *   Red LED   ->  GPIO26  (through ~220ohm resistor to GND)
 *   Buzzer    ->  GPIO27
 *   Push button -> GPIO32 (to GND, uses internal pull-up)
 *   OLED (SSD1306, optional) -> I2C SDA=GPIO21, SCL=GPIO22
 *
 * LIBRARIES (Arduino Library Manager)
 *   - TinyGPSPlus            by Mikal Hart
 *   - ArduinoJson             by Benoit Blanchon
 *   - Adafruit SSD1306 + Adafruit GFX   (only if USE_OLED is defined)
 *   - WiFi (bundled with ESP32 board package)
 *   - HTTPClient (bundled with ESP32 board package)
 */

#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <TinyGPSPlus.h>

// #define USE_OLED   // uncomment if an SSD1306 OLED is wired up
#ifdef USE_OLED
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
Adafruit_SSD1306 display(128, 64, &Wire, -1);
#endif

// ---------------------------------------------------------------- CONFIG

const char* WIFI_SSID = "YOUR_WIFI_SSID";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";

// Point this at your backend. For a laptop running `npm run dev` on the
// same LAN as the ESP32, use the laptop's local IP, e.g. http://192.168.1.42:4000
const char* BACKEND_GPS_URL = "http://192.168.1.42:4000/api/devices/gps";

const char* DEVICE_ID = "ESP32-001";

const int PIN_LED_GREEN = 25;
const int PIN_LED_RED = 26;
const int PIN_BUZZER = 27;
const int PIN_BUTTON = 32;

const unsigned long GPS_POST_INTERVAL_MS = 4000; // how often to check in
const unsigned long BUTTON_DEBOUNCE_MS = 50; // ignore contact bounce noise

// ---------------------------------------------------------------- STATE

TinyGPSPlus gps;
HardwareSerial GPSSerial(2); // UART2: RX2=16, TX2=17

unsigned long lastPostAt = 0;
bool lastAlertState = false;
bool lastButtonState = HIGH; // INPUT_PULLUP idle-high
unsigned long lastButtonChangeAt = 0;

void setup() {
  Serial.begin(115200);
  GPSSerial.begin(9600, SERIAL_8N1, 16, 17);

  pinMode(PIN_LED_GREEN, OUTPUT);
  pinMode(PIN_LED_RED, OUTPUT);
  pinMode(PIN_BUZZER, OUTPUT);
  pinMode(PIN_BUTTON, INPUT_PULLUP);

  digitalWrite(PIN_LED_GREEN, LOW);
  digitalWrite(PIN_LED_RED, LOW);
  digitalWrite(PIN_BUZZER, LOW);

#ifdef USE_OLED
  Wire.begin(21, 22);
  if (display.begin(SSD1306_SWITCHCAPVCC, 0x3C)) {
    display.clearDisplay();
    display.setTextColor(SSD1306_WHITE);
  }
#endif

  connectWifi();
  oledMessage("TERRATWIN AI", "Booting...", "");
}

void loop() {
  // Feed the GPS parser continuously.
  while (GPSSerial.available() > 0) {
    gps.encode(GPSSerial.read());
  }

  // Manual "START EXCAVATION" style trigger: force an immediate check-in
  // on a debounced press (falling edge), not on every loop() while held —
  // otherwise a held or bouncing button floods the backend with requests.
  bool rawButtonState = digitalRead(PIN_BUTTON);
  bool buttonPressEdge = false;
  if (rawButtonState != lastButtonState && millis() - lastButtonChangeAt > BUTTON_DEBOUNCE_MS) {
    lastButtonChangeAt = millis();
    lastButtonState = rawButtonState;
    if (rawButtonState == LOW) buttonPressEdge = true; // pressed (pulled to GND)
  }

  bool dueForPost = millis() - lastPostAt >= GPS_POST_INTERVAL_MS;

  if (gps.location.isValid() && (dueForPost || buttonPressEdge)) {
    lastPostAt = millis();
    checkIn(gps.location.lat(), gps.location.lng());
  } else if (!gps.location.isValid() && dueForPost) {
    lastPostAt = millis();
    Serial.println("[GPS] No fix yet — waiting for satellites...");
    oledMessage("TERRATWIN AI", "Waiting for GPS fix", "");
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
    oledMessage("TERRATWIN AI", "Backend unreachable", "");
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

  setAlertState(alert);

  if (alert) {
    char depthLine[32];
    snprintf(depthLine, sizeof(depthLine), "%s: %.1fm", utilityType, utilityDepth);
    oledMessage("RISK: HIGH", depthLine, "STOP / VERIFY");
  } else {
    char scoreLine[24];
    snprintf(scoreLine, sizeof(scoreLine), "Score: %d/100", score);
    oledMessage("TERRATWIN AI", scoreLine, riskLevel);
  }
}

void setAlertState(bool alert) {
  if (alert == lastAlertState) return; // avoid re-triggering buzzer every loop
  lastAlertState = alert;

  digitalWrite(PIN_LED_GREEN, alert ? LOW : HIGH);
  digitalWrite(PIN_LED_RED, alert ? HIGH : LOW);

  if (alert) {
    // Short double-beep rather than a continuous tone, so it's noticeable
    // but not deafening on repeated check-ins.
    tone(PIN_BUZZER, 2000, 150);
    delay(200);
    tone(PIN_BUZZER, 2000, 150);
  } else {
    noTone(PIN_BUZZER);
  }
}

void oledMessage(const char* line1, const char* line2, const char* line3) {
  Serial.printf("[OLED] %s | %s | %s\n", line1, line2, line3);
#ifdef USE_OLED
  display.clearDisplay();
  display.setTextSize(1);
  display.setCursor(0, 0);
  display.println(line1);
  display.setCursor(0, 20);
  display.println(line2);
  display.setCursor(0, 40);
  display.println(line3);
  display.display();
#endif
}
