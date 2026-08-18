/**
 * Thin wrapper around the official Anthropic SDK.
 *
 * Two things worth pointing out:
 *
 * 1. Streaming is the default. Anything that can produce a long answer should
 *    stream - it keeps the UI responsive and avoids HTTP timeouts on large
 *    max_tokens values.
 *
 * 2. If ANTHROPIC_API_KEY is not set the module returns a local mock instead
 *    of throwing. That means you can clone this repo, run `npm run dev`, and
 *    see the whole UI work end to end before you have a key. Swap the key in
 *    and the same code path hits the real API.
 */
import Anthropic from '@anthropic-ai/sdk';
import { config, hasClaudeKey } from './config.js';

let client = null;

function getClient() {
  if (!client) {
    client = new Anthropic({ apiKey: config.anthropicApiKey });
  }
  return client;
}

/** System prompt lives in one place so it can be tuned without hunting. */
export const SYSTEM_PROMPT = `You are the assistant built into a note-taking app.

You can see the user's notes when they are included in the message. Use them
when they are relevant and say so; if they don't contain the answer, say that
plainly instead of guessing.

Keep answers focused and brief. Skip preambles like "Certainly" or "Here is".
Use short paragraphs and lists only where they genuinely help.`;

/**
 * Stream a chat completion.
 *
 * @param {{messages: Array, system?: string}} opts
 * @param {(text: string) => void} onText  called for each token chunk
 * @returns {Promise<{text: string, usage: object|null, mocked: boolean}>}
 */
export async function streamChat({ messages, system = SYSTEM_PROMPT }, onText) {
  if (!hasClaudeKey()) {
    return mockStream(messages, onText);
  }

  const stream = getClient().messages.stream({
    model: config.claudeModel,
    max_tokens: config.claudeMaxTokens,
    // Adaptive thinking lets Claude decide how much to reason per request.
    // `effort` is the cost/quality dial - low | medium | high | xhigh | max.
    thinking: { type: 'adaptive' },
    output_config: { effort: config.claudeEffort },
    system,
    messages,
  });

  let text = '';
  for await (const chunk of stream.textStream) {
    text += chunk;
    onText(chunk);
  }

  const final = await stream.finalMessage();
  return { text, usage: final.usage ?? null, mocked: false, stopReason: final.stop_reason };
}

/**
 * Structured extraction: ask Claude for a summary + tags and get back JSON that
 * is guaranteed to match the schema. No regex, no "please reply with only JSON".
 */
export async function summarizeNote({ title, body }) {
  if (!hasClaudeKey()) {
    const words = body.split(/\s+/).filter(Boolean);
    return {
      summary: words.slice(0, 25).join(' ') + (words.length > 25 ? '...' : ''),
      tags: ['demo', 'mock'],
      sentiment: 'neutral',
      mocked: true,
    };
  }

  const response = await getClient().messages.create({
    model: config.claudeModel,
    max_tokens: 1024,
    output_config: {
      effort: 'low',
      format: {
        type: 'json_schema',
        schema: {
          type: 'object',
          properties: {
            summary: { type: 'string', description: 'One or two sentences.' },
            tags: {
              type: 'array',
              items: { type: 'string' },
              description: '2-5 short lowercase topic tags.',
            },
            sentiment: {
              type: 'string',
              enum: ['positive', 'neutral', 'negative'],
            },
          },
          required: ['summary', 'tags', 'sentiment'],
          additionalProperties: false,
        },
      },
    },
    messages: [
      {
        role: 'user',
        content: `Summarise this note and suggest tags.\n\nTitle: ${title}\n\nBody:\n${body}`,
      },
    ],
  });

  const textBlock = response.content.find((b) => b.type === 'text');
  return { ...JSON.parse(textBlock.text), mocked: false };
}

/* -------------------------------------------------------------------------- */
/* Offline mock - only used when no API key is configured.                     */
/* -------------------------------------------------------------------------- */

async function mockStream(messages, onText) {
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const question =
    typeof lastUser?.content === 'string'
      ? lastUser.content
      : (lastUser?.content ?? []).map((c) => c.text ?? '').join(' ');

  const reply =
    `[mock reply - no ANTHROPIC_API_KEY is set, so this text is generated ` +
    `locally instead of by Claude]\n\n` +
    `You asked: "${question.slice(0, 200)}"\n\n` +
    `Once you add a key to .env this exact endpoint streams a real Claude ` +
    `response token by token - the front-end code does not change at all.`;

  let text = '';
  for (const word of reply.split(' ')) {
    const chunk = word + ' ';
    text += chunk;
    onText(chunk);
    await new Promise((r) => setTimeout(r, 18)); // fake typing cadence
  }

  return { text, usage: null, mocked: true, stopReason: 'end_turn' };
}
