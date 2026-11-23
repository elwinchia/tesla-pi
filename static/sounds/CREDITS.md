# Engine sound credits

The `*-es-*` loops are our own renders, made with engine-sim (MIT) from its
bundled engine scripts; engine-sim is credited below all the same. They are
rendered with `scripts/engine-sim/`, then cut, made to loop by crossfading
each end into its start, equalised and given a low-passed dry sub layer where
`static/rev-samples.js` says so, filtered below 25 Hz, levelled and encoded as
Ogg Opus by `scripts/rev-samples.mjs`.

## engine-sim by AngeTheGreat

- What: Rendered offline on our own machine with engine-sim, a physically modelled engine simulator, from its bundled GM LS V8 script: the engine held on its dynamometer at each rpm at full throttle (on-load) and closed throttle (overrun), plus a free-running idle; through engine-sim's own "real engine" exhaust impulse response, with a dry render of the same runs as a low sub layer. scripts/engine-sim/ rebuilds it.
- Source: https://github.com/ange-yaghi/engine-sim at commit 85f7c3b, engine script `assets/engines/atg-video-2/07_gm_ls.mr`
- Author: AngeTheGreat
- Licence: [MIT](https://github.com/ange-yaghi/engine-sim/blob/master/LICENSE)
- Used for: `v8-es-idle.ogg` (v8, 700 rpm, on), `v8-es-idle.ogg` (v8, 700 rpm, off), `v8-es-on-1200.ogg` (v8, 1200 rpm, on), `v8-es-off-1200.ogg` (v8, 1200 rpm, off), `v8-es-on-1800.ogg` (v8, 1800 rpm, on), `v8-es-off-1800.ogg` (v8, 1800 rpm, off), `v8-es-on-2500.ogg` (v8, 2500 rpm, on), `v8-es-off-2500.ogg` (v8, 2500 rpm, off), `v8-es-on-3200.ogg` (v8, 3200 rpm, on), `v8-es-off-3200.ogg` (v8, 3200 rpm, off), `v8-es-on-4000.ogg` (v8, 4000 rpm, on), `v8-es-off-4000.ogg` (v8, 4000 rpm, off), `v8-es-on-4800.ogg` (v8, 4800 rpm, on), `v8-es-off-4800.ogg` (v8, 4800 rpm, off), `v8-es-on-5600.ogg` (v8, 5600 rpm, on), `v8-es-off-5600.ogg` (v8, 5600 rpm, off), `v8-es-on-6300.ogg` (v8, 6300 rpm, on), `v8-es-off-6300.ogg` (v8, 6300 rpm, off)
