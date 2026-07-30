#!/usr/bin/env python3
# uinput-pad.py — a virtual gamepad for the native RetroArch addon.
#
# retroarch-bridge.js spawns this and writes one JSON object per line to our
# stdin; we translate each into a Linux evdev event on a /dev/uinput device.
# RetroArch's `udev` joypad driver enumerates that device and binds it to a
# RetroPad via the shipped autoconfig (conf/retroarch/autoconfig/mytesla-pad.cfg),
# which matches our name + VID/PID. The browser's on-screen overlay drives this
# over the /retroarch/input WebSocket; a Bluetooth pad paired to the Pi is read
# by the same udev driver directly, no code here.
#
# Line protocol (one compact JSON object per line):
#   {"btn":"a","action":"down"}   {"btn":"a","action":"up"}
#   btn ∈ a b x y l r l2 r2 l3 r3 select start menu          (face/shoulder/etc)
#   btn ∈ up down left right                                  (d-pad → ABS_HAT0)
#   action ∈ down | up
# Anything else is ignored (defensive — the WS is allowlisted on the JS side too).
#
# Needs /dev/uinput writable by group `input` (99-mytesla-uinput.rules) — the
# service user is already in that group.

import sys
import json
import evdev
from evdev import UInput, ecodes as e

# Stable identity the autoconfig matches on. 0x1d6b = "Linux Foundation"
# (a safe, non-colliding vendor); product/name are ours.
VENDOR = 0x1d6b
PRODUCT = 0x1337
NAME = "mytesla-virtual-pad"

# Overlay/RetroPad button name → evdev key code. Note the RetroArch convention:
# RetroPad "B" is the SOUTH button (confirm) and "A" is EAST — we expose the
# overlay's a/b as RetroPad A/B to match the autoconfig.
BTN = {
    "b": e.BTN_SOUTH, "a": e.BTN_EAST, "x": e.BTN_NORTH, "y": e.BTN_WEST,
    "l": e.BTN_TL, "r": e.BTN_TR, "l2": e.BTN_TL2, "r2": e.BTN_TR2,
    "l3": e.BTN_THUMBL, "r3": e.BTN_THUMBR,
    "select": e.BTN_SELECT, "start": e.BTN_START, "menu": e.BTN_MODE,
}
# D-pad as a hat axis (what most autoconfigs, incl. ours, expect via h0*).
HAT = {
    "up": (e.ABS_HAT0Y, -1), "down": (e.ABS_HAT0Y, 1),
    "left": (e.ABS_HAT0X, -1), "right": (e.ABS_HAT0X, 1),
}

CAPS = {
    e.EV_KEY: list(BTN.values()),
    e.EV_ABS: [
        (e.ABS_HAT0X, evdev.AbsInfo(value=0, min=-1, max=1, fuzz=0, flat=0, resolution=0)),
        (e.ABS_HAT0Y, evdev.AbsInfo(value=0, min=-1, max=1, fuzz=0, flat=0, resolution=0)),
    ],
}


def main():
    ui = UInput(CAPS, name=NAME, vendor=VENDOR, product=PRODUCT, version=1)
    # The bridge waits for this line before it trusts the pad is live.
    sys.stderr.write("PAD_READY %s\n" % (ui.device.path if ui.device else "?"))
    sys.stderr.flush()
    try:
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                m = json.loads(line)
            except ValueError:
                continue
            btn = m.get("btn")
            down = m.get("action") == "down"
            if btn in BTN:
                ui.write(e.EV_KEY, BTN[btn], 1 if down else 0)
                ui.syn()
            elif btn in HAT:
                ax, val = HAT[btn]
                # On release we recentre the axis; holding up then down is not a
                # real d-pad gesture, so last-writer-wins is fine.
                ui.write(e.EV_ABS, ax, val if down else 0)
                ui.syn()
    except (KeyboardInterrupt, BrokenPipeError):
        pass
    finally:
        try:
            ui.close()
        except Exception:
            pass


if __name__ == "__main__":
    main()
