# Physical device inventory

This inventory records the six devices Ryan intends to use onsite. It separates owner-reported
facts, vendor specifications, and measurements made against one unit. The slot names below are
proposed identifiers only. The devices have not been physically labelled or matched to these slots.

## Owner-reported fleet

| Inventory slots | Count | Product Ryan identified | What is known now |
|---|---:|---|---|
| CP-01 through CP-03 | 3 | [M5Stack Cardputer-Adv, SKU K132-ADV](https://shop.m5stack.com/products/m5stack-cardputer-adv-version-esp32-s3) | Intended onsite fleet. One USB identity is recorded below; firmware revision and fleet labels remain unverified. |
| ESP-01 through ESP-03 | 3 | [Waveshare ESP32-S3-Touch-AMOLED-1.8](https://www.waveshare.com/esp32-s3-touch-amoled-1.8.htm) | Intended onsite fleet. Ryan reports that the ESP32 setup has lithium batteries installed, with capacity unknown. Battery presence has not been independently checked on every unit. Current firmware and per-unit board revisions are not recorded. |

Two attached devices have appeared with USB ID `303a:1001`, Espressif USB JTAG/serial. That ID does
not distinguish a Cardputer from a Waveshare display, so neither device is assigned to a slot yet.

## Current screen observations

On 2026-09-21, Ryan reported the following for the two devices plugged into this computer:

- The Cardputer shows the Anchor menu item, with Settings and Calm to its right.
- The ESP32 shows a Wi-Fi network list.

These observations confirm the displayed screens only. They do not identify the firmware revision,
map either unit to a USB port or inventory slot, or verify input, Wi-Fi association, or internet access.

## USB identification on 2026-09-22

Read-only esptool identification mapped the two reconnected units:

| Current port | Device | Flash and PSRAM | USB serial / MAC suffix |
|---|---|---|---|
| `/dev/cu.usbmodem101` | Cardputer ADV | 8 MB embedded flash | `76:2e:80` |
| `/dev/cu.usbmodem2101` | Waveshare AMOLED | 16 MB flash, 8 MB embedded PSRAM | `3a:d3:f0` |

The USB registry serials match the chip MACs. Port names can change after replugging; compare the
serial identity before uploading. These units still need physical fleet labels. Both installed
partition tables byte-match their respective new builds. The identification commands performed normal
resets, but did not write firmware or read wallet data or network credentials.

## Firmware update on 2026-09-22

The two identified units received private demo builds from Anchor `0716006`, using Flint `9873ac9`
for the Cardputer. Both images contained the owner-selected read-only API key, injected through a
temporary private header that was removed after compilation. No credential or keyed image is published.
The ESP32 build configures the single public demo address below.

Both OTA metadata records selected app0. After rechecking each chip identity, esptool wrote only
that application's partition at `0x10000` and verified the data hash on the device. NVS, filesystems,
bootloader, partition tables, and OTA selection were left intact. The Cardputer image was 1,193,328
bytes and the ESP32 image was 1,735,600 bytes. Both application startup banners were observed after
a controlled reboot. Cardputer reported a saved-network join attempt; ESP32 reported its panel up.
No panic appeared in either eight-second capture. Screen appearance, input, Wi-Fi browsing, and
unplugged operation still require physical observations. The ESP32 boot memory and panel telemetry
are recorded in [its driver document](devices-esp32.md#boot-diagnostics-on-2026-09-22).

## Vendor specifications

These describe the linked products. They do not prove the revision or condition of each unit.

The Cardputer-Adv product page lists an ESP32-S3FN8 with 8 MB flash, a 240x135 ST7789V2 TFT, a
56-key keyboard, a BMI270 IMU, and a built-in 1750 mAh lithium-ion battery. Those are ADV
specifications. The 1400 mAh base battery plus 120 mAh Stamp cell belongs to the older Cardputer and
Cardputer v1.1 in M5Stack's comparison table.

Waveshare lists the current V2 ESP32-S3-Touch-AMOLED-1.8 with an ESP32-S3R8, 8 MB PSRAM, 16 MB
flash, a 368x448 AMOLED driven by a CO5300, CST820 touch, QMI8658 IMU, and AXP2101 power management.
The product can be ordered with or without a 3.7 V MX1.25 lithium battery. Waveshare says the label
on the back identifies the revision. The linked product family is therefore insufficient to assign
V2 to all three units.

## Measurements already made

One Waveshare unit was probed as a V2 N16R8 board with a 368x448 CO5300 display, CST820 touch
controller, and AXP2101 power-management IC. This is evidence for that tested unit only. The driver
findings in [The ESP32 display](devices-esp32.md) remain required for this hardware:

- Start every flushed rectangle on an even column. Odd-column CO5300 writes produce a visible shear.
- Keep content at least 20 px from the rounded panel corners.
- Preserve the 40 ms CST820 touch settle when the controller reports a momentary zero finger count
  during contact.

## Firmware update on 2026-09-23

The Waveshare unit (`3a:d3:f0`) received a private demo build from Anchor `c32682f`, with the same
owner-selected read-only key as the 2026-09-22 build and the public demo address above. Before the
key went into the build it was checked again: 401 with `BYPASS` without it, 200 with `MISS` with it.
esptool confirmed the MAC and wrote only app0 at `0x10000` (1,737,840 bytes, hash verified on the
device). Its first health line after reboot reported 158,024 bytes of internal heap free, a low of
151,408, the LVGL pool 44% used, battery 100% on USB, and `trending=no-wifi`: no network is saved on
this unit, consistent with the Wi-Fi list it showed on 2026-09-21.

The Cardputer (`76:2e:80`) did not answer at first. Its port was present, but it sent no serial
output in six seconds and did not answer esptool's default or USB-JTAG reset, so nothing was written.
After Ryan replugged it, esptool confirmed its MAC and 8 MB flash and wrote only app0 at `0x10000`
(1,196,160 bytes, hash verified on the device), with the same key. Its first boot on `c32682f` printed
the Anchor profile banner and began joining its saved network, with no panic in a twelve-second
capture. What the old image was showing before the replug was not recorded, so whether it had hung
remains open.

Later the same night both units were updated again, to `ad4668c`, for the readable Wi-Fi network
rows on the ESP32 and the health line on the Cardputer. The same MAC and flash-size checks passed, and
only app0 was written (ESP32 1,737,856 bytes, Cardputer 1,196,944, both hashes verified). The ESP32's
first health line matched the earlier one, and the Cardputer again began joining its saved network with
no panic. The `c32682f` images stay in the private cache as the previous known-good build.

## Companion build, 2026-09-24

After the replug, both chips identified as before (`3a:d3:f0` on `/dev/cu.usbmodem2101`, `76:2e:80`
on `/dev/cu.usbmodem101`). The Waveshare unit received `46fd583`, which boots to the companion:
MAC and 16 MB flash confirmed, app0 only, 1,743,184 bytes, hash verified. Its first health line
reported 157,712 bytes of internal heap free, a low of 151,096, the LVGL pool 46% used, and battery
74% on USB, down from 100% before the unplug. The Cardputer stays on `f674c1d`, which is current for it.

Ryan then reported the keypad's delete as glitchy and the rounded corners cutting off part of the
display, while the bigger keys were much better. The unit received `2f04061` with the fixes (app0
only, 1,743,312 bytes, hash verified); its first health line reported 157,704 bytes free, a low of
148,184 and the LVGL pool 47% used. It still had no Wi-Fi saved.

## Audio check, 2026-09-25

With both units plugged back in and identified as before, the Waveshare unit received the
`audio/audio.ino` check from `eccfb41` (app0 only, 426,000 bytes, hash verified). The codec answered
with id `0x83 0x11` and configured without error. All three loopback cycles passed:

| Cycle | Quiet RMS | Tone RMS | 1 kHz rise | Talk peak |
|---|---|---|---|---|
| 1 | 42 | 29,686 | 100.3 dB | 199 |
| 2 | 43 | 29,667 | 103.2 dB | 10,523 |
| 3 | 156 | 29,644 | 92.6 dB | 6,862 |

The tone went out at an RMS of about 5,660, so a recorded RMS near 29,700 is louder than what was
sent and cannot be the outgoing samples copied back inside the codec: the microphone heard the
speaker through the air and clipped. Both I2S slots carried the same samples, so the codec sends its
one microphone on both. The talk window of cycle 1 stayed near the quiet level, and cycles 2 and 3
caught speech. Ryan heard the beep and reported that the recorded voice played back sounding good.

The unit was then restored to the `2f04061` companion image (hash verified) and booted to it. Its
first health line reported the battery at 3% and charging, after a night unplugged.

## Touch lag fix, 2026-09-25

Ryan reported the Waveshare unit as laggy to touch. Two unkeyed probe builds with
`PULSE_PERF_LOG=1` measured it before and after the fix; the figures are in
[the ESP32 notes](devices-esp32.md#touch-lag-measured-2026-09-25). The unit then received the keyed
`73b5e4a` image (app0 only, hash verified). Its first minute reported 157,652 bytes of internal heap
free, a low of 148,140, the LVGL pool 47% used, and battery 100% on USB. The one slow frame in that
minute (196 ms) is the companion screen being built at boot. It still had no Wi-Fi saved.

## Idle soak, 2026-09-23

A read-only serial logger recorded the Waveshare unit on `ad4668c` from 15:09 to 22:29, when both
units were unplugged. Its once-a-minute health line appeared 441 times, reaching `up=26521s` (7 h
22 min) with no reboot, and every line reported the same memory: 158,024 bytes of internal heap free,
a lowest-ever of 149,108, and 67,512 bytes free in the LVGL pool. So the idle firmware neither leaks nor
fragments. The unit had no Wi-Fi saved throughout (`trending=no-wifi`), so this says nothing about
TLS, the fetch worker's stack, or memory under network load; that soak still needs a saved network.

## Size on the glass, 2026-09-22

After the demo images were flashed, Ryan reported that the Waveshare unit is very small to read and
that its Wi-Fi keyboard is extremely hard to use. The keyboard had 27 to 32 px keys, about 2.5 mm on
this panel. A three-column keypad with 104 x 63 px keys and larger Explore and Wi-Fi text replaced
it in the source; see
[the ESP32 notes](devices-esp32.md#the-panel-is-29-mm-wide-so-size-for-a-fingertip-not-for-pixels).
The units still run the `0716006` demo images until they are reflashed, so this change has not been
seen on the glass yet.

## What still needs observation

- Physically label each unit and assign CP-01 through CP-03 and ESP-01 through ESP-03.
- Read the product and revision label on every unit. Confirm each Cardputer is K132-ADV and record
  each Waveshare board as V1 or V2.
- Map each stable USB path to a labelled unit. Do not infer the model from `303a:1001`.
- Record the firmware and intended onsite role for each unit.
- Check battery presence and charging on each ESP32 display, then record the battery capacity from
  its own markings. Do not infer capacity from the optional battery shown on the product page.
- Observe a boot and basic input on every unit: display and keyboard on Cardputers, and display and
  touch on Waveshare boards. Record failures rather than treating a successful build as a hardware
  test.

## Public demo identity

The public API resolved `ryanryanryanryan` to
`0x1da1a0e5f6a72b24c9ebd331cd265b7e0e140db3` on 2026-09-21. Resolution supplies one canonical
address, not the complete linked-wallet list. Use it as one configured wallet until more public
addresses are explicitly supplied or resolved by a supported API.

The read-only API check used the official SDK and a key supplied directly by 1Password. Trending
returned 401 with `cf-cache-status: BYPASS` without a key, then 200 with `MISS` using the key.
Username resolution and that address's portfolio also returned 200 with `MISS`. Unique query
parameters bypassed warmed responses. This proves those public reads from the development machine;
it does not prove handheld Wi-Fi, TLS, or provisioning. No credential belongs in this inventory.

On 2026-09-22, the exact owner-selected demo key also passed a separate SDK probe: the unauthenticated
request returned 401 with `BYPASS`, and the keyed request returned 200 with `MISS`. Both requests used
unique query parameters. This verified the key used for the two private firmware builds.
