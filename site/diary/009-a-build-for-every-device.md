---
title: "A build for every device"
date: "2026-09-21"
summary: "Both handheld targets get a shared development workflow, real firmware build checks, and a recorded six-device fleet."
---

Anchor's two handheld targets now have one development workflow: check the tools, install the
pinned dependencies, build the firmware, and run a desktop simulator. The Cardputer ADV and the
Waveshare AMOLED each keep their existing renderer. The shared part is how a contributor gets from
a clone to a build they can inspect.

This prepares three of each device for an onsite where people can pick one up, explore public
OpenSea data, change an app, and eventually play together. The hardware inventory records those six
units and Ryan's confirmation that the ESP32 setup has lithium batteries installed. It also records
what remains unknown, including each unit's firmware, revision, and measured battery runtime.

The build checks compile both physical firmware targets. They also compile the API readers with
obvious nonsecret placeholders in a separate temporary build. A firmware image that succeeds only
because its network code was disabled would miss the behavior these devices need away from a
computer. Those temporary images are deleted after the check.

One data fix belongs with this foundation. Cardputer token details were matched by address alone,
although the same address can identify different contracts on different chains. Fetch reuse, the
display guard, and selection restoration now share a chain-and-address comparison. A C++ regression
test exercises that actual firmware code.

The macOS setup exposed its own problems. A Wi-Fi constant collided with a system header, and
Arduino's Intel-only ctags helper could not run on this Apple Silicon machine. These are development
environment failures that a Linux-only build would leave for the next contributor to discover.

The Linux smoke test then found a different failure: Cardputer wrote its frame and crashed during
shutdown. A debugger caught the worker thread destroying the display while SDL's main thread was
still running. The fix belongs in Flint's simulator, so Anchor takes the corrected platform revision.

The next work is the app foundation: background requests that leave input responsive, saved-network
switching, shared data rules, and components fitted to each screen. The roadmap keeps those ahead of
more apps. Simulator results cover layout and logic; the physical fleet still needs checks for
display addressing, touch, radio behavior, charging, and battery life.
