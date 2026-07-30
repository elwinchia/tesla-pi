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
      setlog("decode", e);
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

function renderAnimationFrame() {
  renderer.draw(pendingFrame);
  pendingFrame = null;
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
      // CarPlay sends no `key` flag (every chunk a keyframe); the Android path
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
  start(m);
}, {once: false});
