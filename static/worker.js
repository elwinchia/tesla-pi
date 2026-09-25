importScripts("renderer_webgl.js");

// Rendering. Drawing is limited to once per animation frame.
let renderer = null;
let pendingFrame = null;
let frameCount = 0;
let fps = 60;
let frameDuration = (1000 / fps) | 1;
// Set up a VideoDecoer.
  const decoder = new VideoDecoder({
    output(frame) {
      // Schedule the frame to be rendered.
      renderFrame(frame);
    },
    error(e) {
      // setlog takes ONE argument, so `setlog("decode", e)` threw the error away
      // and posted the bare string "decode". A decoder that rejects the stream
      // outright therefore looked identical to silence, which is how a blank
      // CarPlay band with no diagnosis reached the car (2026-09-02).
      setlog({
        kind: "decodeError",
        name: (e && e.name) || "Error",
        message: String((e && e.message) || e),
      });
    }
  });

function renderFrame(frame) {
  if (!pendingFrame) {
    // Schedule rendering in the next animation frame.
    requestAnimationFrame(renderAnimationFrame);
  } else {
    // Close the current pending frame before replacing it.
    pendingFrame.close();
  }
  // Set or replace the pending frame.
  pendingFrame = frame;
}

function setlog(message) {
  self.postMessage(message);
}

// Cleared whenever the page puts its loading card up (every /video connection
// included), NOT once per worker. The
// worker outlives every route change, so a one-shot latch here meant the page
// hid its loading card the first time CarPlay painted and never again: leaving
// for the launcher closes /video (applyRoute -> video.stop()), coming back
// reopens it, frames decode and paint — and the card stayed on top of a live
// picture until the page was reloaded. Reported in the car 2026-09-04.
let announcedFirstFrame = false;
function renderAnimationFrame() {
  renderer.draw(pendingFrame);
  const w = pendingFrame.displayWidth, h = pendingFrame.displayHeight;
  pendingFrame = null;
  // The page used to hide its "Connecting…" card as soon as BYTES arrived on
  // the socket, which is not the same thing as a picture. When the decoder
  // emitted nothing the card went away and left an unpainted canvas — light
  // grey in day mode, indistinguishable from a working blank screen. Tell the
  // page when a frame is actually on the canvas.
  if (!announcedFirstFrame) {
    announcedFirstFrame = true;
    setlog({ kind: "firstFrame", width: w, height: h });
  }
}

  // Startup.
function start({canvas, data, key}) {
  if (renderer === null) {
    renderer = new WebGLRenderer("webgl2", canvas);
    const config = {
        codec: "avc1.64001f",
        hardwareAcceleration: "prefer-hardware",
        optimizeForLatency: true
    };
    decoder.configure(config);
    setlog("decoder configured");
  }
  let init = {
      // CarPlay sends no `key` flag (every chunk a keyframe); the RetroArch path
      // sets it per access unit so P-frames decode as deltas.
      type: key === false ? 'delta' : 'key',
      data: data,
      timestamp: frameCount*frameDuration
    }
  let chunk = new EncodedVideoChunk(init);
  decoder.decode(chunk);
  frameCount++;
}
// Listen for the start request.
self.addEventListener("message", message => {
  const m = message.data;
  if (m && m.type === 'setFps') {
    if (m.fps > 0) {
      fps = m.fps;
      frameDuration = (1000 / fps) | 1;
    }
    return;
  }
  // The page is about to wait on a picture again: a fresh /video connection, or
  // its loading card went back up over a socket that is still open (a thawed
  // tab, an unplugged phone). Re-arm the announcement so the next painted frame
  // lifts it.
  // Must be handled before the fallthrough below, which treats any other
  // message as an encoded chunk.
  if (m && m.type === 'expectFrame') {
    announcedFirstFrame = false;
    return;
  }
  start(m);
}, {once: false});
