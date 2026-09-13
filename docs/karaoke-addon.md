# Karaoke addon (Nightingale)

Serves [Nightingale](https://github.com/rzru/nightingale) — an UltraStar-style
karaoke app with live pitch scoring — to the Tesla browser, launched from a
tile next to CarPlay and Games.

Off by default. Nothing is enabled at install time, boot is untouched, and
CarPlay never depends on any of it.

## The one thing to understand first

Nightingale has two halves, and only one of them belongs on a Pi.

Its headline feature is *generating* karaoke tracks from any song: Demucs or
the UVR model splits the vocals off the instrumental, and WhisperX transcribes
the lyrics with word-level timestamps. That pipeline wants a GPU or a fast
desktop CPU — upstream quotes 2-5 min per song on a GPU and 10-20 min on CPU,
with a PyTorch stack that peaks at several GB of RAM.

A Pi 4 has four Cortex-A72 cores and 4 GB of RAM shared with CarPlay. Running
that pipeline here means hours per song and an OOM kill with CarPlay as the
likely casualty. **So we do not run it.**

The other half is playback, and it is just a web app: HTML, an audio element,
a WebGL canvas and `getUserMedia` for the mic. The Pi only serves files; the
Tesla's own browser does all the work. That half runs fine.

The bridge between the two is **UltraStar**. An UltraStar song ships its own
timed lyrics and note pitches in a `.txt` file, so nothing needs transcribing,
and it usually ships separate vocal and instrumental tracks, so nothing needs
separating. Nightingale treats these as first-class: `analyzer.rs` filters
USDX songs out of the analysis queue entirely, the stem pipeline returns early
for them, and playback resolves audio straight from the song folder. Zero
Python, zero ML, zero ffmpeg at play time.

**This addon installs the UltraStar path.** Bring songs that already have a
`.txt`; do not expect the Pi to make them for you.

## Architecture

```
Tesla browser ──https──> nginx :8443 ──http──> nightingale :8088 (loopback)
   │                     (CarPlay-domain cert)      │
   │                                                └── /var/lib/nightingale
   │                                                      songs/  cache/  vendor/
   └── cabin mic (getUserMedia) ─── pitch scoring, entirely in the browser
```

Three deliberate choices worth knowing:

- **It is a separate origin, not a route on the CarPlay site.** The Nightingale
  SPA is served from the origin root with absolute asset paths (`/assets/...`)
  and no Vite `base`, so it cannot be mounted under `/karaoke/` without patching
  and rebuilding its frontend. A separate *port* on the same hostname is the
  cheap correct answer; a separate *subdomain* is not, because the device cert
  covers exactly `CARPLAY_DOMAIN` (see `conf/tesla-pi.env.template`).

- **TLS is not optional.** Pitch scoring needs the cabin mic, and browsers gate
  `getUserMedia` on a secure context. Reusing the CarPlay-domain cert on :8443
  gives us one for free — and it renews itself, because `cert-sync.sh` already
  keeps that cert fresh. Note that an origin includes the port, so the mic
  grant on :8443 is separate from the one on :443: the driver is asked once
  more, the first time they sing.

- **The AP needs its own forward for it.** While the AP is up dnsmasq answers
  every name with `240.3.3.4`, and the car only reaches nginx through the DNAT
  rules for that address — which covered :80 and :443 and nothing else. The
  installer adds the :8443 rule live and persists it in `conf/iptables.ipv4.nat`
  so it survives the `iptables-restore` in `scripts/ap-mode.sh`.

- **It is not streamed like RetroArch.** RetroArch is a native GL app, so we run
  a compositor, capture it and hardware-encode H.264. Doing that to a web page
  would waste the encoder, add latency to the audio and — fatally — cut the app
  off from the microphone.

## Components

| Path | Role |
| --- | --- |
| `scripts/install-karaoke-addon.sh` | Installer. Downloads the pinned release, seeds the data dir, writes the unit/helper/sudoers/vhost. |
| `scripts/tesla-pi-karaoke` | Privileged helper (`start`/`stop`/`status`). The only thing sudoers grants. |
| `systemd/nightingale.service` | The server. Loopback :8088, `OOMScoreAdjust=500`, no `WantedBy`. |
| `conf/nginx-karaoke.conf` | The :8443 TLS vhost. WebSocket upgrade + Range passthrough, buffering off. |
| `karaoke-bridge.js` | Lifecycle only: start, wait for the port, idle-stop. No media path. |
| `/usr/local/bin/nightingale` | Upstream `nightingale-server` aarch64 binary (frontend embedded). |
| `/var/lib/nightingale/songs` | Your song folders. Pinned via `NIGHTINGALE_LIBRARY_PATH`. |
| `conf/iptables.ipv4.nat` | Adds the `240.3.3.4:8443` DNAT rule the car needs to reach the vhost. |
| `conf/karaoke-inject.js` | Injected by nginx: the Back button and the car echo-cancellation fix. |
| `scripts/make-karaoke-songs.py` | Builds the public-domain songbook — 12 real songs, synthesised. |
| `scripts/make-karaoke-testsong.sh` | Builds a synthetic UltraStar song to smoke-test playback + scoring. |

## Install

Needs internet on the Pi (it fetches a ~20 MB release) and a working CarPlay
cert already in place.

```bash
sudo ./scripts/install-karaoke-addon.sh
sudo systemctl restart tesla-pi.service   # so the launcher shows the tile
```

Smoke test before you go near the car:

```bash
sudo tesla-pi-karaoke start
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8088/api/bootstrap  # 200
sudo tesla-pi-karaoke stop
```

## Adding songs

One folder per song under `/var/lib/nightingale/songs`:

```
songs/Artist - Title/
  Artist - Title.txt          # UltraStar: timed lyrics + note pitches
  Artist - Title.mp3          # the mix (#AUDIO / #MP3)
  Artist - Title [VOC].mp3    # optional, named by #VOCALS
  Artist - Title [INSTR].mp3  # optional, named by #INSTRUMENTAL
```

```bash
sudo chown -R <service-user>:<service-user> /var/lib/nightingale/songs
# Rescan. NOT a restart: the server pins the library on startup and logs
# "library already pinned to folder; not rescanning" when the path has not
# changed, so a restart alone will never notice songs you just added.
curl -sS -X POST http://127.0.0.1:8088/api/cmd/trigger_scan \
     -H 'content-type: application/json' -d '{}'
```

(Or hit **Rescan** in the app's sidebar, which calls the same command.)

Without the `#VOCALS`/`#INSTRUMENTAL` siblings the song still plays and still
scores — Nightingale falls back to the full mix for both tracks, so you sing
over the original vocal rather than a clean backing track.

Use songs you have the right to use — the songbook below is there so there is
something to sing before you go looking. Key and tempo shift are unsupported
for UltraStar songs upstream, so those buttons will report an error.

### The songbook that ships with it

Twelve songs, ready to sing. The installer generates them, so a fresh box has
a library rather than an empty screen. To rebuild them, or to add them to a box
installed before they existed (about five minutes of synthesis on a Pi 4, and
9 MB of mp3 at the end of it):

```bash
sudo ./scripts/make-karaoke-songs.py --rescan
```

```
Happy Birthday to You            Mary Had a Little Lamb
Twinkle, Twinkle, Little Star    Row, Row, Row Your Boat
Ode to Joy                       London Bridge Is Falling Down
Jingle Bells                     Are You Sleeping (Frere Jacques)
Old MacDonald Had a Farm         When the Saints Go Marching In
We Wish You a Merry Christmas    Silent Night
```

Every one of them is **public domain** — the melodies and the words are old
enough that nobody owns them (`--list` prints the provenance and the date for
each). That is the whole reason this is a generator and not a download: the
addon needs a note chart and audio per song, and both of those, for anything
still in copyright, belong to somebody. Here we own what comes out, because the
Pi computes it from the note data in the script.

So the audio is synthesised, not recorded: a plucked melody voice over block
chords, with a bar of count-in ticks so the first entry is not a guess. It
sounds like a cheap keyboard. What it is instead of pretty:

- **Exact.** Each rendered note sits on the pitch the chart notates, so the
  scorer grades you against what you actually hear. `--dry-run` prints the
  lyrics and the derived chords without writing anything.
- **Three tracks, honestly separated.** `[VOC]` is the melody alone — the guide,
  for learning the tune. `[INSTR]` is the accompaniment alone, which is what you
  sing over. The plain file is the mix. No stem separation was involved or
  needed, because they were never mixed together in the first place.
- **Yours.** Nothing is fetched. Re-runnable, and it only ever overwrites its
  own twelve folders.

The chords are worked out from the melody rather than written by hand — each
bar gets the diatonic triad that best accounts for the notes sung over it. On
tunes this simple that lands on the textbook progression (Silent Night comes
out I-I-V-I-IV-I-IV-I); on the odd bar it picks a defensible substitution
rather than the conventional one. It is accompaniment, not an arrangement.

Individual songs, and where to look when one sounds wrong:

```bash
sudo ./scripts/make-karaoke-songs.py --only happy-birthday --rescan
./scripts/make-karaoke-songs.py --dry-run --only silent-night   # chart only
```

To sing "dear <name>" instead of "dear buddy" in Happy Birthday, edit the two
syllables at the end of the third line of its `.txt` — the chart is plain text
and the app reads it, not the script.

### A song to test with

To check the pipeline without sourcing anything:

```bash
sudo ./scripts/make-karaoke-testsong.sh
curl -sS -X POST http://127.0.0.1:8088/api/cmd/trigger_scan \
     -H 'content-type: application/json' -d '{}'
```

That writes `Tesla-Pi Test - Scale` — a C-major scale as sine tones, with
separate `[VOC]` and `[INSTR]` tracks and a matching note chart. Each tone sits
exactly on the pitch the chart notates, so humming along should drive the score
up and silence should leave it at zero. It proves playback, the USDX path and
the scorer in one go, which a song that merely parses does not.

## Use

Launcher → **Karaoke**. The tile starts the server, waits for it to accept
connections, then navigates to `https://<domain>:8443/`. Allow the microphone
when asked, or there is no scoring.

To get back, use the **← Launcher** button pinned bottom-left. That button is
not Nightingale's — its frontend is compiled into the release binary and cannot
be edited, so nginx injects `conf/karaoke-inject.js` into the page on the way
past (`sub_filter`). Without it the app owns the whole page and the only exit is
browser chrome the driver may not have. `nginx-light` is built without
`ngx_http_sub_module`; the installer detects that, strips the injection, and
says so — karaoke still works, just with no Back button.

The server stops itself after ten minutes with no connections
(`KARAOKE_IDLE_STOP_MS`). Measured idle cost is modest — ~9 MB RSS with an
empty library, growing with the scanned song count — so this is tidiness rather
than a rescue, and the timer is deliberately generous. The idle
check counts established connections to :8088 rather than guessing, because the
app holds a `/ws` socket open the whole time it is on screen — and reaping
mid-song would be far worse than holding the memory a few minutes longer.

## Mic notes

The cabin mic is the input. Two things about it are worth knowing before you
blame the scorer.

**It is a separate permission.** An origin includes its port, so
`https://<domain>:8443` is not the origin the CarPlay page runs on. The browser
asks for the microphone again the first time you sing. Allow it — the grant
then persists.

**Upstream's capture settings are wrong for a car.** Nightingale asks for
`echoCancellation: false`, `noiseSuppression: false`, `autoGainControl: false`
(`client/src/bridge/microphone.web.ts`), which is right on a desktop with
headphones and wrong in a cabin: the mic hears the backing track through the car
speakers, and the scorer grades that instead of the singer. There is no in-app
setting for it. `conf/karaoke-inject.js` therefore wraps `getUserMedia` and
re-requests with echo cancellation on, asking for `echoCancellationType:
'remote-only'` — the mode that rejects audio we are playing rather than only
far-end conference audio (see `docs/tesla-browser-capabilities.md`).

Delete that block from the inject script if it ever does more harm than good;
singing with headphones would make it unnecessary, though that is not much of a
car feature. Mic capture needs an AMD-MCU car.

## Why the vendor directory is seeded

Nightingale hides its whole UI behind a modal setup wizard until `is_ready()`
passes, and in web mode that wizard has no skip — only a Continue that starts
the multi-GB ML download. `is_ready()` wants four things: a `.ready` marker, a
vendor `ffmpeg`, a venv `python`, and `analyzer/analyze.py`.

The installer supplies all four honestly — the distro ffmpeg by symlink, a real
(empty) venv, and a placeholder `analyze.py` — minus the ML packages nothing
here can run. UltraStar playback touches none of them, so the app works fully;
ask it to analyse an ordinary song and it fails with a clear message instead of
thrashing a 4 GB Pi for an hour. (The server rewrites `analyzer/` with its own
embedded scripts on first start, which changes nothing: the import still fails,
just later.)

To get the real thing anyway — a big SD card and a lot of patience:

```bash
sudo KARAOKE_ENABLE_ML=1 ./scripts/install-karaoke-addon.sh
```

That skips the seed and lets the in-app wizard download the full stack.
Analysis on a Pi 4 remains impractical; the supported route for ordinary songs
is to analyse them on a desktop and copy the results over.

## Tuning

Env vars on `tesla-pi.service` (bridge) — all optional:

| Var | Default | Effect |
| --- | --- | --- |
| `KARAOKE_IDLE_STOP_MS` | `600000` | Idle before auto-stop. |
| `KARAOKE_READY_TIMEOUT_MS` | `45000` | How long to wait for :8088 on start. |
| `KARAOKE_PUBLIC_PORT` | `8443` | Must match the vhost's `listen`. |
| `KARAOKE_BACKEND_PORT` | `8088` | Must match `NIGHTINGALE_BIND`. |

Pin a different upstream release at install time with `NIGHTINGALE_VERSION`.

## Rollback

```bash
sudo tesla-pi-karaoke stop
sudo rm -f /etc/systemd/system/nightingale.service /usr/local/sbin/tesla-pi-karaoke \
           /etc/sudoers.d/tesla-pi-karaoke /usr/local/bin/nightingale \
           /etc/nginx/sites-enabled/karaoke /etc/nginx/sites-available/karaoke
sudo systemctl daemon-reload && sudo nginx -t && sudo systemctl reload nginx
# drop the port forward (and remove the :8443 line from conf/iptables.ipv4.nat)
sudo iptables -t nat -D PREROUTING -d 240.3.3.4/32 -i wlan0 -p tcp -m tcp \
     --dport 8443 -j DNAT --to-destination 192.168.4.254 2>/dev/null
sudo systemctl restart tesla-pi.service   # tile disappears again
# songs and library db survive; remove them too if you are done:
# sudo rm -rf /var/lib/nightingale
```
