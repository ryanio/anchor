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
