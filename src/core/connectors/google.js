import { vaultFor } from '../vault.js';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { clip } from '../util.js';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const PENDING_TTL_MS = 10 * 60000;
const READ_CAP = 20000;

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const b64url = (buffer) => buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (text) => Buffer.from(String(text ?? '').replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');

/**
 * What can be connected. Every scope is READ-ONLY on purpose: the crew can look
 * things up in your Google account, but can never send mail, edit a document or
 * change your calendar.
 */
export const GOOGLE_SERVICES = {
  drive: { label: 'Drive, Docs and Sheets', scope: 'https://www.googleapis.com/auth/drive.readonly', api: 'Google Drive API' },
  gmail: { label: 'Gmail', scope: 'https://www.googleapis.com/auth/gmail.readonly', api: 'Gmail API' },
  calendar: { label: 'Calendar', scope: 'https://www.googleapis.com/auth/calendar.readonly', api: 'Google Calendar API' },
};

const TOOLS = {
  drive: [
    { name: 'google__drive_search', params: ['query'], description: 'Search the user\'s Google Drive by file name or content. Returns ids, names and types.' },
    { name: 'google__drive_read', params: ['fileId'], description: 'Read a Drive file as text: Google Docs as plain text, Sheets as CSV, text files as they are.' },
  ],
  gmail: [
    { name: 'google__gmail_search', params: ['query'], description: 'Search the user\'s Gmail (same syntax as the Gmail search box). Returns ids, senders, subjects and snippets.' },
    { name: 'google__gmail_read', params: ['messageId'], description: 'Read one Gmail message as plain text.' },
  ],
  calendar: [{ name: 'google__calendar_events', params: ['days'], description: 'List the user\'s upcoming calendar events for the next N days (default 7).' }],
};

/**
 * "Connect Google": the standard OAuth sign-in, done with a Google Cloud OAuth
 * client that belongs to the user (Kadhai has no servers and no client of its
 * own - that is what keeps it free and private). After sign-in the crew gets a
 * handful of read-only tools, offered to the cooks exactly like MCP tools.
 *
 * Stored on this machine only (connectors.local.json): the client id and
 * secret, the refresh token and the account's email - the secret and the
 * token encrypted (see vault.js). Access tokens live in
 * memory. Nothing here is ever returned to the dashboard except the email.
 */
const SEALED = ['clientSecret', 'refreshToken']; // encrypted in connectors.local.json

export class GoogleConnector {
  #saved = {}; // { clientId, clientSecret, services, refreshToken, email }
  #access = null; // { token, expiresAt }
  #pending = null; // { state, verifier, at }
  #loaded = false;

  constructor({ file, redirectUri, bus, fetch = globalThis.fetch }) {
    this.file = file;
    this.redirectUri = redirectUri;
    this.bus = bus;
    this.fetch = (...args) => fetch(...args);
    this.needsReconnect = false;
  }

  /** Read what was saved, so tools() can answer without waiting. */
  init() {
    return this.#load();
  }

  async #load() {
    if (this.#loaded) return;
    this.#loaded = true;
    try {
      const saved = JSON.parse(await fs.readFile(this.file, 'utf8')).google ?? {};
      const vault = vaultFor(this.file);
      // The secret and the token are encrypted on disk; in memory they are plain.
      for (const field of SEALED) if (saved[field]) saved[field] = vault.decrypt(saved[field]);
      this.#saved = saved;
    } catch {
      this.#saved = {};
    }
  }

  async #save() {
    let all = {};
    try {
      all = JSON.parse(await fs.readFile(this.file, 'utf8'));
    } catch {
      // First connector to be saved.
    }
    const vault = vaultFor(this.file);
    all.google = { ...this.#saved };
    for (const field of SEALED) if (all.google[field]) all.google[field] = vault.encrypt(all.google[field]);
    const tmp = `${this.file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(tmp, this.file);
  }

  #changed() {
    this.bus?.publish('connectors:update', {});
  }

  get connected() {
    return Boolean(this.#saved.refreshToken) && !this.needsReconnect;
  }

  async status() {
    await this.#load();
    const { clientId = '', services = [], email = null } = this.#saved;
    return {
      configured: Boolean(clientId && this.#saved.clientSecret),
      connected: this.connected,
      needsReconnect: this.needsReconnect,
      email,
      services,
      // A client id is not a secret, but there is no reason to show all of it either.
      clientId: clientId ? `${clientId.slice(0, 12)}…${clientId.slice(-27)}` : '',
      redirectUri: this.redirectUri,
      available: Object.entries(GOOGLE_SERVICES).map(([id, s]) => ({ id, label: s.label, api: s.api })),
      tools: this.tools().map((t) => t.name),
    };
  }

  /** Save the OAuth client and chosen services, and return the Google page to send the user to. */
  async setup({ clientId, clientSecret, services } = {}) {
    await this.#load();
    const id = String(clientId ?? '').trim() || this.#saved.clientId || '';
    const secret = String(clientSecret ?? '').trim() || this.#saved.clientSecret || '';
    if (!/^[\w-]+\.apps\.googleusercontent\.com$/.test(id)) throw fail('That does not look like a Google OAuth client ID (it ends in .apps.googleusercontent.com)');
    if (secret.length < 8) throw fail('Paste the client secret that goes with that client ID');
    const chosen = [...new Set(Array.isArray(services) ? services : [])].filter((s) => GOOGLE_SERVICES[s]);
    if (!chosen.length) throw fail('Choose at least one thing to connect');

    Object.assign(this.#saved, { clientId: id, clientSecret: secret, services: chosen });
    await this.#save();

    const verifier = b64url(crypto.randomBytes(32));
    this.#pending = { state: b64url(crypto.randomBytes(18)), verifier, at: Date.now() };
    const params = new URLSearchParams({
      client_id: id,
      redirect_uri: this.redirectUri,
      response_type: 'code',
      scope: ['openid', 'email', ...chosen.map((s) => GOOGLE_SERVICES[s].scope)].join(' '),
      access_type: 'offline', // we need a refresh token...
      prompt: 'consent', // ...and Google only sends one when consent is shown
      state: this.#pending.state,
      code_challenge: b64url(crypto.createHash('sha256').update(verifier).digest()),
      code_challenge_method: 'S256',
    });
    this.#changed();
    return { authUrl: `${AUTH_URL}?${params}` };
  }

  /** Google sent the user back. Swap the one-time code for tokens. */
  async callback({ code, state, error } = {}) {
    await this.#load();
    const pending = this.#pending;
    this.#pending = null;
    if (error) throw fail(error === 'access_denied' ? 'You did not give permission, so nothing was connected.' : `Google said: ${error}`);
    if (!pending || Date.now() - pending.at > PENDING_TTL_MS) throw fail('That sign-in attempt has expired. Start again from Kadhai.');
    if (!state || state !== pending.state) throw fail('That sign-in did not start from this Kadhai. Nothing was connected.', 403);
    if (!code) throw fail('Google did not send a sign-in code.');

    const tokens = await this.#exchange({ grant_type: 'authorization_code', code, redirect_uri: this.redirectUri, code_verifier: pending.verifier });
    if (!tokens.refresh_token) throw fail('Google did not issue a long-lived token. Remove Kadhai under myaccount.google.com/permissions and connect again.');
    let email = null;
    try {
      email = JSON.parse(fromB64url(tokens.id_token.split('.')[1])).email ?? null;
    } catch {
      // Not fatal: the connection works without knowing the address.
    }
    Object.assign(this.#saved, { refreshToken: tokens.refresh_token, email });
    this.needsReconnect = false;
    await this.#save();
    this.#changed();
    return { email };
  }

  async #exchange(fields) {
    const res = await this.fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: this.#saved.clientId, client_secret: this.#saved.clientSecret, ...fields }),
      signal: AbortSignal.timeout(15000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const reason = data.error_description || data.error || `HTTP ${res.status}`;
      throw Object.assign(fail(data.error === 'invalid_client' ? 'Google rejected the client ID or secret. Check both.' : `Google sign-in failed: ${reason}`), { oauth: data.error });
    }
    this.#access = { token: data.access_token, expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000 };
    return data;
  }

  async #token() {
    await this.#load();
    if (!this.#saved.refreshToken) throw new Error('Google is not connected. Connect it in the dashboard first.');
    if (this.#access && this.#access.expiresAt - 60000 > Date.now()) return this.#access.token;
    try {
      await this.#exchange({ grant_type: 'refresh_token', refresh_token: this.#saved.refreshToken });
    } catch (err) {
      if (err.oauth === 'invalid_grant') {
        // Revoked, or the 7-day limit of a Google project left in "Testing".
        this.needsReconnect = true;
        this.#changed();
        throw new Error('The Google sign-in has expired. Reconnect Google in the dashboard.');
      }
      throw err;
    }
    return this.#access.token;
  }

  async #get(url, { text = false } = {}) {
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetch(url, { headers: { authorization: `Bearer ${await this.#token()}` }, signal: AbortSignal.timeout(20000) });
      if (res.status === 401 && attempt === 0) {
        this.#access = null; // stale access token: refresh once and retry
        continue;
      }
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        const message = data.error?.message ?? `HTTP ${res.status}`;
        if (/has not been used in project|is disabled/i.test(message)) throw new Error(`That Google API is not switched on in your Google Cloud project. Enable it there, wait a minute, and try again. (${clip(message, 160)})`);
        throw new Error(`Google: ${clip(message, 200)}`);
      }
      return text ? res.text() : res.json();
    }
  }

  // ----------------------------------------------------------------- tools

  tools() {
    if (!this.connected) return [];
    return (this.#saved.services ?? []).flatMap((service) => TOOLS[service] ?? []);
  }

  async call(name, args = {}) {
    if (!this.tools().some((t) => t.name === name)) throw new Error(`unknown tool "${name}"`);
    switch (name) {
      case 'google__drive_search':
        return this.#driveSearch(args.query);
      case 'google__drive_read':
        return this.#driveRead(args.fileId);
      case 'google__gmail_search':
        return this.#gmailSearch(args.query);
      case 'google__gmail_read':
        return this.#gmailRead(args.messageId);
      default:
        return this.#calendarEvents(args.days);
    }
  }

  async #driveSearch(query) {
    const text = String(query ?? '').trim().replace(/['\\]/g, ' ');
    if (!text) throw new Error('"query" is required');
    const params = new URLSearchParams({
      q: `(name contains '${text}' or fullText contains '${text}') and trashed = false`,
      pageSize: '10',
      orderBy: 'modifiedTime desc',
      fields: 'files(id,name,mimeType,modifiedTime)',
    });
    const { files = [] } = await this.#get(`https://www.googleapis.com/drive/v3/files?${params}`);
    if (!files.length) return 'No files matched.';
    return files.map((f) => `${f.id}\t${f.name}\t${f.mimeType.replace('application/vnd.google-apps.', 'google ')}\t${f.modifiedTime?.slice(0, 10)}`).join('\n');
  }

  async #driveRead(fileId) {
    const id = String(fileId ?? '').trim();
    if (!/^[\w-]{10,}$/.test(id)) throw new Error('"fileId" must be an id from google__drive_search');
    const base = `https://www.googleapis.com/drive/v3/files/${id}`;
    const meta = await this.#get(`${base}?fields=name,mimeType,size`);
    const exportAs = {
      'application/vnd.google-apps.document': 'text/plain',
      'application/vnd.google-apps.spreadsheet': 'text/csv',
      'application/vnd.google-apps.presentation': 'text/plain',
    }[meta.mimeType];
    let body;
    if (exportAs) body = await this.#get(`${base}/export?mimeType=${encodeURIComponent(exportAs)}`, { text: true });
    else if (/^text\/|json|xml|javascript|csv|markdown/.test(meta.mimeType)) body = await this.#get(`${base}?alt=media`, { text: true });
    else throw new Error(`"${meta.name}" is a ${meta.mimeType} file, which cannot be read as text`);
    return `# ${meta.name}\n${body.length > READ_CAP ? `${body.slice(0, READ_CAP)}\n[cut at ${READ_CAP} characters]` : body}`;
  }

  async #gmailSearch(query) {
    const params = new URLSearchParams({ q: String(query ?? '').trim(), maxResults: '8' });
    const { messages = [] } = await this.#get(`https://gmail.googleapis.com/gmail/v1/users/me/messages?${params}`);
    if (!messages.length) return 'No messages matched.';
    const rows = [];
    for (const { id } of messages) {
      const m = await this.#get(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`);
      const header = (name) => m.payload?.headers?.find((h) => h.name === name)?.value ?? '';
      rows.push(`${id}\t${header('Date').slice(0, 16)}\t${clip(header('From'), 40)}\t${clip(header('Subject'), 70)}\t${clip(m.snippet ?? '', 90)}`);
    }
    return rows.join('\n');
  }

  async #gmailRead(messageId) {
    const id = String(messageId ?? '').trim();
    if (!/^[\w-]{6,}$/.test(id)) throw new Error('"messageId" must be an id from google__gmail_search');
    const m = await this.#get(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`);
    const header = (name) => m.payload?.headers?.find((h) => h.name === name)?.value ?? '';
    // A message is a tree of parts: prefer plain text, fall back to HTML with the tags removed.
    const find = (part, type) => (part?.mimeType === type && part.body?.data ? part : (part?.parts ?? []).map((p) => find(p, type)).find(Boolean));
    const plain = find(m.payload, 'text/plain');
    const html = plain ? null : find(m.payload, 'text/html');
    const body = plain ? fromB64url(plain.body.data) : html ? fromB64url(html.body.data).replace(/<style[\s\S]*?<\/style>|<[^>]+>/g, ' ').replace(/\s+/g, ' ') : (m.snippet ?? '');
    return `From: ${header('From')}\nDate: ${header('Date')}\nSubject: ${header('Subject')}\n\n${clip(body, 12000)}`;
  }

  async #calendarEvents(days) {
    const span = Math.min(Math.max(Number(days) || 7, 1), 60);
    const params = new URLSearchParams({
      timeMin: new Date().toISOString(),
      timeMax: new Date(Date.now() + span * 86400000).toISOString(),
      singleEvents: 'true',
      orderBy: 'startTime',
      maxResults: '25',
    });
    const { items = [] } = await this.#get(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`);
    if (!items.length) return `Nothing on the calendar in the next ${span} day(s).`;
    return items.map((e) => `${e.start?.dateTime ?? e.start?.date}\t${e.summary ?? '(no title)'}${e.location ? `\t@ ${e.location}` : ''}`).join('\n');
  }

  /** Sign out. With `forget`, the OAuth client is removed too. */
  async disconnect({ forget = false } = {}) {
    await this.#load();
    const token = this.#saved.refreshToken;
    if (token) {
      // Best effort: tell Google the token is finished with.
      await this.fetch(`${REVOKE_URL}?token=${encodeURIComponent(token)}`, { method: 'POST', signal: AbortSignal.timeout(8000) }).catch(() => {});
    }
    this.#access = null;
    this.needsReconnect = false;
    this.#saved = forget ? {} : { clientId: this.#saved.clientId, clientSecret: this.#saved.clientSecret, services: this.#saved.services };
    await this.#save();
    this.#changed();
    return this.status();
  }
}

/** The connection a tool belongs to: the part of its name before "__". */
export const groupOf = (toolName) => String(toolName).split('__')[0];

/**
 * Tools from every source (MCP servers, connectors) as one list for the cooks.
 *
 * Tool descriptions cost prompt tokens on every call, and a single connector
 * can bring thirty of them. So tools are grouped by connection: the
 * Chef is told only which connections exist (one line each) and names the
 * ones a sub-task needs; only those tools are then shown to that cook.
 */
export class Toolbox {
  constructor(sources, describe = () => null) {
    this.sources = sources;
    this.describe = describe;
  }

  tools() {
    return this.sources.flatMap((source) => source.tools());
  }

  /** Every connection that currently offers tools: [{ id, count, about }]. */
  groups() {
    const groups = new Map();
    for (const tool of this.tools()) {
      const id = groupOf(tool.name);
      if (!groups.has(id)) groups.set(id, []);
      groups.get(id).push(tool);
    }
    return [...groups].map(([id, tools]) => ({
      id,
      count: tools.length,
      about: this.describe(id) ?? `tools: ${tools.slice(0, 4).map((t) => t.name.slice(id.length + 2)).join(', ')}`,
    }));
  }

  /** The tools of the named connections only. */
  toolsFor(ids = []) {
    const wanted = new Set(ids);
    return this.tools().filter((tool) => wanted.has(groupOf(tool.name)));
  }

  async call(name, args) {
    const source = this.sources.find((s) => s.tools().some((tool) => tool.name === name));
    if (!source) throw new Error(`unknown tool "${name}"`);
    return source.call(name, args);
  }
}
