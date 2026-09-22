#!/usr/bin/env bash
#
# Build the LVGL firmware for this desktop and photograph its screen. No board, no cable, no flash.
#
#   sim/lvgl.sh --shot /tmp/pulse --quit-after 4000
#   sim/lvgl.sh --taps "184,120 300,300" --shot /tmp/pulse
#
# Everything after the script name goes to the binary; `--help` lists it. Frames are written as PPM
# by the binary itself — three lines of header, no library — and converted to PNG here when `magick`
# is on the PATH, because a PNG is what anybody actually opens.
#
# This is `run.sh` pointed at the other firmware, and it is separate rather than a flag on that
# script for one reason: the two firmwares are two binaries with two `setup()`s and two `loop()`s, and
# a single build that linked both would need one of them renamed. `run.sh` stays exactly as it was,
# so the blitter's harness — and `wifi_setup.test.ts`, which drives it — cannot be broken by work on
# this one.
#
# The build is a plain compiler invocation, for the reason `run.sh` gives: `platformio.ini` describes
# an ESP32-S3 and `arduino-cli` compiles a sketch for a board. The one addition here is that LVGL is
# ~700 C files, so it is compiled once into an archive and cached — the firmware itself is six
# translation units and rebuilds in a second, which is the loop that has to stay fast.
set -euo pipefail

# How many jobs to compile LVGL with. `nproc` is GNU and absent on macOS, where the same question is
# `sysctl -n hw.ncpu`; this repo's firmware is developed on both. Falls back to 4 rather than failing,
# because a wrong core count is a slower build and a missing one is no build at all.
cpu_count() {
	if command -v nproc >/dev/null 2>&1; then
		nproc
	elif command -v sysctl >/dev/null 2>&1; then
		sysctl -n hw.ncpu 2>/dev/null || echo 4
	else
		echo 4
	fi
}

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
firmware="$(dirname "$here")"
sketch="$firmware/pulse"
build="$here/build"
lvgl_objects="$build/lvgl-objects"
lvgl_archive="$build/liblvgl.a"
binary="$build/pulse-lvgl-sim"

# The GFX font, for the same reason `run.sh` needs it: `gfx_sim.cpp` is shared between the two
# harnesses and transcribes the library's own glyph table rather than copying it. Nothing LVGL draws
# goes through it — LVGL has its own fonts — but the file will not compile without the macro.
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

# LVGL itself, from wherever Arduino put it — the same installed copy `arduino-cli` compiles the
# firmware against, never a vendored one. A second copy in this tree would be a second answer to
# "what is this screen built on", which is the mistake `docs/devices-esp32.md` spends a section
# refusing to make about renderers.
lvgl=""
for candidate in \
	"${ANCHOR_LVGL_DIR:-}" \
	"$HOME/Arduino/libraries/lvgl" \
	"$HOME/.arduino15/libraries/lvgl" \
	"/usr/share/arduino/libraries/lvgl"; do
	if [ -n "$candidate" ] && [ -f "$candidate/lvgl.h" ]; then
		lvgl="$candidate"
		break
	fi
done
if [ -z "$lvgl" ]; then
	echo "sim: cannot find LVGL." >&2
	echo "       arduino-cli lib install lvgl@9.2.2" >&2
	echo "     Or set ANCHOR_LVGL_DIR to the library root (the directory holding lvgl.h)." >&2
	exit 1
fi

mkdir -p "$build"

# `-I "$sketch"` is what makes LVGL find `pulse/lv_conf.h` here, by exactly the mechanism the board
# build uses: `lv_conf_internal.h` tests `__has_include("lv_conf.h")` and the sketch directory is on
# the include path. Same file, same defines, same fonts on both targets — which is the only reason a
# screenshot from this harness says anything about the board.
includes=(-DANCHOR_SIMULATOR=1 -I"$here/include" -I"$sketch" -I"$lvgl")

# LVGL is somebody else's code and is compiled without `-Werror` and without `-Wall`: a warning in it
# is not a warning anyone here is going to act on, and treating it as an error would mean this
# harness stops working on an LVGL upgrade for a reason that has nothing to do with Anchor. The
# firmware's own sources below are held to the opposite standard.
rebuild_lvgl=0
if [ ! -f "$lvgl_archive" ]; then
	rebuild_lvgl=1
elif [ "$sketch/lv_conf.h" -nt "$lvgl_archive" ]; then
	# The configuration is compiled *into* every LVGL translation unit, so a changed `lv_conf.h` is a
	# changed library. Not noticing that is a stale archive with the old fonts in it and a screenshot
	# that answers a question nobody asked.
	rebuild_lvgl=1
elif [ -n "$(find "$lvgl/src" "$lvgl/lvgl.h" -newer "$lvgl_archive" -print -quit 2>/dev/null || true)" ]; then
	rebuild_lvgl=1
fi

if [ "$rebuild_lvgl" = "1" ]; then
	echo "sim: building LVGL from $lvgl (once; cached in $lvgl_archive)"
	rm -rf "$lvgl_objects"
	mkdir -p "$lvgl_objects"
	export LVGL_ROOT="$lvgl" LVGL_OBJECTS="$lvgl_objects" LVGL_INCLUDES="${includes[*]}"
	find "$lvgl/src" -name '*.c' -print0 |
		xargs -0 -P "$(cpu_count)" -I{} bash -c '
			src="$1"
			rel="${src#"$LVGL_ROOT"/src/}"
			obj="$LVGL_OBJECTS/${rel%.c}.o"
			mkdir -p "$(dirname "$obj")"
			# shellcheck disable=SC2086
			cc -std=c99 -O2 -w $LVGL_INCLUDES -c "$src" -o "$obj"
		' _ {}
	find "$lvgl_objects" -name '*.o' -print0 | xargs -0 ar rcs "$lvgl_archive"
fi

# Rebuild the firmware whenever anything it is built from is newer than the binary. `find -newer`
# over the sketch and the shims is cheaper than a build system and honest about what the inputs are.
needs_build=1
if [ -x "$binary" ]; then
	newer="$(find "$here/src" "$here/include" "$sketch" "$firmware/app" "$firmware/../common" -type f -newer "$binary" -print -quit 2>/dev/null || true)"
	if [ -z "$newer" ] && [ ! "$lvgl_archive" -nt "$binary" ] && [ ! "${BASH_SOURCE[0]}" -nt "$binary" ]; then needs_build=0; fi
fi

if [ "$needs_build" = "1" ]; then
	# `-Werror` on the firmware's own sources, for the reason `run.sh` gives: this is the only place
	# they are compiled at all without a board attached, so a warning here is a warning nobody else is
	# going to see. The shims are held to the same bar.
	c++ -std=c++17 -Wall -Wextra -Werror -O2 \
		"${includes[@]}" \
		-DANCHOR_SIM_FONT_HEADER="\"$font\"" \
		-o "$binary" \
		"$here/src/lvgl_main.cpp" \
		"$here/src/shim.cpp" \
		"$here/src/gfx_sim.cpp" \
		"$here/src/wifi_sim.cpp" \
		"$here/src/prefs_sim.cpp" \
		"$here/src/pulse_ino.cpp" \
		"$here/src/pulse_touch_sim.cpp" \
		"$here/src/feed_sim.cpp" \
		"$sketch/pulse_design.cpp" \
		"$sketch/pulse_feed_view.cpp" \
		"$sketch/pulse_explore.cpp" \
		"$sketch/pulse_power.cpp" \
		"$sketch/pulse_ui.cpp" \
		"$sketch/pulse_wifi.cpp" \
		"$lvgl_archive" \
		-lm
fi

shot=""
for ((i = 1; i <= $#; i++)); do
	case "${!i}" in
	--shot)
		j=$((i + 1))
		shot="${!j:-}"
		;;
	esac
done

# A fresh unit unless the scenario says otherwise, exactly as `run.sh` does it. NVS here is a file,
# and one left over from the last run is a device that was already provisioned — which silently skips
# the first-boot path, including the one screen that opens by itself.
nvs="$build/sim-nvs-pulse-lvgl.txt"
seen_nvs=0
for ((i = 1; i <= $#; i++)); do
	case "${!i}" in
	--nvs) seen_nvs=1 ;;
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
