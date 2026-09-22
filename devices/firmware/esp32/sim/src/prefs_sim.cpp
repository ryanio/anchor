/* NVS in a text file: `namespace/key<TAB>value`, one per line. */

#include "Preferences.h"

#include <fstream>
#include <map>
#include <string>

namespace {

std::string store_path = "sim-nvs-pulse.txt";
std::map<std::string, std::string> entries;
bool loaded = false;

void load() {
  if (loaded) return;
  loaded = true;
  std::ifstream in(store_path, std::ios::binary);
  if (!in) return;
  std::string text;
  while (std::getline(in, text)) {
    if (!text.empty() && text.back() == '\r') text.pop_back();
    const size_t tab = text.find('\t');
    if (tab == std::string::npos) continue;
    entries[text.substr(0, tab)] = text.substr(tab + 1);
  }
}

void save() {
  std::ofstream out(store_path, std::ios::binary | std::ios::trunc);
  if (!out) return;
  for (const auto &entry : entries) {
    out << entry.first << '\t' << entry.second << '\n';
  }
}

}  // namespace

void Preferences::simSetPath(const char *path) {
  store_path = path;
  entries.clear();
  loaded = false;
}

bool Preferences::begin(const char *name, bool readOnly) {
  load();
  namespace_ = name == nullptr ? "" : name;
  read_only_ = readOnly;
  open_ = true;
  return true;
}

void Preferences::end() {
  open_ = false;
}

String Preferences::getString(const char *key, const char *fallback) {
  load();
  if (!open_ || key == nullptr) return String(fallback);
  const auto found = entries.find(namespace_ + "/" + key);
  if (found == entries.end()) return String(fallback);
  return String(found->second);
}

size_t Preferences::putString(const char *key, const String &value) {
  load();
  // The real Preferences refuses a write to a namespace opened read-only. Refusing it here too is
  // the difference between a simulator that proves a save happened and one that only proves a
  // function was called.
  if (!open_ || read_only_ || key == nullptr) return 0;
  entries[namespace_ + "/" + key] = std::string(value);
  save();
  return value.size();
}

bool Preferences::remove(const char *key) {
  load();
  if (!open_ || read_only_ || key == nullptr) return false;
  const size_t removed = entries.erase(namespace_ + "/" + key);
  if (removed != 0) save();
  return removed != 0;
}

bool Preferences::clear() {
  load();
  if (!open_ || read_only_) return false;
  const std::string prefix = namespace_ + "/";
  bool removed = false;
  for (auto entry = entries.begin(); entry != entries.end();) {
    if (entry->first.compare(0, prefix.size(), prefix) == 0) {
      entry = entries.erase(entry);
      removed = true;
    } else {
      ++entry;
    }
  }
  if (removed) save();
  return true;
}
