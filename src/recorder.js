import * as THREE from 'three';
import { Muxer, ArrayBufferTarget } from 'mp4-muxer';

export function makeCameraPath(mode, { current, orbitDeg = 360, keyframes = [] }) {
  if (mode === 'keyframes' && keyframes.length >= 2) {
    // Smooth Catmull-Rom path through the saved views (positions and look-at targets)
    const pos = new THREE.CatmullRomCurve3(keyframes.map((k) => k.pos.clone()), false, 'centripetal');
    const tgt = new THREE.CatmullRomCurve3(keyframes.map((k) => k.target.clone()), false, 'centripetal');
    return (u) => {
      const e = u * u * (3 - 2 * u); // ease in/out
      return { pos: pos.getPoint(e), target: tgt.getPoint(e) };
    };
  }
  if (mode === 'keyframes' && keyframes.length === 1) {
    return () => ({ pos: keyframes[0].pos.clone(), target: keyframes[0].target.clone() });
  }
  if (mode === 'orbit') {
    const off = current.pos.clone().sub(current.target);
    return (u) => {
      const a = THREE.MathUtils.degToRad(orbitDeg) * u;
      const o = off.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), a);
      return { pos: current.target.clone().add(o), target: current.target.clone() };
    };
  }
  return () => ({ pos: current.pos.clone(), target: current.target.clone() });
}

async function pickCodec(width, height, fps, bitrate) {
  const candidates = [
    { codec: 'avc1.640033', mux: 'avc' }, // H.264 High L5.1
    { codec: 'avc1.4d0034', mux: 'avc' },
    { codec: 'vp09.00.51.08', mux: 'vp9' },
  ];
  for (const c of candidates) {
    const config = { codec: c.codec, width, height, bitrate, framerate: fps };
    try {
      const s = await VideoEncoder.isConfigSupported(config);
      if (s.supported) return { config, mux: c.mux };
    } catch {}
  }
  return null;
}

export async function recordVideo({
  glCanvas,
  width,
  height,
  fps = 30,
  frames = 150,
  renderFrame,
  drawOverlay,
  onProgress,
  signal,
}) {
  const cv = document.createElement('canvas');
  cv.width = width;
  cv.height = height;
  const ctx = cv.getContext('2d');

  const compose = (i, u) => {
    ctx.drawImage(glCanvas, 0, 0, width, height);
    if (drawOverlay) drawOverlay(ctx, i, u, width, height);
  };

  const bitrate = Math.round(width * height * fps * 0.15);

  if ('VideoEncoder' in window) {
    const picked = await pickCodec(width, height, fps, bitrate);
    if (picked) {
      const target = new ArrayBufferTarget();
      const muxer = new Muxer({
        target,
        video: { codec: picked.mux, width, height, frameRate: fps },
        fastStart: 'in-memory',
      });
      let failure = null;
      const enc = new VideoEncoder({
        output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
        error: (e) => { failure = e; },
      });
      enc.configure(picked.config);

      for (let i = 0; i < frames; i++) {
        if (signal?.aborted) break;
        if (failure) throw failure;
        const u = frames > 1 ? i / (frames - 1) : 0;
        await renderFrame(i, u);
        compose(i, u);

        const vf = new VideoFrame(cv, {
          timestamp: Math.round((i * 1e6) / fps),
          duration: Math.round(1e6 / fps),
        });
        enc.encode(vf, { keyFrame: i % (fps * 2) === 0 });
        vf.close();

        while (enc.encodeQueueSize > 4) await new Promise((r) => setTimeout(r, 1));
        onProgress?.(i + 1, frames);
        if (i % 4 === 0) await new Promise((r) => setTimeout(r, 0));
      }

      await enc.flush();
      enc.close();
      muxer.finalize();
      return { blob: new Blob([target.buffer], { type: 'video/mp4' }), ext: 'mp4' };
    }
  }

  // Fallback: MediaRecorder WebM
  const stream = cv.captureStream(0);
  const track = stream.getVideoTracks()[0];
  const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((m) =>
    MediaRecorder.isTypeSupported(m)
  );
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: bitrate });
  const chunks = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const done = new Promise((r) => (rec.onstop = r));
  rec.start();

  const t0 = performance.now();
  for (let i = 0; i < frames; i++) {
    if (signal?.aborted) break;
    const u = frames > 1 ? i / (frames - 1) : 0;
    await renderFrame(i, u);
    compose(i, u);
    track.requestFrame();
    onProgress?.(i + 1, frames);
    const wait = t0 + ((i + 1) * 1000) / fps - performance.now();
    await new Promise((r) => setTimeout(r, Math.max(0, wait)));
  }
  rec.stop();
  await done;
  return { blob: new Blob(chunks, { type: 'video/webm' }), ext: 'webm' };
}
