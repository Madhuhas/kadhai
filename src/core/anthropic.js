import { ProviderError, classify } from './providers.js';
import { estimateTokens } from './util.js';

export const ANTHROPIC_VERSION = '2023-06-01';
/** How a key is presented to the Claude API (it is not a Bearer token). */
export const anthropicHeaders = (key) => ({ 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION });

// Thinking is always on for the current Claude models and shares the output budget with the answer,
// so the small ceiling that suits the free tiers would cut answers off mid-file.
const MIN_OUTPUT_TOKENS = 16000;
const OVERLOAD_COOLDOWN_MS = 30000;

/**
 * Claude API errors as the `kind` the dispatcher acts on. The error `type` in the body is the
 * authority; the status code is the fallback.
 *   402 billing / 403 permission -> "unavailable": the route is switched off with the reason shown,
 *   because retrying cannot help until the user tops up or changes the key.
 */
export function classifyAnthropic(status, type = '', message = '') {
  if (type === 'rate_limit_error' || status === 429) return 'rate_limit';
  if (type === 'overloaded_error' || status === 529) return 'rate_limit';
  if (type === 'authentication_error' || status === 401) return 'auth';
  if (type === 'billing_error' || status === 402) return 'unavailable';
  if (type === 'permission_error' || status === 403) return 'unavailable';
  if (type === 'not_found_error' || status === 404) return 'not_found';
  if (type === 'request_too_large' || status === 413) return 'too_large';
  if (status === 400) return classify(400, message);
  return 'server';
}

function failure(route, status, raw, retryAfterHeader = null) {
  let type = '';
  let message = raw.replace(/\s+/g, ' ').slice(0, 300) || 'no details';
  try {
    const parsed = JSON.parse(raw);
    type = parsed.error?.type ?? '';
    message = String(parsed.error?.message ?? message).slice(0, 300);
  } catch {
    // Not JSON: the raw text is the message.
  }
  const kind = classifyAnthropic(status, type, message);
  const seconds = Number(retryAfterHeader);
  const retryAfterMs = Number.isFinite(seconds) && retryAfterHeader !== null && retryAfterHeader !== '' ? seconds * 1000 : type === 'overloaded_error' || status === 529 ? OVERLOAD_COOLDOWN_MS : null;
  const why = kind === 'unavailable' ? (status === 402 || type === 'billing_error' ? `billing problem - ${message}` : `not allowed for this key - ${message}`) : `HTTP ${status}: ${message}`;
  return new ProviderError(`${route.label} ${why}`, { kind, status, retryAfterMs });
}

/**
 * One streaming answer from the Claude Messages API, spoken natively (not through an
 * OpenAI-compatible shim). Same contract as chatCompletion: resolves with
 * { text, reasoning, finishReason, usage, quota }, throws ProviderError.
 *
 * What is deliberately not sent: `temperature` (rejected by the current models) and `thinking`
 * (left to each model's default). A policy refusal arrives as a normal reply with
 * stop_reason "refusal"; it is reported as "this route cannot serve this request", so the
 * dispatcher moves to the next route - Kadhai's own failover does the job of a fallback model.
 */
export async function anthropicCompletion(route, req, { signal, onDelta, timeoutMs = 60000 } = {}) {
  const system = req.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const messages = req.messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role, content: m.content }));
  // There is no JSON mode to switch on, and no prefill: the instruction does the work, and the reply is parsed tolerantly.
  if (req.json && messages.length) messages[messages.length - 1] = { ...messages.at(-1), content: `${messages.at(-1).content}\n\nReply with the JSON object only: no prose before or after it, no code fence.` };
  const body = { model: route.model, max_tokens: Math.max(req.maxTokens ?? 0, MIN_OUTPUT_TOKENS), stream: true, messages };
  if (system) body.system = system;

  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort(signal.reason);
  if (signal?.aborted) onAbort();
  signal?.addEventListener('abort', onAbort, { once: true });
  // Idle timeout, re-armed on every chunk. Generous: a model that is thinking sends nothing for a while.
  let timedOut = false;
  let timer;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, Math.max(timeoutMs, 180000));
  };

  try {
    arm();
    const res = await fetch(`${route.baseUrl}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...anthropicHeaders(route.key) },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) throw failure(route, res.status, (await res.text().catch(() => '')).slice(0, 4000), res.headers.get('retry-after'));

    const decoder = new TextDecoder();
    let buffer = '';
    let text = '';
    let reasoning = '';
    let stopReason = null;
    let refusal = null;
    const usage = { input: null, output: null };

    for await (const chunk of res.body) {
      arm();
      buffer += decoder.decode(chunk, { stream: true });
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith('data:')) continue;
        let event;
        try {
          event = JSON.parse(line.slice(5).trim());
        } catch {
          continue;
        }
        if (event.type === 'error') throw failure(route, 0, JSON.stringify(event));
        if (event.type === 'message_start') {
          const u = event.message?.usage ?? {};
          // Cached input is still input the prompt contained.
          usage.input = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
        } else if (event.type === 'content_block_delta') {
          const delta = event.delta ?? {};
          if (delta.type === 'text_delta' && delta.text) {
            text += delta.text;
            onDelta?.({ type: 'text', text: delta.text });
          } else if (delta.type === 'thinking_delta' && delta.thinking) {
            reasoning += delta.thinking;
            onDelta?.({ type: 'reasoning', text: delta.thinking });
          }
        } else if (event.type === 'message_delta') {
          if (event.delta?.stop_reason) stopReason = event.delta.stop_reason;
          if (event.delta?.stop_details) refusal = event.delta.stop_details;
          if (event.usage?.output_tokens != null) usage.output = event.usage.output_tokens;
        }
      }
    }

    if (stopReason === 'refusal') {
      throw new ProviderError(`${route.label} declined this request${refusal?.category ? ` (${refusal.category})` : ''}`, { kind: 'bad_request' });
    }
    if (!text.trim()) throw new ProviderError(`${route.label} returned an empty answer`, { kind: 'empty' });
    return {
      text,
      reasoning,
      // "length" is what the rest of Kadhai calls an answer cut off by the output limit.
      finishReason: stopReason === 'max_tokens' ? 'length' : (stopReason ?? 'stop'),
      quota: null,
      usage: {
        promptTokens: usage.input ?? estimateTokens(system + messages.map((m) => m.content).join('\n')),
        completionTokens: usage.output ?? estimateTokens(text + reasoning),
        estimated: usage.input == null,
      },
    };
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    if (signal?.aborted) throw err;
    throw new ProviderError(timedOut ? `${route.label} timed out` : `${route.label} network error: ${err.cause?.code ?? err.message}`, { kind: timedOut ? 'timeout' : 'network' });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}
