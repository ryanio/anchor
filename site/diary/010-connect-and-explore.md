---
title: "Connect and explore"
date: "2026-09-22"
summary: "The handheld foundation gains background requests, remembered networks, and a touch browser on the AMOLED display."
---

The Waveshare display now opens an Explore browser from its ambient screen. Pick a trending token
to read its price, daily change, volume, and address, or open the configured portfolio. The
Cardputer keeps its keyboard browser and gains background OpenSea requests, so fetching no longer
runs on the input loop.

Both devices now cancel interest in obsolete work. Leaving a view, changing tokens, or switching
networks prevents an earlier response from appearing under a new selection. Each worker owns its
HTTP connection until it returns; cancellation does not kill a task underneath TLS. The two
firmwares share the small generation gate that makes this rule testable.

Wi-Fi settings remember four successful networks. A failed replacement leaves the previous
configuration available. Association is only the first step: OpenSea authentication and request
failures still get their own states. Those distinctions matter for a hotel network that accepts a
connection but requires another step before providing internet.

The foundation also has one development workflow for checking tools, installing pinned dependencies,
building both boards, and running their simulators. Firmware CI runs the boards in parallel, selects
the affected target, and skips compilation for documentation. Builds with obvious placeholders prove the API
readers were compiled without using a real credential.
A cold CI cache exposed another setup bug: broad M5 dependency ranges installed newer libraries
before their direct pins were processed. Bootstrap now installs the complete pinned library set;
platform compiler dependencies still resolve normally. Simulators run before the slower board builds.

The checks found problems a successful compile could not. The new touch browser initially collapsed
its rows into a narrow column. A rendered frame exposed the layout, and tap-through checks now
require visible token and portfolio labels. A crowded Wi-Fi scan exposed an undersized display heap;
the simulator now exercises all 32 networks and the keyboard, and fails promptly on allocation errors.

A live API check returned 401 without a key and 200 with the vault key, with cache headers showing
origin evaluation. Ryan's username resolves to one canonical public address. That is useful starting
configuration, but it does not establish a complete linked-wallet list.

Three Cardputer ADVs and three Waveshare AMOLED units are the onsite target. The inventory records
Ryan's battery and screen observations. Two connected units received private demo builds with verified
uploads and their saved settings preserved. Builds and simulations do not establish their untethered
behavior: hotspot connection, touch, responsiveness during real TLS timeouts, and
battery runtime still need testing on the physical units. Multiplayer remains upcoming work.
