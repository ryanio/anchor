#ifndef ANCHOR_SIM_PREFERENCES_H
#define ANCHOR_SIM_PREFERENCES_H

/*
 * NVS, as a text file next to the binary — the same trick the Cardputer simulator plays with
 * `sim-nvs-flint.txt`, and for the same reason: "does this unit remember the network across a
 * reboot" is a real question about `wifi_setup.cpp` and it needs storage that outlives a process.
 *
 * The file is readable on purpose. A saved passphrase is visible in it, which is correct for a
 * simulator holding a fixture and would be a finding on a device; nothing here ever runs on one.
 */

#include <map>
#include <string>

#include "Arduino.h"

class Preferences {
 public:
  bool begin(const char *name, bool readOnly = false);
  void end();
  String getString(const char *key, const char *fallback = "");
  size_t putString(const char *key, const String &value);
  bool remove(const char *key);
  bool clear();

  /* The driver's half: where the store lives, so a run can start from a known unit. */
  static void simSetPath(const char *path);

 private:
  std::string namespace_;
  bool open_ = false;
  bool read_only_ = true;
};

#endif /* ANCHOR_SIM_PREFERENCES_H */
