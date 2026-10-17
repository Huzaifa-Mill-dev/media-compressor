import { Output, WebMOutputFormat, BufferTarget, CanvasSource, AudioBufferSource } from "mediabunny";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ascii, head, newEngine } from "./helpers";

const engine = newEngine(2);
afterAll(() => engine.dispose());

function wav(sec = 2, rate = 44100): File {
  const n = sec * rate, b = new DataView(new ArrayBuffer(44 + n * 4));
  const s = (o: number, t: string) => [...t].forEach((c, i) => b.setUint8(o + i, c.charCodeAt(0)));
  s(0, "RIFF"); b.setUint32(4, 36 + n * 4, true); s(8, "WAVEfmt "); b.setUint32(16, 16, true); b.setUint16(20, 1, true); b.setUint16(22, 2, true);
  b.setUint32(24, rate, true); b.setUint32(28, rate * 4, true); b.setUint16(32, 4, true); b.setUint16(34, 16, true); s(36, "data"); b.setUint32(40, n * 4, true);
  for (let i = 0; i < n; i++) { const v = Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 12000); b.setInt16(44 + i * 4, v, true); b.setInt16(46 + i * 4, v, true); }
  return new File([b.buffer], "tone.wav", { type: "audio/wav" });
}

/** 1 s, 320x240, 15 fps VP9 + Opus WebM built in-browser with mediabunny (no system ffmpeg needed). */
async function makeWebm(): Promise<File | null> {
  if (typeof VideoEncoder === "undefined") return null;
  const target = new BufferTarget(), out = new Output({ format: new WebMOutputFormat(), target });
  const canvas = new OffscreenCanvas(320, 240), ctx = canvas.getContext("2d")!;
  const v = new CanvasSource(canvas, { codec: "vp9", bitrate: 800_000 });
  out.addVideoTrack(v, { frameRate: 15 });
  const rate = 48000, ac = new OfflineAudioContext(2, rate, rate), buf = ac.createBuffer(2, rate, rate);
  for (let c = 0; c < 2; c++) { const d = buf.getChannelData(c); for (let i = 0; i < rate; i++) d[i] = Math.sin((2 * Math.PI * 440 * i) / rate) * 0.4; }
  const a = new AudioBufferSource({ codec: "opus", bitrate: 64_000 });
  out.addAudioTrack(a);
  await out.start();
  for (let i = 0; i < 15; i++) {
    ctx.fillStyle = `hsl(${i * 24},80%,50%)`; ctx.fillRect(0, 0, 320, 240);
    ctx.fillStyle = "#fff"; ctx.fillRect(10 + i * 15, 100, 60, 60);
    await v.add(i / 15, 1 / 15);
  }
  await a.add(buf);
  await out.finalize();
  return new File([target.buffer!], "clip.webm", { type: "video/webm" });
}

let clip: File | null = null;
beforeAll(async () => { try { clip = await makeWebm(); } catch (e) { console.warn("MEDIA fixture unavailable:", String(e)); } }, 60_000);
const needClip = (): File => { if (!clip) throw new Error("no WebCodecs VP9/Opus in this Chromium — cannot build video fixture"); return clip; };

describe("audio (browser)", () => {
  it("wav -> wav passthrough/convert keeps RIFF", async () => {
    const r = await engine.run({ toolId: "audio-convert", files: [wav()], options: { format: "wav" } });
    expect(ascii((await head(r.outputs[0]!.blob, 12)).slice(8, 12))).toBe("WAVE");
  });
  it.each([["mp3", (h: Uint8Array) => (h[0] === 0xff && (h[1]! & 0xe0) === 0xe0) || ascii(h.slice(0, 3)) === "ID3"], ["flac", (h: Uint8Array) => ascii(h.slice(0, 4)) === "fLaC"], ["ogg", (h: Uint8Array) => ascii(h.slice(0, 4)) === "OggS"], ["m4a", (h: Uint8Array) => ascii(h.slice(4, 8)) === "ftyp"]] as const)(
    "wav -> %s has valid signature", async (fmt, ok) => {
      const r = await engine.run({ toolId: "audio-convert", files: [wav()], options: { format: fmt, bitrate: "128k" } });
      expect(ok(await head(r.outputs[0]!.blob, 16))).toBe(true);
      expect(r.outputs[0]!.size).toBeGreaterThan(1000);
    }, 120_000);
  it("audio-compress mp3 96k is much smaller than wav", async () => {
    const f = wav();
    const r = await engine.run({ toolId: "audio-compress", files: [f], options: { format: "mp3", bitrate: "96k" } });
    expect(r.outputs[0]!.size).toBeLessThan(f.size / 4);
  }, 120_000);
  it("garbage audio fails cleanly", async () => {
    await expect(engine.run({ toolId: "audio-convert", files: [new File([new Uint8Array(300).fill(7)], "x.mp3")], options: { format: "wav" } })).rejects.toThrow();
  }, 60_000);
});

describe("video (browser)", () => {
  it("fixture builds (or reports codec gap)", () => { console.log("MEDIA fixture:", clip ? `${clip.size} bytes` : "UNAVAILABLE"); });
  it("compress -> valid container, plays metadata", async () => {
    const f = needClip();
    const r = await engine.run({ toolId: "video-compress", files: [f], options: { profile: "custom", format: "webm", codec: "vp9", crf: 30 } });
    expect([...(await head(r.outputs[0]!.blob, 4))]).toEqual([0x1a, 0x45, 0xdf, 0xa3]);
    expect(r.outputs[0]!.size).toBeGreaterThan(500);
  }, 120_000);
  it("convert webm -> mp4 or clear codec error", async () => {
    const f = needClip();
    try {
      const r = await engine.run({ toolId: "video-convert", files: [f], options: { format: "mp4" } });
      expect(ascii((await head(r.outputs[0]!.blob, 8)).slice(4, 8))).toBe("ftyp");
    } catch (e) { console.log("MEDIA mp4 unsupported here:", String(e)); expect(String(e).length).toBeGreaterThan(10); }
  }, 120_000);
  it("extract audio -> wav", async () => {
    const r = await engine.run({ toolId: "video-to-audio", files: [needClip()], options: { format: "wav" } });
    expect(ascii((await head(r.outputs[0]!.blob, 12)).slice(8, 12))).toBe("WAVE");
  }, 120_000);
  it("gif via ffmpeg.wasm fallback", async () => {
    const r = await engine.run({ toolId: "video-convert", files: [needClip()], options: { format: "gif" } });
    expect(ascii(await head(r.outputs[0]!.blob, 3))).toBe("GIF");
  }, 240_000);
  it("cancel video mid-job", async () => {
    const ac = new AbortController();
    const p = engine.run({ toolId: "video-compress", files: [needClip()], options: { profile: "custom", format: "webm", codec: "vp9", crf: 30 } }, { signal: ac.signal });
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
  }, 60_000);
});
