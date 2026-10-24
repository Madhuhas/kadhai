import { estimateTokens } from './util.js';

/**
 * kind: rate_limit | auth | not_found | too_large | bad_request | server |
 *       network | timeout | empty
 * The dispatcher decides what to do with a route purely from this field.
 */
export class ProviderError extends Error {
  constructor(message, { kind, status = 0, retryAfterMs = null } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.kind = kind;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Turn an HTTP failure into the `kind` the dispatcher acts on. Providers
 * disagree on status codes - Gemini answers a wrong key with 400, Groq a retired
 * model with 400 - so a 400 is read by what it says, not just its number.
 */
export function classify(status, body = '') {
  // Groq also answers 429 when one request asks for more than the model's per-minute allowance:
  // waiting cannot help that request, so it goes to the next route with no cooldown.
  if (status === 429) return /request too large/i.test(body) ? 'too_large' : 'rate_limit';
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'not_found';
  if (status === 413) return 'too_large';
  if (status === 400 || status === 422) {
    if (/api[ _-]?key|invalid.{0,20}credential|unauthori[sz]ed/i.test(body)) return 'auth';
    if (/model.{0,60}(not found|does not exist|not supported|decommission|deprecat)|(unknown|invalid) model/i.test(body)) return 'not_found';
    if (/context.{0,20}(length|window)|too (long|large|many tokens)|reduce the length/i.test(body)) return 'too_large';
    if (/quota|rate.?limit|resource.?exhausted/i.test(body)) return 'rate_limit';
    return 'bad_request';
  }
  return 'server';
}

function retryAfter(res, body) {
  const header = res.headers.get('retry-after');
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds)) return seconds * 1000;
    const date = Date.parse(header);
    if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  }
  // Gemini: "retryDelay": "34s"   Groq: "Please try again in 1m7.6s" / "in 250ms"
  let m = /retryDelay"?\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(body);
  if (m) return Number(m[1]) * 1000;
  m = /try again in\s+(\d+(?:\.\d+)?)ms/i.exec(body);
  if (m) return Number(m[1]);
  m = /try again in\s+(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?/i.exec(body);
  if (m && (m[1] || m[2] || m[3])) {
    return (Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0)) * 1000;
  }
  return null;
}

/**
 * Some providers (Groq, Cerebras) report what is left of the quota in response
 * headers, e.g. x-ratelimit-remaining-requests[-day]. Others say nothing.
 */
function readQuota(headers) {
  const quota = {};
  for (const [name, value] of headers) {
    const match = /^x-ratelimit-(remaining|limit)-(requests|tokens)/i.exec(name);
    const number = Number(value);
    if (!match || value === '' || !Number.isFinite(number)) continue;
    const key = `${match[1].toLowerCase()}${match[2].toLowerCase() === 'requests' ? 'Requests' : 'Tokens'}`;
    quota[key] ??= number;
  }
  return Object.keys(quota).length ? quota : null;
}

function errorText(body) {
  try {
    const parsed = JSON.parse(body);
    const err = Array.isArray(parsed) ? parsed[0]?.error : parsed.error;
    const message = typeof err === 'string' ? err : err?.message;
    if (message) return String(message).slice(0, 300);
  } catch {
    // Not JSON: fall through to the raw text.
  }
  return body.replace(/\s+/g, ' ').slice(0, 300) || 'no details';
}

function finish(route, req, { text, reasoning, usage, finishReason, quota = null }) {
  if (!text.trim()) throw new ProviderError(`${route.label} returned an empty answer`, { kind: 'empty' });
  return {
    text,
    reasoning,
    finishReason,
    quota,
    usage: {
      promptTokens: usage?.prompt_tokens ?? estimateTokens(req.messages.map((m) => m.content).join('\n')),
      completionTokens: usage?.completion_tokens ?? estimateTokens(text + reasoning),
      estimated: !usage,
    },
  };
}

async function send(route, req, body, { signal, onDelta, timeoutMs }) {
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort(signal.reason);
  if (signal?.aborted) onAbort();
  signal?.addEventListener('abort', onAbort, { once: true });

  // Idle timeout: re-armed on every chunk, so slow-but-alive streams survive.
  let timedOut = false;
  let timer;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, timeoutMs);
  };

  try {
    arm();
    const headers = { 'content-type': 'application/json' };
    if (route.key) headers.authorization = `Bearer ${route.key}`;
    const res = await fetch(`${route.baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });

    if (!res.ok) {
      const raw = (await res.text().catch(() => '')).slice(0, 4000);
      throw new ProviderError(`${route.label} HTTP ${res.status}: ${errorText(raw)}`, {
        kind: classify(res.status, raw),
        status: res.status,
        retryAfterMs: retryAfter(res, raw),
      });
    }

    const quota = readQuota(res.headers);
    if (!(res.headers.get('content-type') ?? '').includes('text/event-stream')) {
      const data = await res.json();
      const message = data.choices?.[0]?.message ?? {};
      return finish(route, req, {
        text: message.content ?? '',
        reasoning: message.reasoning ?? message.reasoning_content ?? '',
        usage: data.usage,
        finishReason: data.choices?.[0]?.finish_reason ?? null,
        quota,
      });
    }

    const decoder = new TextDecoder();
    let buffer = '';
    let text = '';
    let reasoning = '';
    let usage = null;
    let finishReason = null;

    for await (const chunk of res.body) {
      arm();
      buffer += decoder.decode(chunk, { stream: true });
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let event;
        try {
          event = JSON.parse(payload);
        } catch {
          continue;
        }
        if (event.error) {
          const message = event.error.message ?? String(event.error);
          const limited = event.error.code === 429 || /rate.?limit|quota|exhausted/i.test(message);
          throw new ProviderError(`${route.label} stream error: ${message}`, {
            kind: limited ? 'rate_limit' : 'server',
          });
        }
        usage = event.usage ?? event.x_groq?.usage ?? usage;
        const choice = event.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta ?? {};
        const thought = delta.reasoning ?? delta.reasoning_content;
        if (thought) {
          reasoning += thought;
          onDelta?.({ type: 'reasoning', text: thought });
        }
        if (delta.content) {
          text += delta.content;
          onDelta?.({ type: 'text', text: delta.content });
        }
        if (choice.finish_reason) finishReason = choice.finish_reason;
      }
    }
    return finish(route, req, { text, reasoning, usage, finishReason, quota });
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    if (signal?.aborted) throw err;
    throw new ProviderError(
      timedOut ? `${route.label} timed out` : `${route.label} network error: ${err.cause?.code ?? err.message}`,
      { kind: timedOut ? 'timeout' : 'network' },
    );
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/** One streaming chat completion against one route. Throws ProviderError on any failure. */
export async function chatCompletion(route, req, opts = {}) {
  // What this route turned out not to accept, learned the first time it said so (see below).
  const quirks = (route.quirks ??= {});
  const build = () => {
    const body = { model: route.model, messages: req.messages, stream: true };
    if (!quirks.noTemperature) body.temperature = req.temperature ?? 0.2;
    body[quirks.completionTokens ? 'max_completion_tokens' : 'max_tokens'] = req.maxTokens;
    if (!quirks.bare) body.stream_options = { include_usage: true };
    if (req.json && !quirks.bare) body.response_format = { type: 'json_object' };
    return body;
  };

  try {
    return await send(route, req, build(), opts);
  } catch (err) {
    if (err.kind !== 'bad_request') throw err;
    // Servers that speak this dialect differ at the edges. Newer reasoning models want
    // max_completion_tokens and refuse a temperature; some servers reject the optional extras,
    // and strict JSON mode can fail validation. Read what it objected to, adapt, and try once more.
    const learned = { ...quirks };
    if (/max_completion_tokens/.test(err.message)) learned.completionTokens = true;
    if (/temperature/i.test(err.message)) learned.noTemperature = true;
    if (learned.completionTokens === quirks.completionTokens && learned.noTemperature === quirks.noTemperature) learned.bare = true;
    Object.assign(quirks, learned);
    try {
      return await send(route, req, build(), opts);
    } catch (again) {
      // Dropping the extras did not help: keep them for next time, the fault was elsewhere.
      if (again.kind === 'bad_request') quirks.bare = false;
      throw again;
    }
  }
}
