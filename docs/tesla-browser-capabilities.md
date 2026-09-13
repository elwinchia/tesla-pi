# Tesla browser capabilities

What the in-car browser can do, and what we have actually confirmed it does.

> **Status: unverified.** Everything below comes from Tesla release notes
> (notateslaapp.com for 2026.26, 2026.20 and 2026.14.3), relayed 2026-08-20.
> **Nothing here has been measured on our car.** Treat every capability as a
> hypothesis until the probe in [On-car probe](#on-car-probe) says otherwise —
> release notes describe intent, not the behaviour of the build sitting in your
> driveway.

## What changed

| Release | Change | Why we care |
|---|---|---|
| 2026.14 (Spring) | Browser engine Chromium 136 → 140 | Raises the floor for WebCodecs / WebRTC / WebGPU in the video path |
| 2026.20 | Controls → Safety → Parental Controls can disable Browser, Theater and Arcade outright | Can kill the entire product — first thing to check when the browser is missing |
| 2026.26 (Summer) | Interior camera and cabin microphone exposed to the browser via `getUserMedia` | A possible path to Siri and call audio that doesn't depend on the car's Bluetooth pairing |

Release note for 2026.26, verbatim:

> "You can now use your Tesla's interior camera and cabin microphone in Web
> Browser. Tap to grant permissions when a website requests access. Camera is
> only available while parked."

Stated constraints:

- **Standard Chrome-style permission prompt** — deny / allow this session /
  allow always. Any HTTPS origin may ask; there is no Tesla allowlist, so the
  domain the Pi serves under qualifies like any other.
- **Camera is explicitly park-gated.** The microphone is *not documented* as
  park-gated. That asymmetry is the interesting part, and precisely the thing to
  measure rather than assume — an undocumented restriction is still a
  restriction.
- **AMD Ryzen MCU only.** Intel-infotainment cars (roughly pre-MY2022) get no
  browser camera or mic input at all, so anything built on this is a
  capability-detected extra, never a baseline feature.

## Why the microphone matters here

Today Siri, call audio and mic input ride the Tesla's own Bluetooth link to the
iPhone — the Pi is never in the audio path (see the README). That works, but it
means CarPlay's microphone depends on a pairing this project doesn't own or
control, and it's the part of the setup most likely to be misconfigured by a
user.

If `getUserMedia({audio:true})` yields the cabin mic **while driving**, the
browser could capture audio and hand it back over the existing `/control`
channel, closing the loop inside our own stack. If the mic turns out to be
park-gated like the camera, that path is dead on arrival and the Bluetooth
arrangement stays the only answer.

> **Answered: it works in Drive.** Confirmed 2026-08-23. The microphone is *not*
> park-gated like the camera, so voice input is available while moving. The
> parked measurements (Chromium 148, 48 kHz stereo, and the finding that
> `echoCancellation: "remote-only"` is the only mode that rejects our own audio
> while still hearing the driver) are recorded in the results section below.
> This is the premise `docs/llm-companion-options.md` §5 builds on.

## On-car probe

The Tesla browser has no devtools, so a probe has to render its results on
screen. Use `static/mic-probe.html`, already in the repo; the
static handler in `index.js` serves anything under `static/` by path, so it
lands at:

```
https://device.tesla-pi.humblebees.co/mic-probe.html
```

Run it **twice** — once parked, once in DRIVE.

> **Have a second person drive.** Don't operate the screen yourself while the
> car is moving. If nobody else is available, the parked run still answers
> items 1, 2, 4, 5 and 6; leave 3 blank rather than improvising.

### Checklist

| # | Question | How to read the result |
|---|---|---|
| 1 | What Chromium version is this car actually running? | `navigator.userAgent` — confirms whether 140 (2026.14+) or something older, which sets the floor for WebCodecs/WebRTC/WebGPU work |
| 2 | What inputs exist before and after permission? | `enumerateDevices()` twice — labels are empty until a grant, so the delta shows both what exists and what the grant unlocks |
| 3 | **Does the mic work in DRIVE?** | The critical unknown. Park-gated like the camera, or genuinely available in motion? |
| 4 | Does "allow always" persist? | Re-check after a page reload, a browser restart, and a car sleep/wake cycle — three separately plausible failure points |
| 5 | Is the grant scoped to our origin? | Permissions are origin-scoped; confirm the grant sticks to the domain the Pi serves and survives a cert rotation |
| 6 | What does the cabin mic stream look like? | Sample rate, channel count, and whether `echoCancellation` / `noiseSuppression` / `autoGainControl` constraints are honoured or silently ignored |

Item 6 decides how much signal processing would have to happen on the Pi. A
mono 16 kHz stream with echo cancellation already applied is a very different
engineering problem from raw 48 kHz stereo with the car's own speakers bleeding
into it.

### Recording results

Fill this in on the car, not from memory:

```
Car / MCU:              (AMD Ryzen or Intel)
Software version:
navigator.userAgent:

Devices before grant:
Devices after grant:

Parked  — getUserMedia({audio:true}):   pass / fail / prompt never appeared
DRIVE   — getUserMedia({audio:true}):   pass / fail / prompt never appeared
Prompt options offered:

Persists across reload:          yes / no
Persists across browser restart: yes / no
Persists across sleep/wake:      yes / no

Track settings (sampleRate / channelCount / EC / NS / AGC):
```

### The probe page

> **Superseded.** `static/mic-probe.html` now exists as a real file and does
> strictly more than the listing below — RMS level measurement, Park/Drive
> tagging of each run, and an optional POST of the report to the Pi (the
> `/debug/mic-probe` route in `index.js`, which does not exist unless
> `MIC_PROBE_DIR` is set). Open `/mic-probe.html` and ignore this listing; it is
> kept only until someone confirms the two agree.


```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Tesla browser probe</title>
<style>
  body { margin:0; padding:24px; background:#0b0c0e; color:#f2f3f5;
         font:16px/1.6 system-ui, sans-serif; }
  h1 { font-size:22px; margin:0 0 16px; }
  button { font:600 18px system-ui; padding:14px 22px; margin:0 8px 12px 0;
           border-radius:10px; border:1px solid #444; background:#1d2026;
           color:#f2f3f5; }
  pre { background:#16181c; border:1px solid #2a2d33; border-radius:10px;
        padding:14px; white-space:pre-wrap; word-break:break-word;
        font:13px/1.6 ui-monospace, Menlo, monospace; }
  .ok { color:#46a758; } .bad { color:#e5484d; }
</style>
</head>
<body>
<h1>Tesla browser probe</h1>
<div>
  <button id="mic">Request microphone</button>
  <button id="list">List devices</button>
  <button id="perm">Permission state</button>
</div>
<pre id="out">Tap a button. Results print here.</pre>
<script>
var out = document.getElementById('out');
function say(label, value) {
  out.textContent += '\n' + label + ': ' +
    (typeof value === 'string' ? value : JSON.stringify(value, null, 2)) + '\n';
}

// Baseline, printed on load.
out.textContent = 'userAgent: ' + navigator.userAgent +
  '\nsecureContext: ' + window.isSecureContext +
  '\nmediaDevices: ' + !!navigator.mediaDevices +
  '\nWebCodecs: ' + (typeof VideoDecoder !== 'undefined') +
  '\nWebGPU: ' + !!navigator.gpu;

function listDevices(tag) {
  return navigator.mediaDevices.enumerateDevices().then(function (ds) {
    say(tag, ds.map(function (d) {
      return { kind: d.kind, label: d.label || '(hidden until granted)', id: d.deviceId };
    }));
  });
}

document.getElementById('list').onclick = function () { listDevices('devices'); };

document.getElementById('perm').onclick = function () {
  if (!navigator.permissions) { say('permissions', 'API not available'); return; }
  navigator.permissions.query({ name: 'microphone' })
    .then(function (s) { say('microphone permission', s.state); })
    .catch(function (e) { say('permissions query failed', String(e)); });
};

document.getElementById('mic').onclick = function () {
  listDevices('devices BEFORE grant');
  navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
  }).then(function (stream) {
    var t = stream.getAudioTracks()[0];
    out.innerHTML += '<span class="ok">GRANTED</span>';
    say('track label', t.label);
    say('settings', t.getSettings());
    if (t.getCapabilities) { try { say('capabilities', t.getCapabilities()); } catch (e) {} }
    listDevices('devices AFTER grant');
    // Stop immediately — this is a capability probe, not a recorder.
    stream.getTracks().forEach(function (x) { x.stop(); });
  }).catch(function (e) {
    out.innerHTML += '<span class="bad">DENIED / FAILED</span>';
    say('error', e.name + ' — ' + e.message);
  });
};
</script>
</body>
</html>
```

The probe requests a stream and stops it in the same breath — it never records,
never buffers, and never sends audio anywhere. Keep it that way: a page that
can reach the cabin microphone should not also be able to keep what it hears.

## Follow-ups, once the probe has answers

- **Mic works in DRIVE** → design the capture path: browser → `/control` →
  dongle. Capability-detect it and keep the Bluetooth arrangement as the
  fallback for Intel cars and for anyone who denies the prompt.
- **Mic is park-gated** → close the idea out in this doc so it doesn't get
  re-litigated, and leave the README's Bluetooth explanation as the answer.
- **Chromium 140 confirmed** → revisit whether the video path can use WebCodecs
  directly instead of the current decoder arrangement (see
  `docs/perf-optimizations.md`).

## A stream is not yet a call

Even if the mic answers yes in Drive, two things stay unmeasured and neither is
free:

- **Latency.** mic → `/control` → Pi → USB → dongle → phone, and back. Local
  Wi-Fi adds little but the chain is long, and Siri tolerates far more delay
  than a phone call does. Measure it before promising call support.
- **The dongle has to accept it.** Nothing established here says the CarLinkit
  will take an arbitrary PCM stream as its microphone input. That is a separate
  unknown, in `carlink-protocol-notes.md` territory.

## Parental Controls

Since 2026.20, Controls → Safety → Parental Controls can disable Browser,
Theater and Arcade entirely. When it's on, the browser is simply absent from the
car's UI — the hotspot still works, the Pi is still healthy, and every
diagnostic on the Pi looks perfect.

Check this first when a car that used to work suddenly has no browser at all.
It looks like a total product failure and it is a toggle.
