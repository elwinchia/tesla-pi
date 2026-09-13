/* karaoke-inject.js — injected into the Nightingale page by nginx (sub_filter).
 *
 * Nightingale's frontend is compiled into its release binary, so we cannot edit
 * it. Two things the car needs that upstream has no reason to provide are added
 * here from the outside, at the origin that serves it. Delete the sub_filter
 * lines in conf/nginx-karaoke.conf to drop all of this.
 *
 * 1. A way back to the launcher. The app is a separate origin and takes over
 *    the whole page, so once you are in it the only exit is browser chrome the
 *    driver may not have. This adds one fixed button.
 *
 * 2. Echo cancellation suited to a car. Upstream asks for
 *    `echoCancellation: false` (correct on a desktop with headphones), but in a
 *    cabin the mic hears the backing track through the car speakers, and the
 *    scorer then grades that instead of the singer. We re-request with
 *    echo cancellation on. See docs/karaoke-addon.md.
 */
(function () {
  'use strict';

  // ---- 1. Back to the launcher -------------------------------------------
  // Nightingale always owns the whole screen, so `position: fixed` resolves
  // against the real viewport and the button lands where it should.
  function addBackButton() {
    if (document.getElementById('tesla-pi-back')) return;
    var a = document.createElement('a');
    a.id = 'tesla-pi-back';
    // Same host, default port: the CarPlay launcher.
    a.href = location.protocol + '//' + location.hostname + '/';
    a.textContent = '← Launcher';
    a.setAttribute('aria-label', 'Back to the tesla-pi launcher');
    a.style.cssText = [
      'position:fixed', 'left:12px', 'bottom:12px', 'z-index:2147483647',
      // Big enough to hit on a moving car's touchscreen.
      'min-width:132px', 'padding:13px 20px',
      'font:500 15px -apple-system,system-ui,sans-serif',
      'text-align:center', 'text-decoration:none', 'white-space:nowrap',
      'color:#fff', 'background:rgba(20,20,22,0.72)',
      'border:1px solid rgba(255,255,255,0.22)', 'border-radius:11px',
      '-webkit-backdrop-filter:blur(10px)', 'backdrop-filter:blur(10px)',
      // The app is a game; do not let a stray drag select the label.
      'user-select:none', '-webkit-user-select:none',
      '-webkit-tap-highlight-color:transparent'
    ].join(';');
    document.body.appendChild(a);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', addBackButton);
  } else {
    addBackButton();
  }
  // React owns #root and may wipe siblings on mount; re-assert if it goes.
  setInterval(addBackButton, 2000);

  // ---- 2. Echo cancellation for a speaker-in-the-room setup ---------------
  // Wrap getUserMedia rather than patch the bundle: same effect, survives an
  // upstream version bump, and is one function to remove if it ever hurts.
  var md = navigator.mediaDevices;
  if (!md || typeof md.getUserMedia !== 'function') return;

  var original = md.getUserMedia.bind(md);
  md.getUserMedia = function (constraints) {
    try {
      if (constraints && typeof constraints.audio === 'object' && constraints.audio !== null) {
        // Chromium honours the plain boolean everywhere; `echoCancellationType`
        // is the extra knob that asks it to cancel what WE are playing rather
        // than only far-end conference audio. Setting both is harmless — an
        // unknown key in a non-`exact` constraint is ignored, not an error.
        constraints.audio.echoCancellation = true;
        constraints.audio.echoCancellationType = 'remote-only';
        constraints.audio.noiseSuppression = true;
      }
    } catch (e) {
      /* never let this break capture — fall through to the original request */
    }
    return original(constraints);
  };
})();
