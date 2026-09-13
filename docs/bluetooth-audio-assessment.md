# Routing audio over the Pi's own Bluetooth — assessment

Status: **Not recommended, not implemented.** Written 2026-09-04 after the
question came up twice. The conclusion is "keep what we have", but the two
reasons that actually matter are not the obvious ones, so they are written down
here rather than re-derived.

Related: [`carplay-on-demand.md`](carplay-on-demand.md),
[`telemetry-options.md`](telemetry-options.md),
[`tesla-browser-capabilities.md`](tesla-browser-capabilities.md).

## 0. The question

Pair the Pi to the car over Bluetooth as an audio device. Then:

1. Route CarPlay audio and the CarPlay mic through it?
2. Route the karaoke backing track and mic through it?
3. Get vehicle telemetry over the same link?

Short answers: **no gain**, **no**, and **no** — in that order of confidence.

## 1. First, a naming trap in our own code

`audioSource: "bluetooth"` — the current setting on the test Pi — does **not**
mean the Pi speaks Bluetooth to the car. `index.js:393`:

> `'bluetooth'` is the phone's own A2DP link to the car, which is how this box
> has always sounded and needs nothing from us

The **phone** is paired to the car. CarPlay audio goes phone → A2DP → car
speakers, and the Pi is not in the audio path at all. That is why the mode
"needs nothing from us", and why `audioTransferMode` is ON in that mode: the
audio stays inside the dongle and never crosses USB.

Anyone reading the setting name and concluding "we already do Pi Bluetooth
audio" has it backwards.

## 2. Latency: the argument is topology, not milliseconds

The tempting objection to Pi-side A2DP is "Bluetooth adds 150–250 ms". That
objection is wrong on its own terms — **the phone's A2DP link has the same
latency**, and the buffering that causes it lives in the car's decoder, which is
downstream of whoever is transmitting. Nobody escapes it.

What actually matters is whether that delay lands *parallel to* or *in series
with* the video pipeline.

**Today — parallel.** The two paths are independent and their delays partly
cancel:

```
audio:  phone ──A2DP──────────────────────────────► car speakers      L_bt
video:  phone ──USB──► dongle ──USB──► Pi ──WS──► browser decode ──► paint   L_pipe
```

Both are order 100–250 ms, so the lip-sync error is `|L_bt − L_pipe|`, which is
small. The sync we have is partly luck, but it is real.

**Pi-side — serial.** The audio inherits the whole USB pipeline *and then* pays
Bluetooth on top:

```
audio:  phone ──USB──► dongle ──USB──► Pi ──SBC encode──► BT ──► speakers   L_pipe + L_bt
video:  unchanged                                                          L_pipe
```

The video no longer offsets anything. You have added roughly a full `L_bt` plus
encode time of drift, always in the same direction (audio late). That is the
objection — the topology, not the magnitude.

### 2b. The second cost: PCM on the USB link

Pi-side Bluetooth requires `audioTransferMode` OFF so the dongle ships PCM to
us. That puts audio on the same USB link as the H.264 video. This dongle
(CPC200-CCPA, firmware 2024.01.19) already produced `LIBUSB_TRANSFER_ERROR` and
`usb_read_error` under the wide-mode load tests of 2026-09-02. Adding a
continuous PCM stream to that link is a second, independent risk with its own
failure mode.

## 3. Karaoke: the problem is the scorer's clock, not the singer

"You cannot sing to a backing track that arrives 200 ms late" is **wrong**, and
it is worth being precise about why, because the real problem is narrower and
harder.

A constant delay on the backing track alone is *invisible to the singer*. You
sing along to what you hear. If everything shifts by 200 ms you simply start
200 ms later and never notice.

The failure is in the **scoring timebase**. Nightingale grades mic input against
where *it* thinks the track is. Insert an unreported 200 ms between "the app
played this note" and "the singer heard it", and the singer's response arrives
~200 ms late on the app's clock plus whatever the capture path adds — so every
note reads late and the score is garbage.

And it cannot be calibrated out: **A2DP latency is not constant.** It moves as
the sink's buffer drains and refills, and the sink does not report it.

Karaoke works today precisely because one `AudioContext` both plays the track
and captures the mic, so both live on one clock with a known relationship.

## 4. The mic: HFP is a profile-level dead end

To pull the cabin mic over Bluetooth the Pi must impersonate a phone — HFP
**Audio Gateway**, with the car as the hands-free unit. BlueZ/PipeWire can do
the AG role, so this is not a software gap.

It is a profile constraint:

- HFP audio runs over a **SCO/eSCO** link: **mono, 8 kHz CVSD**, or **16 kHz
  mSBC** at best.
- **While SCO is up, A2DP is suspended.** One channel. You get good stereo out,
  *or* a phone-grade mic plus phone-grade output. Never both.

Karaoke needs full-range stereo out and mic in *simultaneously*, which is
exactly what the profile forbids.

And for CarPlay there is nothing to win: the existing path already captures the
cabin mic through `getUserMedia` and sends 16 kHz mono S16LE, which is what the
dongle's header hardcodes anyway (`decodeType 5`, `index.js:2275`). HFP's
ceiling is that same 16 kHz, purchased by destroying the music.

## 5. Echo cancellation gets harder, not easier

`echoCancellation: "remote-only"` works today because the browser holds **both**
signals — it knows what it is playing, so it can subtract it from what it hears.
See [`karaoke-addon.md`](karaoke-addon.md) and `conf/karaoke-inject.js`.

Split playback and capture across two Bluetooth profiles and nothing in the
chain holds both, time-aligned. You would be writing your own AEC against an
unknown, drifting delay. That is a genuinely hard DSP problem and not one worth
taking on to solve a problem we do not have.

## 6. Telemetry over the same link — no

Two independent reasons.

**Different stacks.** A2DP is Bluetooth **Classic** (BR/EDR, L2CAP/AVDTP). The
Tesla vehicle API is **BLE** GATT. Separate pairing, separate bonding, no
relationship. Connecting one tells you nothing about the other.

**The car exposes no vehicle data over Classic at all.** Classic is the car
pulling *from* the phone — PBAP phonebook, MAP messages — plus the audio
profiles. There is no vehicle-status Classic profile to connect to. AVRCP
carries media metadata only, and in the Pi→car direction. Telemetry still needs
exactly the BLE path in `scripts/tesla-pi-ble`, with all three gotchas in
[`telemetry-options.md`](telemetry-options.md) intact.

### Can Classic audio and BLE telemetry coexist on the Pi?

Technically yes. Measured on the test Pi 2026-09-04:

```
hci0:  Type: Primary  Bus: UART   DOWN
       BD Address: XX:XX:XX:XX:XX:XX
       Features: 0xbf 0xfe 0xcf 0xfe 0xdb 0xff 0x7b 0x87
       SCO MTU: 64:1
       bluez 5.82, pipewire present, 0 paired devices
```

One dual-mode controller — BR/EDR and LE both present, SCO supported. It can run
both. Three caveats, in order of importance:

1. **`hci0` is `DOWN` on purpose.** Bluetooth is `rfkill` soft-blocked by
   default because the BT radio shares silicon with the `wlan0` AP; the BLE
   helper borrows the block and returns it around each call. **A2DP needs the
   radio up continuously**, which permanently removes that mitigation. This is
   the real cost: a deliberate design decision would be reversed to buy nothing
   from §2–§4.
2. **Airtime.** The same combo chip serves the `wlan0` AP and the `wlan1`
   client, all in 2.4 GHz. A2DP is a continuous, greedy stream; BLE GATT bursts
   on top of it. With `throttled=0x50005` still unresolved, this is not the
   moment to add radio load.
3. **A Classic link does *not* consume one of the car's three BLE slots.** This
   is the one piece of good news: the slots are independent, so pairing for
   audio would not worsen the phone-key contention described in
   [`telemetry-options.md`](telemetry-options.md).

## 7. Where Bluetooth audio *would* earn its place

Not zero. Pi-generated audio that is **not latency-critical and not coming from
the browser tab**: RetroArch game music, chimes, TTS. If browser audio ever
proves unreliable for those, A2DP source is a sound fallback — 200 ms does not
matter for background game music the way it does for singing or lip-sync.

That is the only case worth revisiting.

## 8. Conclusion

Keep the current design:

| Path | Mechanism | Why |
|---|---|---|
| CarPlay audio | phone's own A2DP, Pi not involved | parallel to video; zero added hops |
| CarPlay mic | browser `getUserMedia` → WS → `SendAudio` | already 16 kHz mono, the dongle's native rate |
| Karaoke audio + mic | browser playback + capture, one `AudioContext` | the only way the scorer and the AEC share a clock |
| Telemetry | BLE, `scripts/tesla-pi-ble`, opt-in, read-only | unrelated stack; unchanged by any of the above |
