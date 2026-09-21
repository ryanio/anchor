# Independent device apps

The onsite target is three Cardputer ADVs and three Waveshare AMOLED displays that people can pick
up, browse, play together, customize, and reflash. The [hardware inventory](device-hardware.md)
records the actual fleet and the observations still needed. This document describes planned work;
the changelog records what has shipped.

Every app runs on the device. Wi-Fi provides normal internet access. An optional USB network helper
may use a development computer's internet connection while the device keeps its own app state and
rendering. Charging or unplugging a cable must not change which apps are available.

## Platform boundaries

| Project | Owns |
|---|---|
| [Flint](https://github.com/ryanio/cardputer) | Cardputer hardware, app lifecycle, keyboard, settings, background requests, rendering, simulator |
| Proposed ESP32 platform | Waveshare drivers, LVGL shell, touch, battery and power, settings, background requests, simulator |
| Anchor | OpenSea models, parsers, app logic, themes, game rules, and presentations for each device |

Prove the ESP32 boundary inside this tree before extracting a public platform repository. Preserve
the working hardware drivers and their measured constraints during that move. Anchor pins platform
commits; each platform must build a useful example without Anchor.

Share data and behavior across devices. Keep Flint's renderer and LVGL, with layouts suited to their
different screens and inputs. Apps are compiled into an app pack for this first version.

## Build order

1. Make setup reproducible on macOS and Linux. Pin dependencies, isolate tool state per checkout,
   compile both actual firmware targets in CI, and establish recovery builds. Record each physical
   unit's identity before flashing it.
2. Introduce bounded background requests, cancellation on app exit, and request generations that
   prevent an old response from filling a new screen. Input and exit actions must remain responsive
   through a network timeout.
3. Complete Wi-Fi settings and saved-network switching. Distinguish association from working
   internet access. Test all six units on the intended iPhone hotspot and keep cached readings
   visibly dated when offline.
4. Share OpenSea identifiers, parsing, decimal arithmetic, freshness, pagination, and coverage.
   Token identity includes chain and address. A portfolio reports every configured wallet and the
   coverage of each metric. Verify public API support for external profiles before promising an app.
5. Standardize theme roles, navigation, rows, metrics, asset previews, input, and failure states.
   Review each component at both device sizes and on the physical screens.
6. Build Explorer and Portfolio first. Add a mixed-device Party game, then Gallery. External-profile
   discovery follows the availability of a supported public data contract.

Prototype ESP-NOW multiplayer during the first two stages. Peers must agree on a radio channel;
Party mode can pause internet requests and use one dated dataset. A participant hosts the room,
with explicit joins, versioned messages, ordered rounds, acknowledgments, and disconnect handling.
See [Espressif's channel and delivery constraints](https://docs.espressif.com/projects/esp-idf/en/stable/esp32s3/api-reference/network/esp_now.html).

## Onsite acceptance

- All six units boot and work with the development computer off.
- Setup, saved-network changes, and recovery are documented and exercised.
- Slow requests, rate limits, missing data, and disconnects leave navigation usable.
- Both devices show the same values and coverage from the same fixture.
- A mixed-device game survives a player leaving and rejoining.
- An hour of browsing and play produces no crashes or sustained memory loss. Record battery runtime
  on the actual units and run an overnight soak when time permits.
- A contributor can clone, simulate, change an example, build, and flash from the published guide.

The simulators check layout and logic. Panel addressing, touch behavior, radio coexistence, charging,
and battery runtime require physical observations. Record those results beside the driver docs.
