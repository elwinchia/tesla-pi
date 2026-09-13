# Bluetooth probe — can the Pi be the car's phone?

Status: **untested against hardware.** Everything here was built and verified off
the car (`scripts/bt-probe-mock-test.sh`, 34 checks; `bt-probe-util.py selftest`).
Nothing in it has met a Tesla or a Broadcom radio yet.

> **Check [`tesla-browser-capabilities.md`](tesla-browser-capabilities.md) first.** Tesla
> 2026.26 exposed the cabin microphone to `getUserMedia` in the in-car browser.
> If that works while driving, the page we already serve can capture voice over
> the WebSocket that is already open, and none of the Bluetooth work below is
> needed for this purpose. That is a much cheaper question to answer than any of
> the three unknowns here.

## Why bother

CarPlay expects the head unit to supply a microphone. This Pi has none, so if the
iPhone's audio route is switched to CarPlay — which is what any plan to get audio
out of the dongle requires — Siri and phone calls become one-way: you hear them,
they hear nothing.

A USB microphone would fix it and is not wanted. The alternative is to borrow the
car's own microphone array, which is only reachable over Bluetooth HFP, and only
if the Pi presents itself to the car as a *phone* (the Audio Gateway role) rather
than as a headset.

If that works, the shape is:

```
iPhone ──CarPlay(wifi)──▶ dongle ──USB──▶ Pi ──A2DP───▶ Tesla speakers   (media)
                                            Pi ◀──SCO──── Tesla cabin mic (calls/Siri)
                                            Pi ──AVRCP◀── steering wheel  (bonus)
```

The iPhone then talks only to the dongle; the car sees exactly one connected
"phone", which is us. That also sidesteps Tesla's two-simultaneous-connections
limit, and the unreliable iOS *Call Audio Routing* workaround.

Three separate things have to be true, and only the car can settle them:

1. the onboard Broadcom controller routes SCO over HCI (else voice audio goes out
   the chip's PCM pins and we capture digital silence);
2. the Tesla pairs with, and offers profiles to, a Linux box advertising itself as
   a phone;
3. the car opens a SCO link for us. Car kits often refuse unless they believe a
   call is in progress, which would mean building an AT-level call state machine,
   not just opening a PCM.

## Before you start

- The Pi needs an uplink for `deps` (wlan1 on home Wi-Fi, or eth0).
- The car should be awake and in Park. Don't do this while driving.
- Expect the car to **drop your iPhone's Bluetooth connection** when it connects
  to the Pi. Re-select it afterwards; `undo` prints how to remove the pairing.
- The probe never touches `hostapd`, `tesla-pi.service`, `wlan0` or `wlan1`. It
  does stop a running `bluealsa.service`, because the packaged unit doesn't
  enable the HFP gateway role, and restarts it on `undo`.
- The Carlinkit runs its own 2.4 GHz Bluetooth link to your phone a few
  centimetres away. If CarPlay stutters during the test, that's a finding worth
  writing down, not a glitch.

## Running it

Each phase stands alone and writes into one session directory under
`/var/tmp/tesla-pi-bt-probe/`, so you can stop between phases and think.

```bash
sudo scripts/bt-probe.sh env      # read-only inventory; safe any time
sudo scripts/bt-probe.sh deps     # apt install whatever env said was missing
sudo scripts/bt-probe.sh enable   # power on, route SCO over HCI, look like a phone
sudo scripts/bt-probe.sh pair     # 3-minute window; add the device from the car
sudo scripts/bt-probe.sh a2dp     # a tone should come out of the speakers
sudo scripts/bt-probe.sh watch    # press wheel controls and the voice button
sudo scripts/bt-probe.sh sco      # the microphone test — the one that matters
sudo scripts/bt-probe.sh bundle   # tarball of everything, to hand back
sudo scripts/bt-probe.sh undo     # put the box back
```

On the car, during `pair`: **Controls → Bluetooth → Add New Device**, then pick
`Tesla-Pi`. Nothing needs pressing on the Pi side; pairing is auto-accepted for
the length of the window.

During `watch`, with a pause between each: next track, previous track,
play/pause, then press and hold the voice-command button. That last one is the
most interesting — if the car sends `AT+BVRA` it may open a SCO link on its own,
which is a second route to the microphone that doesn't need us to fake a call.

Every phase captures an HCI trace next to its log. That trace is the real
deliverable: it decodes the HFP negotiation, the codec choice, AVRCP passthrough,
and the reason a SCO setup was refused — none of which appears in any tool's
stdout.

## Reading the result

**`enable` → `sco-route: FAIL … unknown HCI command`**
The controller doesn't implement the Broadcom SCO-routing command. Media over
A2DP is unaffected; the microphone route is dead on this radio and the answer is
Option A (audio into the browser) plus the iOS routing workaround.

**`pair` → no new pairing**
Check whether `Tesla-Pi` appeared in the car's list at all. If it never showed,
the device class or the advertised profiles kept it hidden — `bluealsa` must be
running *before* the car scans, because BlueZ derives what it advertises from the
profiles actually registered. If it showed but wouldn't pair, the trace has the
reason.

**`a2dp` → aplay clean, nothing audible**
The stream opened but the car isn't rendering it. Check the car's media source;
Bluetooth may not have become the active source.

**`a2dp` → both tones on both sides**
Something is downmixing to mono. The test file is deliberately both → left → right
→ both so this can't hide.

**`sco` → no capture at any rate**
The decisive negative. Two distinguishable causes in the trace:
- no SCO setup attempted → bluealsa never asked, or the service-level connection
  never completed;
- setup attempted and rejected → the car won't open voice audio without a call in
  progress. That means an AT-level call state machine (fake `+CIEV` call
  indicators, or `+BVRA` for voice recognition), which is a real build, not a
  config change.

**`sco` → capture succeeds but `level: SILENT`**
The link carried nothing. That is the signature of the SCO routing not being in
effect — the controller is shipping voice out its PCM pins. Re-run `enable`
(a `bluetoothd` restart resets the controller and loses the setting) and retry.

**`sco` → `level: AUDIO`**
The car's microphone is reaching the Pi at 16 kHz mono S16LE, which is *exactly*
the format `SendAudio` wants — node-carplay hardcodes `decodeType 5` and
`node-microphone` defaults to 16 kHz mono. No resampling between the cabin mic
and the dongle. Build Option B.

## The other half: is there any CarPlay audio to send?

Independent of Bluetooth, and never yet confirmed on this box: the iPhone only
sends audio to CarPlay when CarPlay is its selected output. Today it isn't — the
audio goes over the phone's own Bluetooth link to the car — so the dongle may be
sending us nothing at all.

```bash
# on the Pi, briefly:
sudo systemctl edit --full tesla-pi     # add: Environment=AUDIO_TAP=/var/tmp/carplay-audio
sudo systemctl restart tesla-pi
# in the car: play music, then swap iPhone audio output to the CarPlay unit
journalctl -u tesla-pi | grep -E 'audio_first_frame|audio_tap_open|audio_mic_requested'
```

`audio_first_frame` reports the format the dongle chose (44.1k stereo = media;
the mono rates = call/Siri audio), and the tap writes each stream to
`/var/tmp/carplay-audio-<decodeType>.raw`. Play one back to prove it end to end:

```bash
aplay -f S16_LE -r 44100 -c 2 /var/tmp/carplay-audio-1.raw
# or, once the car is paired, straight at the speakers:
aplay -f S16_LE -r 44100 -c 2 -D bluealsa:DEV=<car-mac>,PROFILE=a2dp /var/tmp/carplay-audio-1.raw
```

That last command is the whole thesis in one line: CarPlay audio, out of the Pi,
into the car, over Bluetooth. The tap is capped at 32 MB and does nothing at all
unless `AUDIO_TAP` is set — remove the environment line when finished.

Watch for `audio_mic_requested` too: it fires when the phone signals Siri or a
call, which is the trigger a microphone bridge would hang off, and it proves the
phone is asking us for a microphone.

## Known constraints

- **The SCO routing is lost on every controller reset**, including a `bluetoothd`
  restart. A shipped version needs a systemd unit that reapplies it; the probe
  just reapplies it each run.
- **Tesla connects two Bluetooth devices at once**, and its documentation frames
  the second slot as a controller rather than a second audio device. Assume the
  Pi takes the phone slot outright.
- **A2DP adds fixed latency** (~150–200 ms). Fine for music; RetroArch audio
  should stay on the existing browser path, which is a lower-latency
  AudioWorklet.
- **AVRCP needs a registered player** for the car's commands to reach us. `watch`
  can only show whether the car *sends* them; wiring them to the dongle's media
  keys is part of the build, not the probe.

## What's in the bundle

`bundle` produces `/var/tmp/tesla-pi-bt-probe/bt-probe-<session>.tgz`:

| file | what it settles |
|---|---|
| `env.txt` | radio present, overlays, packages, SCO routing readback |
| `*.btsnoop`, `*.btmon.txt` | the HCI truth for every phase |
| `*.dbus.txt` | BlueZ's own view of profiles and transports |
| `state` | the car's MAC, negotiated SCO rate, which bluealsa flags worked |
| `mic-*.wav` | the microphone capture, if there was one |
| `bluealsa.log` | why the daemon refused an argument set, if it did |
| `healthz-before/after.json` | whether any of this disturbed CarPlay |
