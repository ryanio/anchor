#!/usr/bin/env bash
#
# Build the firmware for this desktop and run one scenario against it.
#
#   sim/run.sh --taps "184,120 300,300" --shot /tmp/pulse --quit-after 12000
#
# Everything after the script name goes to the binary; `--help` lists it. Frames are written as PPM
# by the binary itself — no library, three lines of header — and converted to PNG here when
# `magick` is on the PATH, because a PNG is what anybody actually opens.
#
# The build is a plain compiler invocation rather than PlatformIO or arduino-cli. Both of those are
# in this tree already and neither is the right tool for a host build: `platformio.ini` describes an
# ESP32-S3 and `arduino-cli` compiles a sketch directory for a board. Six translation units and one
# link do not need either, and a harness nobody can run because a toolchain is missing is a harness
# nobody runs.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
firmware="$(dirname "$here")"
build="$here/build"
binary="$build/pulse-sim"

# The font comes out of the installed GFX library rather than a copy in this tree; see the note in
# `src/gfx_sim.cpp`. Every path Arduino puts a library in, plus an override for anyone whose is
# somewhere else.
font=""
for candidate in \
	"${ANCHOR_GFX_DIR:-}/font/glcdfont.h" \
	"$HOME/Arduino/libraries/GFX_Library_for_Arduino/src/font/glcdfont.h" \
	"$HOME/.arduino15/libraries/GFX_Library_for_Arduino/src/font/glcdfont.h" \
	"/usr/share/arduino/libraries/GFX_Library_for_Arduino/src/font/glcdfont.h"; do
	if [ -f "$candidate" ]; then
		font="$candidate"
		break
	fi
done
if [ -z "$font" ]; then
	echo "sim: cannot find GFX_Library_for_Arduino's glcdfont.h." >&2
	echo "     It is the same library the firmware build needs:" >&2
	echo "       arduino-cli lib install \"GFX Library for Arduino\"" >&2
	echo "     Or set ANCHOR_GFX_DIR to the library's src/ directory." >&2
	exit 1
fi

mkdir -p "$build"

# Rebuild when anything it is built from is newer than the binary. `find -newer` over the firmware
# and the shims is cheaper than a build system and honest about what the inputs are.
needs_build=1
if [ -x "$binary" ]; then
	newer="$(find "$here/src" "$here/include" "$firmware/app" "$firmware/src" -type f -newer "$binary" -print -quit 2>/dev/null || true)"
	if [ -z "$newer" ]; then needs_build=0; fi
fi

if [ "$needs_build" = "1" ]; then
	# -Werror on the firmware's own sources, for the reason `esp32-firmware.test.ts` gives: this is
	# the only place they are compiled at all without a board attached, so a warning here is a
	# warning nobody else is going to see. The shims are held to the same bar.
	warn=(-Wall -Wextra -Werror)
	cc -std=c99 "${warn[@]}" -O2 -I"$firmware/src" \
		-c "$firmware/src/anchor_pulse.c" -o "$build/anchor_pulse.o"
	c++ -std=c++17 "${warn[@]}" -O2 \
		-I"$here/include" -I"$firmware/src" -I"$firmware/app" \
		-DANCHOR_SIM_FONT_HEADER="\"$font\"" \
		-o "$binary" \
		"$here/src/main.cpp" \
		"$here/src/shim.cpp" \
		"$here/src/gfx_sim.cpp" \
		"$here/src/wifi_sim.cpp" \
		"$here/src/prefs_sim.cpp" \
		"$here/src/sensors_sim.cpp" \
		"$here/src/app_ino.cpp" \
		"$firmware/app/wifi_setup.cpp" \
		"$build/anchor_pulse.o"
fi

# A fresh unit unless the scenario says otherwise: NVS is a file, and one left over from the last
# run is a device that was already provisioned, which silently skips the whole first-boot path.
nvs="$build/sim-nvs-pulse.txt"
seen_nvs=0
shot=""
for ((i = 1; i <= $#; i++)); do
	case "${!i}" in
	--nvs) seen_nvs=1 ;;
	--shot)
		j=$((i + 1))
		shot="${!j:-}"
		;;
	esac
done
args=("$@")
if [ "$seen_nvs" = "0" ]; then
	rm -f "$nvs"
	args=(--nvs "$nvs" "$@")
fi

"$binary" "${args[@]}"

if [ -n "$shot" ] && command -v magick >/dev/null 2>&1; then
	for ppm in "$shot"-*.ppm; do
		[ -e "$ppm" ] || continue
		magick "$ppm" "${ppm%.ppm}.png"
	done
	echo "sim: converted $(ls "$shot"-*.png 2>/dev/null | wc -l) frames to PNG"
fi
