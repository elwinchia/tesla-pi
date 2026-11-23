# Engine sound recordings

The loops in this folder are cut from the recordings and renders below.
The recordings are **not** covered by this repository's BSD licence: each
keeps its own licence, as listed. Every one was recorded and uploaded to
Freesound by the person named, and is used under CC0 (no conditions) or
CC BY (credit required, given here and on `rev.html` next to the car it is
used for). The copies used are the 128 kbit/s MP3 previews Freesound serves
on each sound's own page (the original files need a Freesound login).

The `v8-es-*` loops are our own renders, made with engine-sim (MIT) from
its bundled engine script; engine-sim is credited below all the same.

Changes made to every recording or render: a stretch was cut, made to loop
by crossfading its end into its start, mixed to mono, filtered below 25 Hz,
levelled, and encoded as Ogg Opus. `scripts/rev-samples.mjs` does all of
it from `static/rev-samples.js`, which says exactly which stretch each loop
is.

## engine-sim by AngeTheGreat

- What: Rendered offline on our own machine with engine-sim, a physically modelled engine simulator, from its bundled GM LS V8 script: the engine held on its dynamometer at each rpm at full throttle (on-load) and closed throttle (overrun), plus a free-running idle. scripts/engine-sim/ rebuilds it.
- Source: https://github.com/ange-yaghi/engine-sim at commit 85f7c3b, engine script `assets/engines/atg-video-2/07_gm_ls.mr`
- Author: AngeTheGreat
- Licence: [MIT](https://github.com/ange-yaghi/engine-sim/blob/master/LICENSE)
- Used for: `v8-es-idle.ogg` (v8, 700 rpm, on), `v8-es-idle.ogg` (v8, 700 rpm, off), `v8-es-on-1200.ogg` (v8, 1200 rpm, on), `v8-es-off-1200.ogg` (v8, 1200 rpm, off), `v8-es-on-1800.ogg` (v8, 1800 rpm, on), `v8-es-off-1800.ogg` (v8, 1800 rpm, off), `v8-es-on-2500.ogg` (v8, 2500 rpm, on), `v8-es-off-2500.ogg` (v8, 2500 rpm, off), `v8-es-on-3200.ogg` (v8, 3200 rpm, on), `v8-es-off-3200.ogg` (v8, 3200 rpm, off), `v8-es-on-4000.ogg` (v8, 4000 rpm, on), `v8-es-off-4000.ogg` (v8, 4000 rpm, off), `v8-es-on-4800.ogg` (v8, 4800 rpm, on), `v8-es-off-4800.ogg` (v8, 4800 rpm, off), `v8-es-on-5600.ogg` (v8, 5600 rpm, on), `v8-es-off-5600.ogg` (v8, 5600 rpm, off), `v8-es-on-6300.ogg` (v8, 6300 rpm, on), `v8-es-off-6300.ogg` (v8, 6300 rpm, off)

## "Lambo idle and rev.mp3" by cheesepuff

- Recording: Lamborghini Murciélago LP 670-4 SuperVeloce (V12), idling and revving at a dealer; recorded by the uploader (tags: murcielago, lp-670, superveloce, v12).
- Page: https://freesound.org/people/cheesepuff/sounds/112075/
- Author: cheesepuff
- Licence: [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/)
- File fetched: https://cdn.freesound.org/previews/112/112075_682033-hq.mp3 on 2026-11-23
- Used for: `v12-1184.ogg` (v12, 1184 rpm), `v12-2904.ogg` (v12, 2904 rpm)

## "Audi R8 Idling Reving Backfire.wav" by Jonas_Jocys

- Recording: Audi R8 idling and held at several rpm, recorded by the uploader (MKH 416 above the engine, a condenser behind the car). The page does not say which engine; its harmonics do: the strongest lines are the 2.5th and 5th engine orders, the firing pattern of a V10 (a V8 fires on the 4th).
- Page: https://freesound.org/people/Jonas_Jocys/sounds/457733/
- Author: Jonas_Jocys
- Licence: [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)
- File fetched: https://cdn.freesound.org/previews/457/457733_1900571-hq.mp3 on 2026-11-23
- Used for: `v10-806.ogg` (v10, 806 rpm), `v10-1930.ogg` (v10, 1930 rpm), `v10-2777.ogg` (v10, 2777 rpm), `v10-4070.ogg` (v10, 4070 rpm)

## "Car Engine Contact Recording-Mini Cooper S 2019.wav" by TheLittleCrow

- Recording: 2019 Mini Cooper S (turbocharged inline-4) driven in sport mode, recorded by the uploader with two contact microphones on the chassis and the engine block: the raw engine, no wind or road.
- Page: https://freesound.org/people/TheLittleCrow/sounds/669618/
- Author: TheLittleCrow
- Licence: [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/)
- File fetched: https://cdn.freesound.org/previews/669/669618_5672786-hq.mp3 on 2026-11-23
- Used for: `i4t-900.ogg` (i4t, 900 rpm), `i4t-2988.ogg` (i4t, 2988 rpm), `i4t-3744.ogg` (i4t, 3744 rpm), `i4t-4842.ogg` (i4t, 4842 rpm), `i4t-5541.ogg` (i4t, 5541 rpm)
