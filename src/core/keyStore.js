import fs from 'node:fs';
import crypto from 'node:crypto';
import { vaultFor } from './vault.js';
import { anthropicHeaders } from './anthropic.js';

/**
 * API keys and model lists entered in the dashboard. They live in one local,
 * git-ignored JSON file next to .env, and are merged with whatever .env
 * provides. Keys are write-only from the browser's point of view: once saved
 * they are only ever sent to their own provider, never back to the UI. On disk
 * each key is encrypted (see vault.js); a key typed into the file by hand is
 * read as it is and encrypted the next time the file is saved.
 */

const asLists = (value) =>
  Object.fromEntries(
    Object.entries(value && typeof value === 'object' ? value : {})
      .filter(([, list]) => Array.isArray(list))
      .map(([id, list]) => [id, list.map(String).filter(Boolean)]),
  );

/** Which subscription CLIs are switched on: `{ id: true }`. */
const flags = (value) => Object.fromEntries(Object.entries(value && typeof value === 'object' ? value : {}).filter(([, on]) => on === true));

/** Endpoints the user added: any server that speaks the OpenAI dialect. */
const endpoints = (value) =>
  (Array.isArray(value) ? value : [])
    .filter((e) => e && typeof e.id === 'string' && typeof e.baseUrl === 'string')
    .map((e) => ({ id: e.id, label: String(e.label ?? e.id), baseUrl: e.baseUrl, paid: Boolean(e.paid), keyless: Boolean(e.keyless) }));

/** paidOrder: are paid keys asked before the free ones ('first') or only after them ('last')? paidDailyTokens: 0 = no limit. */
const settings = (value = {}) => ({
  paidOrder: value?.paidOrder === 'last' ? 'last' : 'first',
  paidDailyTokens: Number.isInteger(value?.paidDailyTokens) && value.paidDailyTokens > 0 ? value.paidDailyTokens : 0,
});

/** Synchronous on purpose: it is part of building the config at start-up. */
export function loadStoredKeys(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const vault = vaultFor(file);
    const keys = Object.fromEntries(Object.entries(asLists(data.keys)).map(([id, list]) => [id, list.map((key) => vault.decrypt(key)).filter(Boolean)]));
    return { keys, models: asLists(data.models), cli: flags(data.cli), endpoints: endpoints(data.endpoints), settings: settings(data.settings) };
  } catch {
    return { keys: {}, models: {}, cli: {}, endpoints: [], settings: settings() };
  }
}

/** Are there keys in the file that are not encrypted yet (saved by an older version, or typed in by hand)? */
export function hasPlainKeys(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Object.values(asLists(data.keys)).flat().some((key) => !vaultFor(file).isEncrypted(key));
  } catch {
    return false;
  }
}

export async function saveStoredKeys(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  const vault = vaultFor(file);
  const sealed = { ...data, keys: Object.fromEntries(Object.entries(data.keys ?? {}).map(([id, list]) => [id, list.map((key) => vault.encrypt(key))])) };
  if (!Object.keys(sealed.cli ?? {}).length) delete sealed.cli;
  if (!sealed.endpoints?.length) delete sealed.endpoints;
  if (sealed.settings && sealed.settings.paidOrder === 'first' && !sealed.settings.paidDailyTokens) delete sealed.settings;
  await fs.promises.writeFile(tmp, `${JSON.stringify(sealed, null, 2)}\n`, { mode: 0o600 });
  await fs.promises.rename(tmp, file);
}

/** A stable handle for a key that reveals nothing useful about it. */
export const keyId = (key) => crypto.createHash('sha256').update(key).digest('hex').slice(0, 10);

/** All the UI ever sees of a key. */
export const maskKey = (key) => (key.length >= 12 ? `••••${key.slice(-4)}` : '••••');

const modelIds = async (res) => {
  const data = await res.json().catch(() => ({}));
  const list = Array.isArray(data.data) ? data.data : Array.isArray(data.models) ? data.models : [];
  return list.map((m) => String(m?.id ?? m?.name ?? '').replace(/^models\//, '')).filter(Boolean);
};

/**
 * Check a key with its provider without spending tokens, and fetch the models
 * the provider offers.
 *
 *   rejected  the provider says the key is wrong
 *   verified  the provider accepted it (false also when it could not be asked:
 *             offline, or the provider has no auth-only endpoint to ask)
 *   models    model ids from {baseUrl}/models, possibly empty
 *
 * On several providers /models is public, so it proves nothing about a key;
 * those presets name another endpoint (verifyUrl) or opt out (verifyUrl: false).
 */
export async function verifyKey(provider, key) {
  // Claude's API takes its key in a header of its own; everyone else takes a Bearer token.
  const headers = !key ? {} : provider.api === 'anthropic' ? anthropicHeaders(key) : { authorization: `Bearer ${key}` };
  const get = async (url) => {
    try {
      return await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
    } catch {
      return null;
    }
  };
  const modelsUrl = `${provider.baseUrl}/models`;
  const result = { rejected: false, verified: false, models: [] };

  if (key && provider.verifyUrl !== false) {
    const checkUrl = !provider.verifyUrl
      ? modelsUrl
      : provider.verifyUrl.startsWith('http')
        ? provider.verifyUrl
        : provider.baseUrl + provider.verifyUrl;
    const res = await get(checkUrl);
    if (res && [400, 401, 403].includes(res.status)) return { ...result, rejected: true };
    result.verified = Boolean(res?.ok);
    if (res?.ok && checkUrl === modelsUrl) result.models = await modelIds(res);
  }
  if (!result.models.length) {
    const res = await get(modelsUrl);
    if (res?.ok) result.models = await modelIds(res);
  }
  return result;
}
