#!/usr/bin/env python3
"""Helpers for scripts/bt-probe.sh — the Bluetooth feasibility probe.

Three jobs the shell can't do cleanly on a stock DietPi:

  sco-route  Send the Broadcom vendor HCI command that routes SCO (voice) packets
             over the HCI transport instead of the chip's PCM/I2S pins. Without
             it the Pi's onboard controller will happily *establish* a SCO link
             and then deliver digital silence, because the audio is being shipped
             out a hardware bus nothing is listening to. Raspberry Pi OS ships
             this in pi-bluetooth's `bthelper`; DietPi generally does not, and it
             is lost on every adapter reset either way.

             Done here rather than via `hcitool cmd` because hcitool is
             deprecated and increasingly absent, and because we want the
             Command Complete status rather than fire-and-forget.

  tone       Generate the WAV files the probe plays. Written by hand instead of
             shelling out to sox/ffmpeg so the probe has no dependency beyond
             alsa-utils, and so the A2DP file can prove *stereo* routing
             (left-only then right-only segments) rather than merely "sound".

  level      Measure a recorded WAV. The interesting failure is not "arecord
             errored" but "arecord succeeded and returned silence" — that is the
             signature of SCO-over-HCI not being routed, and eyeballing a
             waveform over SSH is not an option.

`selftest` exercises the pure logic (packet bytes, WAV round-trip, dBFS maths)
with no Bluetooth adapter present, so the parts that can be verified off the
car are verified off the car.
"""

import argparse
import math
import re
import os
import struct
import sys
import wave

# ── HCI ─────────────────────────────────────────────────────────────────────

HCI_COMMAND_PKT = 0x01
HCI_EVENT_PKT = 0x04
EVT_CMD_COMPLETE = 0x0E
EVT_CMD_STATUS = 0x0F

SOL_HCI = 0
HCI_FILTER = 2

# Broadcom vendor commands. OGF 0x3f (vendor) + OCF 0x1c/0x1d, so opcode
# (0x3f << 10) | ocf.
OCF_WRITE_SCO_PCM_INT = 0x1C
OCF_READ_SCO_PCM_INT = 0x1D
OGF_VENDOR = 0x3F

# sco_routing=1 (HCI), pcm_interface_rate=2, frame_type=0, sync_mode=1,
# clock_mode=1 — byte for byte what pi-bluetooth's bthelper sends to onboard,
# UART-attached Broadcom parts.
SCO_ROUTE_HCI_PARAMS = bytes([0x01, 0x02, 0x00, 0x01, 0x01])


def opcode(ogf, ocf):
    return (ogf << 10) | ocf


def hci_cmd_packet(op, params=b""):
    """One HCI command as it goes onto a raw HCI socket."""
    if len(params) > 255:
        raise ValueError("HCI command parameters cannot exceed 255 bytes")
    return struct.pack("<BHB", HCI_COMMAND_PKT, op, len(params)) + params


def parse_cmd_complete(pkt):
    """Return (opcode, status, payload) from a Command Complete event, else None.

    `pkt` is a whole packet off the socket, including the leading packet-type
    byte. Anything that isn't a Command Complete — including Command Status,
    which some controllers answer with instead — returns None so the caller can
    keep reading rather than mistaking it for a result.
    """
    if len(pkt) < 6 or pkt[0] != HCI_EVENT_PKT or pkt[1] != EVT_CMD_COMPLETE:
        return None
    plen = pkt[2]
    body = pkt[3:3 + plen]
    if len(body) < 4:
        return None
    op = struct.unpack("<H", body[1:3])[0]
    return op, body[3], body[4:]


# Status codes we can actually hit here; anything else is reported numerically.
HCI_STATUS = {
    0x00: "success",
    0x01: "unknown HCI command — this controller does not implement the "
          "Broadcom SCO-routing vendor command",
    0x0C: "command disallowed in the current state",
    0x11: "unsupported feature or parameter value",
    0x12: "invalid HCI command parameters",
}


def hci_send(dev_id, op, params, timeout):
    """Send one command on a raw HCI socket and wait for its Command Complete."""
    import socket  # local: this module must import on machines with no AF_BLUETOOTH

    if not hasattr(socket, "AF_BLUETOOTH"):
        raise RuntimeError("this Python has no AF_BLUETOOTH support (not Linux?)")

    sock = socket.socket(socket.AF_BLUETOOTH, socket.SOCK_RAW, socket.BTPROTO_HCI)
    try:
        # Ask the kernel for event packets, and within those for Command
        # Complete/Status only. Without a filter the socket delivers nothing.
        type_mask = 1 << HCI_EVENT_PKT
        event_mask0 = (1 << EVT_CMD_COMPLETE) | (1 << EVT_CMD_STATUS)
        sock.setsockopt(SOL_HCI, HCI_FILTER,
                        struct.pack("<IIIH2x", type_mask, event_mask0, 0, 0))
        try:
            sock.bind((dev_id,))
        except (TypeError, OSError):
            # Older/newer CPython disagree on whether the channel is part of the
            # address. 0 is HCI_CHANNEL_RAW, which is what we want either way.
            sock.bind((dev_id, 0))
        sock.settimeout(timeout)
        sock.send(hci_cmd_packet(op, params))
        deadline = timeout
        while deadline > 0:
            pkt = sock.recv(260)
            parsed = parse_cmd_complete(pkt)
            if parsed and parsed[0] == op:
                return parsed
            deadline -= 0.1
        raise TimeoutError("no Command Complete for opcode 0x%04X" % op)
    finally:
        sock.close()


def cmd_sco_route(args):
    dev_id = int(args.dev.replace("hci", "")) if args.dev.startswith("hci") else int(args.dev)
    write_op = opcode(OGF_VENDOR, OCF_WRITE_SCO_PCM_INT)

    if args.read_only:
        params = b""
        op = opcode(OGF_VENDOR, OCF_READ_SCO_PCM_INT)
    else:
        params = SCO_ROUTE_HCI_PARAMS
        op = write_op

    try:
        got_op, status, payload = hci_send(dev_id, op, params, args.timeout)
    except PermissionError:
        print("sco-route: FAIL permission denied — needs root (raw HCI socket)")
        return 2
    except Exception as exc:  # noqa: BLE001 — the whole point is to report it
        print("sco-route: FAIL %s: %s" % (type(exc).__name__, exc))
        return 2

    label = HCI_STATUS.get(status, "status 0x%02X" % status)
    if status != 0x00:
        print("sco-route: FAIL 0x%04X -> %s" % (got_op, label))
        return 1
    print("sco-route: OK 0x%04X -> %s%s"
          % (got_op, label, (" params=" + payload.hex()) if payload else ""))

    if args.read_only or not args.verify:
        return 0

    # Read back. Purely informational: plenty of Broadcom builds implement the
    # write and not the read, so a failure here is not a failure of the routing.
    try:
        _, rstatus, rpayload = hci_send(dev_id, opcode(OGF_VENDOR, OCF_READ_SCO_PCM_INT),
                                        b"", args.timeout)
        if rstatus == 0x00:
            routed = rpayload[0] if rpayload else None
            print("sco-route: readback params=%s (sco_routing=%s%s)"
                  % (rpayload.hex(), routed,
                     ", HCI" if routed == 1 else ", NOT HCI" if routed is not None else ""))
        else:
            print("sco-route: readback unsupported (%s) — not a problem"
                  % HCI_STATUS.get(rstatus, "status 0x%02X" % rstatus))
    except Exception as exc:  # noqa: BLE001
        print("sco-route: readback unavailable (%s) — not a problem" % exc)
    return 0


# ── Tone generation ─────────────────────────────────────────────────────────

def _seg(rate, seconds, freq, channels, side=None):
    """One segment of int16 frames. `side` of 'l'/'r' silences the other channel.

    Both ends are ramped over 8 ms. Without that, a segment boundary is a step
    discontinuity, which a car stereo reproduces as a click loud enough to be
    mistaken for the test signal itself.
    """
    n = int(rate * seconds)
    ramp = max(1, int(rate * 0.008))
    out = bytearray()
    for i in range(n):
        if freq <= 0:
            sample = 0.0
        else:
            sample = math.sin(2.0 * math.pi * freq * (i / rate))
            if i < ramp:
                sample *= i / ramp
            elif i > n - ramp:
                sample *= max(0.0, (n - i) / ramp)
        v = int(sample * 0.5 * 32767)  # -6 dBFS: audible, no clipping headroom games
        if channels == 1:
            out += struct.pack("<h", v)
        else:
            left = v if side in (None, "l") else 0
            right = v if side in (None, "r") else 0
            out += struct.pack("<hh", left, right)
    return bytes(out)


def tone_a2dp(rate=44100):
    """Music-band test: both → left only → right only → both.

    The channel-isolated segments matter: a mono-summing bug or a half-connected
    stream is otherwise indistinguishable from success.
    """
    return b"".join([
        _seg(rate, 0.4, 0, 2),
        _seg(rate, 1.0, 440, 2),
        _seg(rate, 0.2, 0, 2),
        _seg(rate, 1.0, 880, 2, side="l"),
        _seg(rate, 0.2, 0, 2),
        _seg(rate, 1.0, 880, 2, side="r"),
        _seg(rate, 0.2, 0, 2),
        _seg(rate, 1.0, 440, 2),
    ])


def tone_sco(rate=16000):
    """Voice-band warble. A steady tone is easy to confuse with a fault noise;
    an alternating pair is unmistakably ours, and both frequencies survive the
    8 kHz narrowband case."""
    parts = []
    for _ in range(4):
        parts.append(_seg(rate, 0.35, 800, 1))
        parts.append(_seg(rate, 0.35, 1200, 1))
    return b"".join(parts)


def write_wav(path, frames, rate, channels):
    with wave.open(path, "wb") as w:
        w.setnchannels(channels)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(frames)


def cmd_tone(args):
    if args.profile == "a2dp":
        rate = args.rate or 44100
        write_wav(args.out, tone_a2dp(rate), rate, 2)
        print("tone: wrote %s (%d Hz stereo, both/left/right/both)" % (args.out, rate))
    else:
        rate = args.rate or 16000
        write_wav(args.out, tone_sco(rate), rate, 1)
        print("tone: wrote %s (%d Hz mono warble)" % (args.out, rate))
    return 0


# ── Level analysis ──────────────────────────────────────────────────────────

def analyse(path):
    with wave.open(path, "rb") as w:
        channels, width, rate, nframes = w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()
        raw = w.readframes(nframes)
    if width != 2:
        raise ValueError("expected 16-bit PCM, got %d-bit" % (width * 8))
    count = len(raw) // 2
    if count == 0:
        return dict(rate=rate, channels=channels, seconds=0.0, frames=0,
                    peak_dbfs=None, rms_dbfs=None, zero_fraction=1.0)
    samples = struct.unpack("<%dh" % count, raw[:count * 2])
    peak = max(abs(s) for s in samples)
    total = 0
    zeros = 0
    for s in samples:
        total += s * s
        if s == 0:
            zeros += 1
    rms = math.sqrt(total / count)
    dbfs = lambda v: (20.0 * math.log10(v / 32768.0)) if v > 0 else None
    return dict(rate=rate, channels=channels, frames=nframes,
                seconds=round(nframes / rate, 2) if rate else 0.0,
                peak_dbfs=None if dbfs(peak) is None else round(dbfs(peak), 1),
                rms_dbfs=None if dbfs(rms) is None else round(dbfs(rms), 1),
                zero_fraction=round(zeros / count, 4))


def verdict(stats):
    """Turn the numbers into the answer we actually care about.

    The thresholds are deliberately generous. A cabin mic picking up a person
    talking a metre away lands well above -50 dBFS RMS; a SCO link that
    connected but is delivering nothing lands at digital zero, not at -70. The
    band between them is reported as inconclusive rather than guessed at.
    """
    if stats["frames"] == 0:
        return "EMPTY", "no audio captured at all"
    if stats["rms_dbfs"] is None or stats["zero_fraction"] > 0.99:
        return "SILENT", ("digital silence — the SCO link carried no audio. "
                          "Classic signature of SCO not being routed over HCI")
    if stats["rms_dbfs"] < -60:
        return "SILENT", "essentially silent (RMS %.1f dBFS)" % stats["rms_dbfs"]
    if stats["rms_dbfs"] < -45:
        return "FAINT", ("something is there but very quiet (RMS %.1f dBFS) — "
                         "could be room noise rather than speech" % stats["rms_dbfs"])
    return "AUDIO", "real audio captured (RMS %.1f dBFS)" % stats["rms_dbfs"]


def cmd_level(args):
    try:
        stats = analyse(args.file)
    except Exception as exc:  # noqa: BLE001
        print("level: FAIL %s: %s" % (type(exc).__name__, exc))
        return 2
    tag, why = verdict(stats)
    print("level: %s — %s" % (tag, why))
    print("level: %.2fs %d Hz %dch peak=%s dBFS rms=%s dBFS zeros=%.1f%%"
          % (stats["seconds"], stats["rate"], stats["channels"],
             stats["peak_dbfs"], stats["rms_dbfs"], stats["zero_fraction"] * 100))
    return 0 if tag == "AUDIO" else 1


# ── BlueZ device class ──────────────────────────────────────────────────────

def set_class(text, value):
    """Return main.conf text with [General] Class set to `value`, plus a note.

    BlueZ derives the *service* bits of the class of device from the profiles
    actually registered, but the major/minor bits come from this setting, and
    its default is "Computer". A car scanning for a phone has no reason to offer
    phone profiles to a computer, so this is a plausible reason for the Pi to
    pair and then do nothing useful.

    Handled here rather than with sed because BlueZ ships the line commented out
    (`#Class = 0x000100`), which a naive substitution edits into a still-inert
    comment, and because in-place sed differs between GNU and BSD.
    """
    lines = text.splitlines()
    out = []
    replaced = False
    for line in lines:
        if not replaced and re.match(r"^\s*Class\s*=", line):
            out.append("Class = %s" % value)
            replaced = True
        else:
            out.append(line)
    if replaced:
        return "\n".join(out) + "\n", "replaced existing Class line"

    for i, line in enumerate(out):
        if line.strip() == "[General]":
            out.insert(i + 1, "Class = %s" % value)
            return "\n".join(out) + "\n", "inserted under [General]"

    out += ["", "[General]", "Class = %s" % value]
    return "\n".join(out) + "\n", "appended a [General] section"


def cmd_set_class(args):
    try:
        with open(args.file, "r") as fh:
            text = fh.read()
    except FileNotFoundError:
        print("set-class: FAIL %s does not exist" % args.file)
        return 2
    new, how = set_class(text, getattr(args, "class"))
    if new == text:
        print("set-class: already %s in %s" % (getattr(args, "class"), args.file))
        return 0
    with open(args.file, "w") as fh:
        fh.write(new)
    print("set-class: %s -> Class = %s (%s)" % (args.file, getattr(args, "class"), how))
    return 0


# ── Self test ───────────────────────────────────────────────────────────────

def cmd_selftest(_args):
    import tempfile

    failures = []

    def check(name, got, want):
        if got != want:
            failures.append("%s: got %r, want %r" % (name, got, want))

    # The wire bytes are the whole point of the sco-route command; if these
    # drift the probe silently reconfigures something else on the chip.
    check("opcode", "0x%04X" % opcode(OGF_VENDOR, OCF_WRITE_SCO_PCM_INT), "0xFC1C")
    check("read opcode", "0x%04X" % opcode(OGF_VENDOR, OCF_READ_SCO_PCM_INT), "0xFC1D")
    check("cmd packet",
          hci_cmd_packet(opcode(OGF_VENDOR, OCF_WRITE_SCO_PCM_INT), SCO_ROUTE_HCI_PARAMS).hex(),
          "011cfc050102000101")
    check("empty packet", hci_cmd_packet(0xFC1D).hex(), "011dfc00")

    # Command Complete for 0xFC1C, status 0.
    ok_evt = bytes([HCI_EVENT_PKT, EVT_CMD_COMPLETE, 0x04, 0x01, 0x1C, 0xFC, 0x00])
    check("parse ok", parse_cmd_complete(ok_evt), (0xFC1C, 0x00, b""))
    bad_evt = bytes([HCI_EVENT_PKT, EVT_CMD_COMPLETE, 0x04, 0x01, 0x1C, 0xFC, 0x01])
    check("parse status", parse_cmd_complete(bad_evt)[1], 0x01)
    check("parse non-cc", parse_cmd_complete(bytes([HCI_EVENT_PKT, EVT_CMD_STATUS, 0x04, 0, 0, 0, 0])), None)
    check("parse short", parse_cmd_complete(b"\x04\x0e"), None)

    tmp = tempfile.mkdtemp(prefix="bt-probe-selftest-")
    try:
        # A2DP tone: stereo, right length, and genuinely channel-separated.
        a2dp = os.path.join(tmp, "a2dp.wav")
        write_wav(a2dp, tone_a2dp(44100), 44100, 2)
        st = analyse(a2dp)
        check("a2dp rate", st["rate"], 44100)
        check("a2dp channels", st["channels"], 2)
        check("a2dp length", round(st["seconds"]), 5)
        if not (-12 < st["peak_dbfs"] < -3):
            failures.append("a2dp peak out of range: %s dBFS" % st["peak_dbfs"])

        with wave.open(a2dp, "rb") as w:
            w.setpos(int(44100 * 2.0))          # inside the left-only segment
            frame = struct.unpack("<%dh" % (2 * 4410), w.readframes(4410))
        if max(abs(v) for v in frame[1::2]) != 0:
            failures.append("a2dp left-only segment has content in the right channel")
        if max(abs(v) for v in frame[0::2]) == 0:
            failures.append("a2dp left-only segment is silent in the left channel")

        sco = os.path.join(tmp, "sco.wav")
        write_wav(sco, tone_sco(8000), 8000, 1)
        st = analyse(sco)
        check("sco rate", st["rate"], 8000)
        check("sco channels", st["channels"], 1)
        check("sco verdict", verdict(st)[0], "AUDIO")

        # Silence must read as SILENT, not as faint audio — this is the call the
        # whole SCO test hangs on.
        quiet = os.path.join(tmp, "quiet.wav")
        write_wav(quiet, b"\x00\x00" * 8000, 8000, 1)
        check("silence verdict", verdict(analyse(quiet))[0], "SILENT")

        empty = os.path.join(tmp, "empty.wav")
        write_wav(empty, b"", 8000, 1)
        check("empty verdict", verdict(analyse(empty))[0], "EMPTY")
    finally:
        for f in os.listdir(tmp):
            os.unlink(os.path.join(tmp, f))
        os.rmdir(tmp)

    # main.conf rewriting: the commented-out sample line must not satisfy us.
    commented = "[General]\n#Class = 0x000100\nName = pi\n"
    got, how = set_class(commented, "0x00020c")
    check("class insert", how, "inserted under [General]")
    check("class insert result", got, "[General]\nClass = 0x00020c\n#Class = 0x000100\nName = pi\n")
    live = "[General]\nClass = 0x000100\n"
    got, how = set_class(live, "0x00020c")
    check("class replace", how, "replaced existing Class line")
    check("class replace result", got, "[General]\nClass = 0x00020c\n")
    got, how = set_class("[Policy]\nAutoEnable=true\n", "0x00020c")
    check("class append", how, "appended a [General] section")
    check("class append result", got, "[Policy]\nAutoEnable=true\n\n[General]\nClass = 0x00020c\n")
    check("class idempotent", set_class(got, "0x00020c")[0], got)

    if failures:
        print("selftest: FAIL")
        for f in failures:
            print("  - " + f)
        return 1
    print("selftest: OK (hci packet encoding, tone generation, level verdicts)")
    return 0


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("sco-route", help="route SCO over HCI (Broadcom vendor command)")
    s.add_argument("--dev", default="hci0")
    s.add_argument("--timeout", type=float, default=2.0)
    s.add_argument("--verify", action="store_true", help="read the setting back afterwards")
    s.add_argument("--read-only", action="store_true", help="read current setting, change nothing")
    s.set_defaults(func=cmd_sco_route)

    s = sub.add_parser("tone", help="write a test WAV")
    s.add_argument("--profile", choices=["a2dp", "sco"], required=True)
    s.add_argument("--out", required=True)
    s.add_argument("--rate", type=int)
    s.set_defaults(func=cmd_tone)

    s = sub.add_parser("level", help="measure a recorded WAV")
    s.add_argument("file")
    s.set_defaults(func=cmd_level)

    s = sub.add_parser("set-class", help="set the BlueZ device class in main.conf")
    s.add_argument("--file", default="/etc/bluetooth/main.conf")
    s.add_argument("--class", dest="class", required=True)
    s.set_defaults(func=cmd_set_class)

    s = sub.add_parser("selftest", help="verify the pure logic, no adapter needed")
    s.set_defaults(func=cmd_selftest)

    args = p.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
