// The gauge styles the engine sound's dash can wear, in the picker's order.
// Each is inspired by one cluster of Blackbox Infinite's "CarPlay
// Generations" concept (seven classic cars' dashboards redrawn for the new
// CarPlay); every one here is our own drawing, with no makers' logos. The
// module is loaded only when the style is chosen.
export const STYLES = {
  segment:   { name: 'Segment arc', era: 'S2000-style', load: () => import('./segment.js') },
  fivedial:  { name: 'Five dials', era: '911-style', load: () => import('./fivedial.js') },
  backlit:   { name: 'Backlit pair', era: 'Testarossa-style', load: () => import('./backlit.js') },
  twin:      { name: 'Twin dials', era: 'NSX-style', load: () => import('./twin.js') },
  digital:   { name: 'Digital bars', era: 'Corvette C4-style', load: () => import('./digital.js') },
  tiles:     { name: 'Tile grid', era: 'DeLorean-style', load: () => import('./tiles.js') },
  crosshair: { name: 'Crosshair', era: 'Integrale-style', load: () => import('./crosshair.js') },
}
export const DEFAULT_STYLE = 'segment'
export const styleKey = (k) => (Object.hasOwn(STYLES, k) ? k : DEFAULT_STYLE)
export async function loadStyle(key) {
  const m = await STYLES[styleKey(key)].load()
  return m.default
}
