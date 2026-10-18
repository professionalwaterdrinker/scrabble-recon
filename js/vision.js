// Asks the Claude API to explain a move, straight from the browser with the viewer's own key.

const SDK_URL = 'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@0.131.0/+esm';
const MODEL = 'claude-opus-5-5';
const KEY_STORE = 'tilerewind.apiKey';

export function getKey() {
  try { return localStorage.getItem(KEY_STORE) || ''; } catch (e) { return ''; }
}
export function setKey(key) {
  try { key ? localStorage.setItem(KEY_STORE, key) : localStorage.removeItem(KEY_STORE); } catch (e) {}
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
