// Runs in the headless browser page, ahead of the director script (recorder.js serves it). Not imported by Node.
// REC.run steps the game frame by frame, so the video is smooth however slow the machine is. Frames and the game's
// own WebAudio (through an OfflineAudioContext, suspended at every frame time) are encoded in the page with WebCodecs
// and muxed into MP4 (H.264 + AAC/Opus), or WebM (VP9 + Opus) where H.264 is unavailable.
/* global Mp4Muxer, WebMMuxer */
const REC = (() => {
  const query = new URLSearchParams(location.search);
  const post = async (path, body, headers = {}) => {   // a busy machine can drop a request now and then
    for (let k = 0; ; k++) {
      try { const r = await fetch(path, { method: 'POST', body, headers }); if (r.ok) return; } catch (e) { if (k >= 4) throw e; }
      await new Promise(r => setTimeout(r, 200 * (k + 1)));
    }
  };
  const log = s => post('/__log', String(s)).catch(() => {});
  addEventListener('error', e => log('ERR ' + e.message));
  addEventListener('unhandledrejection', e => log('ERR ' + (e.reason && e.reason.stack || e.reason)));

  // Without the in-game marker the page keeps its own loop: hold its animation frames and clock, so REC.advance
  // moves the game forward exactly one video frame at a time.
  const clock = { now: 0, queue: [] };
  if (window.__recVirtual) {
    const start = performance.now(), dateStart = Date.now();
    performance.now = () => clock.now;
    Date.now = () => dateStart + clock.now;
    requestAnimationFrame = callback => { clock.queue.push(callback); return clock.queue.length; };
    cancelAnimationFrame = () => {};
    void start;
  }

  async function pickVideo(width, height, bitrate, fps) {
    const options = [['mp4', 'avc1.640028'], ['mp4', 'avc1.4d0028'], ['mp4', 'avc1.42002a'], ['webm', 'vp09.00.10.08'], ['webm', 'vp8']];
    for (const [container, codec] of options) {
      for (const bitrateMode of ['constant', undefined]) {   // constant keeps the file near the budget; not every encoder offers it
        const config = { codec, width, height, bitrate, framerate: fps, ...(bitrateMode ? { bitrateMode } : {}), ...(codec.startsWith('avc1') ? { avc: { format: 'avc' } } : {}) };
        try { if ((await VideoEncoder.isConfigSupported(config)).supported) return { container, config }; } catch (e) { /* next */ }
      }
    }
    throw new Error('This browser cannot encode video (no WebCodecs H.264/VP9).');
  }
  async function pickAudio(container, sampleRate) {
    const codecs = container === 'mp4' ? ['mp4a.40.2', 'opus'] : ['opus'];
    for (const codec of codecs) {
      const config = { codec, sampleRate, numberOfChannels: 2, bitrate: 96000 };
      try { if ((await AudioEncoder.isConfigSupported(config)).supported) return config; } catch (e) { /* next */ }
    }
    return null;
  }

  // Game audio is often mixed quietly: bring it near normal video loudness, keep peaks under 0.9, fade the last 0.6 s.
  function level(buffer) {
    const channels = [...Array(buffer.numberOfChannels)].map((_, c) => buffer.getChannelData(c));
    let sum = 0, peak = 0;
    for (const data of channels) for (let i = 0; i < data.length; i++) { sum += data[i] * data[i]; peak = Math.max(peak, Math.abs(data[i])); }
    const rms = Math.sqrt(sum / Math.max(1, channels.length * buffer.length));
    const gain = rms > 1e-5 ? Math.min(0.12 / rms, peak > 0 ? 0.9 / peak : 1, 8) : 1;
    const fade = Math.min(buffer.length, Math.round(buffer.sampleRate * 0.6));
    for (const data of channels) for (let i = 0; i < data.length; i++) {
      const tail = data.length - i;
      data[i] = Math.max(-1, Math.min(1, data[i] * gain * (tail < fade ? tail / fade : 1)));
    }
    return rms > 1e-5;
  }

  return {
    width: +query.get('w'), height: +query.get('h'), arg: query.get('arg') || '', log,
    /** Step the page's own loop (no in-game marker): run its held animation frames at the next video frame time. */
    advance(ms) {
      clock.now += ms;
      const due = clock.queue.splice(0);
      for (const callback of due) callback(clock.now);
    },
    /** Save a PNG of the canvas (store screenshots), e.g. REC.shot('boss', cv). */
    async shot(name, canvas) {
      const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
      await post('/__shot?name=' + encodeURIComponent(name), blob);
    },
    async run(o) {
      const fps = o.fps || 30, frames = Math.round(o.seconds * fps), rate = 48000, canvas = o.canvas;
      // The size budget (?limit bytes, ?scale after an oversized take) spread over the real length, minus 96 kbps audio.
      const bitrate = Math.max(250000, Math.min(8000000, Math.floor(((+query.get('limit') || 5242880) * 8 * 0.85 / o.seconds - (o.audio ? 96000 : 0)) * (+query.get('scale') || 1))));
      const ac = o.audio ? new OfflineAudioContext(2, Math.ceil(o.seconds * rate), rate) : null;
      if (o.setup) await o.setup(ac);
      const width = canvas.width & ~1, height = canvas.height & ~1;
      const video = await pickVideo(width, height, bitrate, fps);
      const chunks = [];
      const encoder = new VideoEncoder({ output: (chunk, meta) => chunks.push({ kind: 'video', chunk, meta }), error: e => log('ERR video ' + e.message) });
      encoder.configure(video.config);
      let shown = 0;
      const one = async i => {
        await o.step(i, i / fps);
        // A copy of what is drawn now: a frame made straight from the canvas can keep showing an earlier picture
        // while no animation frame runs.
        const bitmap = await createImageBitmap(canvas, 0, 0, width, height);
        const frame = new VideoFrame(bitmap, { timestamp: Math.round(i * 1e6 / fps), duration: Math.round(1e6 / fps) });
        encoder.encode(frame, { keyFrame: i % (fps * 2) === 0 });
        frame.close(); bitmap.close();
        while (encoder.encodeQueueSize > 8) await new Promise(r => setTimeout(r, 5));
        if (i - shown >= fps) { shown = i; log('frame ' + i + ' / ' + frames); }
      };
      let buffer = null;
      if (ac) {   // the audio clock stops at every frame time, so each sound lands on its frame
        let i = 1;
        const tick = async () => { await one(i); i++; if (i < frames) ac.suspend(i / fps).then(tick); ac.resume(); };
        await one(0);
        ac.suspend(1 / fps).then(tick);
        buffer = await ac.startRendering();
      } else for (let i = 0; i < frames; i++) await one(i);
      await encoder.flush(); encoder.close();

      const audio = buffer && level(buffer) ? await pickAudio(video.container, rate) : null;
      if (audio) {
        const audioEncoder = new AudioEncoder({ output: (chunk, meta) => chunks.push({ kind: 'audio', chunk, meta }), error: e => log('ERR audio ' + e.message) });
        audioEncoder.configure(audio);
        const left = buffer.getChannelData(0), right = buffer.getChannelData(1), step = 1024;
        for (let at = 0; at < buffer.length; at += step) {
          const n = Math.min(step, buffer.length - at), data = new Float32Array(n * 2);
          data.set(left.subarray(at, at + n), 0); data.set(right.subarray(at, at + n), n);
          const piece = new AudioData({ format: 'f32-planar', sampleRate: rate, numberOfFrames: n, numberOfChannels: 2, timestamp: Math.round(at * 1e6 / rate), data });
          audioEncoder.encode(piece); piece.close();
        }
        await audioEncoder.flush(); audioEncoder.close();
      }
      const Lib = video.container === 'mp4' ? Mp4Muxer : WebMMuxer;
      const codec = video.container === 'mp4' ? (video.config.codec.startsWith('avc1') ? 'avc' : 'vp9') : (video.config.codec.startsWith('vp09') ? 'V_VP9' : 'V_VP8');
      const target = new Lib.ArrayBufferTarget();
      const muxer = new Lib.Muxer({ target, video: { codec, width, height, frameRate: fps },
        ...(audio ? { audio: { codec: video.container === 'mp4' ? (audio.codec === 'opus' ? 'opus' : 'aac') : 'A_OPUS', sampleRate: rate, numberOfChannels: 2 } } : {}),
        ...(video.container === 'mp4' ? { fastStart: 'in-memory' } : {}), firstTimestampBehavior: 'offset' });
      chunks.sort((a, b) => a.chunk.timestamp - b.chunk.timestamp || (a.kind === 'video' ? -1 : 1));
      for (const { kind, chunk, meta } of chunks) kind === 'video' ? muxer.addVideoChunk(chunk, meta) : muxer.addAudioChunk(chunk, meta);
      muxer.finalize();
      await post('/__video', target.buffer, { 'x-container': video.container, 'x-codec': video.config.codec, 'x-audio': audio ? audio.codec : '', 'x-frames': String(frames), 'x-size': `${width}x${height}` });
    },
  };
})();
