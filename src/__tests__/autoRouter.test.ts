import { describe, it, expect } from 'vitest';
import {
  buildAutoModel,
  isAutoModel,
  classifyRequest,
  estimateTokens,
  pickChain,
  compressContents,
  planAutoRoute,
  AUTO_DISPLAY_NAME,
  AUTO_EXTERNAL_NAME,
} from '../proxy/autoRouter';
import type { CustomModel } from '../proxy';

// ─── Fixtures ─────────────────────────────────────────────────────────────

function mk(name: string, provider = 'openrouter'): CustomModel {
  return {
    name: 'models/' + name,
    displayName: name,
    description: '',
    provider,
    apiKey: 'none',
    apiUrl: 'https://example.com/v1/chat/completions',
    externalModelName: name,
  };
}

// gpt-4o-mini: vision-capable, 1M window, matches "mini" quick hint
const gpt4oMini = mk('gpt-4o-mini');
// deepseek-chat: NO vision, 1M window, strong code hint
const deepseek = mk('deepseek-chat');
// claude: vision + 200k window
const claude = mk('claude-sonnet-4', 'anthropic');
const models = [gpt4oMini, deepseek, claude];

const textBody = (t: string): Parameters<typeof classifyRequest>[0] => ({
  contents: [{ role: 'user', parts: [{ text: t }] }],
});

// ─── Virtual model identity ───────────────────────────────────────────────

describe('auto model identity', () => {
  it('builds the virtual Auto model and detects it', () => {
    const auto = buildAutoModel();
    expect(auto.displayName).toBe(AUTO_DISPLAY_NAME);
    expect(auto.externalModelName).toBe(AUTO_EXTERNAL_NAME);
    expect(isAutoModel(auto)).toBe(true);
    expect(isAutoModel(gpt4oMini)).toBe(false);
    expect(isAutoModel(deepseek)).toBe(false);
  });
});

// ─── Classification ───────────────────────────────────────────────────────

describe('classifyRequest', () => {
  it('detects vision from inlineData image parts', () => {
    const body = {
      contents: [
        {
          role: 'user',
          parts: [{ text: 'what is this?' }, { inlineData: { mimeType: 'image/png', data: 'x' } }],
        },
      ],
    };
    expect(classifyRequest(body).task).toBe('vision');
  });

  it('detects vision from image fileData mime types', () => {
    const body = {
      contents: [{ role: 'user', parts: [{ fileData: { mimeType: 'image/jpeg', fileUri: 'u' } }] }],
    };
    expect(classifyRequest(body).task).toBe('vision');
  });

  it('detects code from fenced blocks', () => {
    expect(classifyRequest(textBody('```python\ndef add(a,b): return a+b\n```\ntest it')).task).toBe('code');
  });

  it('detects code from keywords', () => {
    expect(classifyRequest(textBody('the traceback says TypeError, fix my function')).task).toBe('code');
  });

  it('classifies short input as quick', () => {
    expect(classifyRequest(textBody('hi')).task).toBe('quick');
  });

  it('classifies long input', () => {
    expect(classifyRequest(textBody('x'.repeat(9000))).task).toBe('long');
  });

  it('defaults to chat', () => {
    expect(classifyRequest(textBody('tell me about space exploration '.repeat(10))).task).toBe('chat');
  });

  it('#model: tag forces a specific model', () => {
    const cls = classifyRequest(textBody('#model:claude-sonnet-4 write tests please'));
    expect(cls.task).toBe('forced');
    expect(cls.forcedModel).toBe('claude-sonnet-4');
  });

  it('#:code tag forces code task over other signals', () => {
    expect(classifyRequest(textBody('draw me a picture #:code')).task).toBe('code');
  });
});

// ─── Estimation ───────────────────────────────────────────────────────────

describe('estimateTokens', () => {
  it('estimates ~chars/4 plus headroom for text', () => {
    expect(estimateTokens(textBody('a'.repeat(400)))).toBe(100 + 2048);
  });

  it('charges a flat cost per image part', () => {
    const body = {
      contents: [
        {
          role: 'user',
          parts: [{ text: 'look' }, { inlineData: { mimeType: 'image/png', data: 'z' } }],
        },
      ],
    };
    expect(estimateTokens(body)).toBe(1 + 1100 + 2048);
  });
});

// ─── Ranking ──────────────────────────────────────────────────────────────

describe('pickChain', () => {
  it('routes vision to vision-capable models only', () => {
    const body = {
      contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'image/png', data: 'z' } }] }],
    };
    const chain = pickChain(models, body);
    expect(chain).not.toContain(deepseek);
    expect(chain.length).toBeGreaterThan(0);
  });

  it('routes code to the code-family model first', () => {
    const chain = pickChain(models, textBody('```js\nconst x = 1;\n```\nrefactor this'));
    expect(chain[0]).toBe(deepseek);
  });

  it('routes quick chats to a fast/mini model first', () => {
    const chain = pickChain(models, textBody('hi'));
    expect(chain[0]).toBe(gpt4oMini);
  });

  it('honors #model: forced tags exactly', () => {
    const chain = pickChain(models, textBody('#model:claude-sonnet-4 hello'));
    expect(chain).toEqual([claude]);
  });

  it('returns a fallback chain with more than one model', () => {
    const chain = pickChain(models, textBody('tell me about space exploration '.repeat(6)));
    expect(chain.length).toBeGreaterThanOrEqual(2);
    expect(chain[0]).not.toBe(chain[1]);
  });

  it('excludes the auto model itself from candidates', () => {
    const chain = pickChain([...models, buildAutoModel()], textBody('hi'));
    expect(chain.every((m) => !isAutoModel(m))).toBe(true);
  });
});

// ─── Compression ──────────────────────────────────────────────────────────

describe('compressContents', () => {
  it('keeps recent turns verbatim and condenses old ones', () => {
    const turns = Array.from({ length: 20 }, (_, i) => ({
      role: 'user',
      parts: [{ text: `turn ${i} ` + 'y'.repeat(100) }],
    }));
    const last = turns[turns.length - 1];
    const out = compressContents({ contents: turns });

    expect(out.contents!.length).toBe(7); // digest + 6 recent
    expect(JSON.stringify(out.contents![out.contents!.length - 1])).toBe(JSON.stringify(last));
    expect((out.contents![0].parts![0] as { text: string }).text).toContain(
      '[Compressed earlier conversation (14 turns)',
    );
  });

  it('is a no-op when the conversation is already short', () => {
    const body = { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] };
    expect(compressContents(body)).toBe(body);
  });
});

// ─── Full plan ────────────────────────────────────────────────────────────

describe('planAutoRoute', () => {
  it('returns a servable chain for normal requests', () => {
    const plan = planAutoRoute(models, textBody('```py\ndef f(): pass\n```\ntest this'));
    expect(plan.task).toBe('code');
    expect(plan.chain.length).toBeGreaterThan(0);
    expect(plan.compressed).toBe(false);
  });

  it('compresses when nothing fits and still yields a chain', () => {
    const turns = Array.from({ length: 30 }, () => ({
      role: 'user',
      parts: [{ text: 'y'.repeat(150000) }],
    }));
    const plan = planAutoRoute(models, { contents: turns });
    expect(plan.compressed).toBe(true);
    expect(plan.chain.length).toBeGreaterThan(0);
    expect(plan.body.contents!.length).toBeLessThan(30);
  });
});
