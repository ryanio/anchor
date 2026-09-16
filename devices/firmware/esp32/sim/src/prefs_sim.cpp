/* NVS in a text file: `namespace/key<TAB>value`, one per line. */

#include "Preferences.h"

#include <cstdio>
#include <map>
#include <string>

namespace {

std::string store_path = "sim-nvs-pulse.txt";
std::map<std::string, std::string> entries;
bool loaded = false;

void load() {
  if (loaded) return;
  loaded = true;
  FILE *in = fopen(store_path.c_str(), "rb");
  if (in == nullptr) return;
  char line[512];
  while (fgets(line, sizeof(line), in) != nullptr) {
    std::string text(line);
    while (!text.empty() && (text.back() == '\n' || text.back() == '\r')) text.pop_back();
    const size_t tab = text.find('\t');
    if (tab == std::string::npos) continue;
    entries[text.substr(0, tab)] = text.substr(tab + 1);
  }
  fclose(in);
}

void save() {
  FILE *out = fopen(store_path.c_str(), "wb");
  if (out == nullptr) return;
  for (const auto &entry : entries) {
    fprintf(out, "%s\t%s\n", entry.first.c_str(), entry.second.c_str());
  }
  fclose(out);
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
  const auto found = entries.find(namespace_ + "/" + key);
  if (found == entries.end()) return String(fallback);
  return String(found->second);
}

size_t Preferences::putString(const char *key, const String &value) {
  load();
  // The real Preferences refuses a write to a namespace opened read-only. Refusing it here too is
  // the difference between a simulator that proves a save happened and one that only proves a
  // function was called.
  if (read_only_) return 0;
  entries[namespace_ + "/" + key] = std::string(value);
  save();
  return value.size();
}

bool Preferences::clear() {
  if (read_only_) return false;
  entries.clear();
  save();
  return true;
}
