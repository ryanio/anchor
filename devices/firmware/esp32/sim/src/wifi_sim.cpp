/*
 * The radio's half of a scenario: a scan that takes time to finish and a join that takes time to
 * fail.
 */

#include "WiFi.h"

WiFiSim WiFi;

void WiFiSim::scanDelete() {
  results_.clear();
  scan_done_ = false;
  scanning_ = false;
}

int16_t WiFiSim::scanNetworks(bool async) {
  scanning_ = true;
  scan_done_ = false;
  scan_started_ = millis();
  results_.clear();
  if (!async) {
    // The blocking form is not what `wifi_setup.cpp` calls, and modelling it as instant would be a
    // lie about the only interesting thing a scan does, so it costs its time here too.
    simAdvanceClock(scan_ms_);
    return (int16_t)scanComplete();
  }
  return WIFI_SCAN_RUNNING;
}

int16_t WiFiSim::scanComplete() {
  if (scanning_) {
    if (millis() - scan_started_ < scan_ms_) return WIFI_SCAN_RUNNING;
    scanning_ = false;
    scan_done_ = true;
    results_ = available_;
  }
  if (!scan_done_) return WIFI_SCAN_FAILED;
  return (int16_t)results_.size();
}

String WiFiSim::SSID(uint8_t index) {
  if (index >= results_.size()) return String();
  return String(results_[index].ssid);
}

int32_t WiFiSim::RSSI(uint8_t index) {
  if (index >= results_.size()) return 0;
  return results_[index].rssi;
}

wifi_auth_mode_t WiFiSim::encryptionType(uint8_t index) {
  if (index >= results_.size()) return WIFI_AUTH_WPA2_PSK;
  return results_[index].open ? WIFI_AUTH_OPEN : WIFI_AUTH_WPA2_PSK;
}

void WiFiSim::begin(const char *ssid, const char *passphrase) {
  Attempt attempt;
  attempt.ssid = ssid == nullptr ? "" : ssid;
  attempt.pass = passphrase == nullptr ? "" : passphrase;
  attempt.at = millis();
  attempts_.push_back(attempt);
  connecting_ = true;
  connect_started_ = millis();
  status_ = WL_DISCONNECTED;
}

void WiFiSim::disconnect(bool wifioff, bool eraseap) {
  (void)wifioff;
  (void)eraseap;
  connecting_ = false;
  status_ = WL_DISCONNECTED;
}

/*
 * Whether a join lands.
 *
 * flint's rule, kept deliberately: an SSID that is not on the air fails, an open network joins, and
 * a passphrase under eight characters fails — WPA2's own minimum, so it is the rule a real AP
 * applies too. A unit that always joined would leave the failure screen and the retry path
 * unexercised, which are the halves of this module most likely to be wrong, because they are the
 * halves nobody demonstrates.
 */
bool WiFiSim::joins(const Attempt &attempt) const {
  if (always_fails_) return false;
  for (const SimNetwork &net : available_) {
    if (net.ssid != attempt.ssid) continue;
    if (net.open) return attempt.pass.empty();
    return attempt.pass.size() >= 8;
  }
  return false;  // a network that is not there, which is what a typed-in name usually is
}

wl_status_t WiFiSim::status() {
  if (connecting_ && millis() - connect_started_ >= connect_ms_) {
    connecting_ = false;
    status_ = joins(attempts_.back()) ? WL_CONNECTED : WL_CONNECT_FAILED;
  }
  return status_;
}
