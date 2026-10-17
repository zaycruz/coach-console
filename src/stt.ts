/**
 * POST /api/stt?lang=en|es|ht  body = one short recorded clip (webm/ogg/mp4, as MediaRecorder makes it)
 *   -> Workers AI Whisper (@cf/openai/whisper-large-v3-turbo) -> { text }
 * Each clip is a standalone file, so the browser never needs its own speech recogniser.
 */
interface Ai { run(model: string, input: unknown): Promise<unknown> }
const WHISPER = "@cf/openai/whisper-large-v3-turbo";
const LANGS = new Set(["en", "es", "ht", "fr"]);
const MAX = 4 * 1024 * 1024;
// Whisper invents these on near-silent clips. (The browser already drops clips with no voice, so keep this list narrow:
// a patient may really say "thank you".)
const PHANTOM = /^(thank you for watching|thanks for watching|you|\.+|subtitles by.*|.*amara\.org.*)[.!]?$/i;

const out = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

function b64(buf: ArrayBuffer) {
  const u = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, Array.from(u.subarray(i, i + 0x8000)));
  return btoa(s);
}

export async function stt(env: { AI: Ai }, req: Request): Promise<Response> {
  const buf = await req.arrayBuffer();
  if (buf.byteLength < 200) return out({ text: "", skipped: "empty clip" });
  if (buf.byteLength > MAX) return out({ error: "clip too large (max 4 MB)" }, 413);
  const lang = new URL(req.url).searchParams.get("lang") || "";
  const audio = b64(buf);
  const run = (language?: string) => env.AI.run(WHISPER, { audio, vad_filter: true, ...(language ? { language } : {}) }) as Promise<{ text?: string }>;
  let r: { text?: string };
  try { r = await run(LANGS.has(lang) ? lang : undefined); }
  catch (e) {
    if (!lang) return out({ error: `transcription failed: ${(e as Error).message}` }, 502);
    try { r = await run(); } catch (e2) { return out({ error: `transcription failed: ${(e2 as Error).message}` }, 502); }
  }
  const text = String((r && r.text) || "").replace(/\s+/g, " ").trim();
  return out({ text: PHANTOM.test(text) ? "" : text, model: WHISPER });
}
