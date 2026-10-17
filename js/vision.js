// Reads a board photo with the Claude API, straight from the browser with the viewer's own key.

const SDK_URL = 'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@0.131.0/+esm';
const MODEL = 'claude-opus-5-5';
const KEY_STORE = 'tilerewind.apiKey';
const N = 15;

export const VISION_PROMPT = `This photo shows a finished game on a standard 15x15 Scrabble board. Transcribe every tile.

How to read it:
- Find the 15x15 grid first. Use the premium squares as landmarks: triple-word squares sit in the four corners and the middle of each edge, and the centre square (row 8, column H) has a star. Count rows and columns carefully so each tile lands on the right square; misplacing a tile by one square breaks every word around it.
- Orient the grid so the letters on most tiles read upright. Correct for perspective or rotation.
- Every horizontal and vertical run of 2 or more tiles is a real English word. Use this to resolve unclear letters, but report what is physically on the board.
- A blank tile has no point value printed on it. If a blank is marked with a letter, or the letter it stands for is clear from the words it is part of, give that letter in lowercase.

Output fields:
- "rows": exactly 15 strings of exactly 15 characters, top row first. "." is an empty square, an uppercase letter is a normal tile, a lowercase letter is a blank tile.
- "unsure": [row, col] pairs (0-based, row 0 at the top, col 0 at the left) for squares you could not read confidently; empty if none.
- "note": one short sentence about photo quality or anything you could not read.`;

const SCHEMA = {
  type: 'object',
  properties: {
    rows: { type: 'array', items: { type: 'string' } },
    unsure: { type: 'array', items: { type: 'array', items: { type: 'integer' } } },
    note: { type: 'string' },
  },
  required: ['rows', 'unsure', 'note'],
  additionalProperties: false,
};

export function getKey() {
  try { return localStorage.getItem(KEY_STORE) || ''; } catch (e) { return ''; }
}
export function setKey(key) {
  try { key ? localStorage.setItem(KEY_STORE, key) : localStorage.removeItem(KEY_STORE); } catch (e) {}
}

// Shrink to what the API actually looks at, fix phone rotation, and send as JPEG.
async function toBase64Jpeg(file) {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const scale = Math.min(1, 1568 / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', 0.9));
  const dataUrl = await new Promise((res, rej) => {
    const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(blob);
  });
  return String(dataUrl).split(',')[1];
}

export class VisionError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

// Turn an API failure into a VisionError with words a player can act on.
function apiError(Anthropic, e, signal) {
  if (e instanceof Anthropic.APIUserAbortError || signal?.aborted) return new VisionError('cancelled', 'Stopped.');
  if (e instanceof Anthropic.AuthenticationError) return new VisionError('auth', 'The API key was rejected. Check it and save it again.');
  if (e instanceof Anthropic.PermissionDeniedError) return new VisionError('auth', 'This API key is not allowed to use the model. Check the key\'s workspace settings.');
  if (e instanceof Anthropic.RateLimitError) return new VisionError('rate', 'Too many requests, or the key hit its spending limit. Wait a minute and try again.');
  if (e instanceof Anthropic.BadRequestError) return new VisionError('bad', 'The API refused the request: ' + e.message);
  if (e instanceof Anthropic.APIConnectionError) return new VisionError('network', 'Could not reach the Claude API. Check your connection and try again.');
  if (e instanceof Anthropic.APIError) return new VisionError('api', `The Claude API returned an error (${e.status}). Try again in a moment.`);
  return e;
}

const EXPLAIN_SCHEMA = {
  type: 'object',
  properties: {
    why: { type: 'array', items: { type: 'string' } },
    weak: { type: 'array', items: { type: 'string' } },
  },
  required: ['why', 'weak'],
  additionalProperties: false,
};

// A short coach's explanation, written only from facts the app measured.
export async function explainMove(facts, apiKey, signal) {
  const { default: Anthropic } = await import(SDK_URL);
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
  const prompt = `You are a friendly Scrabble coach reviewing one move for a club player.

The facts below were measured by the Quackle engine and the Mabble app: scores, Quackle's equity (score plus the value of the tiles kept, plus a board adjustment), the tiles each play keeps, which premium squares each play opens, and the opponent's best replies across randomly sampled racks.

Write two short lists:
- "why": 2 or 3 sentences on why Quackle's choice is better than the player's move.
- "weak": 2 or 3 sentences on the weak points of the player's move.

Rules:
- Use only these facts. Don't mention any word, square, rack, score or percentage that isn't in them, and don't guess at anything else on the board.
- Lead with the reasons that matter most (the biggest numbers). Quote a number when it helps.
- Plain language, no jargon beyond common Scrabble terms (leave, bingo, hook, triple word). One idea per sentence. Be encouraging but honest.

Facts:
${JSON.stringify(facts, null, 1)}`;
  let msg;
  try {
    const stream = client.beta.messages.stream({
      model: MODEL,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      thinking: { type: 'adaptive' },
      output_config: { effort: 'low', format: { type: 'json_schema', schema: EXPLAIN_SCHEMA } },
      messages: [{ role: 'user', content: prompt }],
    }, { signal });
    msg = await stream.finalMessage();
  } catch (e) {
    throw apiError(Anthropic, e, signal);
  }
  if (msg.stop_reason === 'refusal') throw new VisionError('refused', 'Claude declined to write this explanation.');
  if (msg.stop_reason === 'max_tokens') throw new VisionError('cut', 'The explanation was cut short. Try again.');
  const text = msg.content.filter(b => b.type === 'text').map(b => b.text).join('');
  let res;
  try { res = JSON.parse(text); } catch (e) { throw new VisionError('shape', 'The explanation came back in the wrong shape. Try again.'); }
  return { why: (res.why || []).map(String).slice(0, 4), weak: (res.weak || []).map(String).slice(0, 4) };
}

export async function readBoard(file, apiKey, signal) {
  const [{ default: Anthropic }, data] = await Promise.all([import(SDK_URL), toBase64Jpeg(file)]);
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
  let msg;
  try {
    const stream = client.beta.messages.stream({
      model: MODEL,
      max_tokens: 64000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high', format: { type: 'json_schema', schema: SCHEMA } },
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } },
          { type: 'text', text: VISION_PROMPT },
        ],
      }],
    }, { signal });
    msg = await stream.finalMessage();
  } catch (e) {
    if (e instanceof Anthropic.APIUserAbortError || signal?.aborted) throw new VisionError('cancelled', 'Stopped.');
    if (e instanceof Anthropic.AuthenticationError) throw new VisionError('auth', 'The API key was rejected. Check it and save it again.');
    if (e instanceof Anthropic.PermissionDeniedError) throw new VisionError('auth', 'This API key is not allowed to use the model. Check the key\'s workspace settings.');
    if (e instanceof Anthropic.RateLimitError) throw new VisionError('rate', 'Too many requests, or the key hit its spending limit. Wait a minute and try again.');
    if (e instanceof Anthropic.BadRequestError) throw new VisionError('bad', 'The API refused the request: ' + e.message);
    if (e instanceof Anthropic.APIConnectionError) throw new VisionError('network', 'Could not reach the Claude API. Check your connection and try again.');
    if (e instanceof Anthropic.APIError) throw new VisionError('api', `The Claude API returned an error (${e.status}). Try again in a moment.`);
    throw e;
  }
  if (msg.stop_reason === 'refusal') throw new VisionError('refused', 'Claude declined to read this image. Try a different photo.');
  if (msg.stop_reason === 'max_tokens') throw new VisionError('cut', 'The answer was cut short. Try again.');
  const text = msg.content.filter(b => b.type === 'text').map(b => b.text).join('');
  let res;
  try { res = JSON.parse(text); } catch (e) { throw new VisionError('shape', 'The answer came back in the wrong shape. Try again.'); }
  if (!res || !Array.isArray(res.rows) || res.rows.length < 10) throw new VisionError('shape', 'The answer came back in the wrong shape. Try again.');
  return {
    rows: res.rows.slice(0, N).map(r => String(r).replace(/[^a-zA-Z.]/g, '.').padEnd(N, '.').slice(0, N)),
    unsure: (Array.isArray(res.unsure) ? res.unsure : []).filter(p => Array.isArray(p) && p[0] >= 0 && p[0] < N && p[1] >= 0 && p[1] < N),
    note: typeof res.note === 'string' ? res.note : '',
  };
}
