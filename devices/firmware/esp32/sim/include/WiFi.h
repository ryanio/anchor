#ifndef ANCHOR_SIM_WIFI_H
#define ANCHOR_SIM_WIFI_H

/*
 * The radio, as a scenario rather than a radio.
 *
 * `wifi_setup.cpp` asks the ESP32 core five things — scan, read a result, connect, read a status,
 * read an address — and every one of them is a promise about *time*: a scan that is still running,
 * a join that has not landed yet, a join that never will. Those are the transitions its state
 * machine is made of, so they are what this file models: a scan that takes `simScanMs` of the
 * virtual clock, a join that takes `simConnectMs` and then succeeds or fails on a rule the driver
 * sets.
 *
 * The join rule is flint's, for the same reason: a passphrase under eight characters fails, so the
 * failure screen has something to fail on without anyone standing near a router. `--join-fail`
 * fails everything, which is the case a device left on a desk actually meets.
 */

#include <cstdint>
#include <string>
#include <vector>

#include "Arduino.h"

typedef enum {
  WL_NO_SHIELD = 255,
  WL_IDLE_STATUS = 0,
  WL_NO_SSID_AVAIL = 1,
  WL_SCAN_COMPLETED = 2,
  WL_CONNECTED = 3,
  WL_CONNECT_FAILED = 4,
  WL_CONNECTION_LOST = 5,
  WL_DISCONNECTED = 6,
} wl_status_t;

typedef enum {
  WIFI_OFF = 0,
  WIFI_STA = 1,
  WIFI_AP = 2,
  WIFI_AP_STA = 3,
} wifi_mode_t;

typedef enum {
  WIFI_AUTH_OPEN = 0,
  WIFI_AUTH_WEP = 1,
  WIFI_AUTH_WPA_PSK = 2,
  WIFI_AUTH_WPA2_PSK = 3,
  WIFI_AUTH_WPA_WPA2_PSK = 4,
} wifi_auth_mode_t;

#define WIFI_SCAN_RUNNING (-1)
#define WIFI_SCAN_FAILED (-2)

struct SimNetwork {
  std::string ssid;
  int32_t rssi = -60;
  bool open = false;
};

class WiFiSim {
 public:
  void mode(wifi_mode_t m) { mode_ = m; }
  void scanDelete();
  int16_t scanNetworks(bool async = false);
  int16_t scanComplete();
  String SSID(uint8_t index);
  int32_t RSSI(uint8_t index);
  wifi_auth_mode_t encryptionType(uint8_t index);
  void begin(const char *ssid, const char *passphrase = nullptr);
  void disconnect(bool wifioff = false, bool eraseap = false);
  wl_status_t status();
  IPAddress localIP() const { return IPAddress(192, 168, 1, 74); }

  /* The driver's half. */
  void simSetNetworks(const std::vector<SimNetwork> &nets) { available_ = nets; }
  void simSetScanMs(uint32_t ms) { scan_ms_ = ms; }
  void simSetConnectMs(uint32_t ms) { connect_ms_ = ms; }
  void simSetJoinAlwaysFails(bool fails) { always_fails_ = fails; }
  /* Every attempt, so a scenario can assert what the firmware actually asked the radio to join. */
  struct Attempt {
    std::string ssid;
    std::string pass;
    uint32_t at = 0;
  };
  const std::vector<Attempt> &simAttempts() const { return attempts_; }

 private:
  bool joins(const Attempt &attempt) const;

  wifi_mode_t mode_ = WIFI_OFF;
  std::vector<SimNetwork> available_;
  std::vector<SimNetwork> results_;
  bool scanning_ = false;
  bool scan_done_ = false;
  uint32_t scan_started_ = 0;
  uint32_t scan_ms_ = 1200;

  std::vector<Attempt> attempts_;
  bool connecting_ = false;
  uint32_t connect_started_ = 0;
  uint32_t connect_ms_ = 2000;
  bool always_fails_ = false;
  wl_status_t status_ = WL_IDLE_STATUS;
};

extern WiFiSim WiFi;

#endif /* ANCHOR_SIM_WIFI_H */
