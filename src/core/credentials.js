import fs from 'node:fs';
import crypto from 'node:crypto';
import { vaultFor } from './vault.js';
import { maskKey } from './keyStore.js';
import { CREDENTIAL_TYPES } from './services.js';

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const MAX_CREDENTIALS = 40;
const one = (v, max) => String(v ?? '').trim().slice(0, max);

/**
 * Credentials for flows: the keys and webhook addresses that service and HTTP
 * nodes use, kept apart from the flows themselves.
 *
 * Secret fields are encrypted with the vault before they touch the disk and
 * never leave the server: list() gives a name, a type and a masked hint, and
 * a node refers to a credential by id. The file is shared by every room, like
 * the key file, and read again whenever it changed on disk.
 */
export class Credentials {
  #list = [];
  #mtime = -1;

  constructor({ file, fetch = globalThis.fetch }) {
    this.file = file;
    this.fetch = (...args) => fetch(...args);
  }

  /** Read the file again if another process (another room) changed it. */
  #load() {
    let mtime;
    try {
      mtime = fs.statSync(this.file).mtimeMs;
    } catch {
      this.#list = [];
      this.#mtime = -1;
      return;
    }
    if (mtime === this.#mtime) return;
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.#list = (Array.isArray(saved.credentials) ? saved.credentials : []).filter((c) => c && CREDENTIAL_TYPES[c.type] && typeof c.id === 'string');
      this.#mtime = mtime;
    } catch {
      this.#list = [];
    }
  }

  async #save() {
    const tmp = `${this.file}.${process.pid}.tmp`;
    await fs.promises.writeFile(tmp, `${JSON.stringify({ credentials: this.#list }, null, 2)}\n`, { mode: 0o600 });
    await fs.promises.rename(tmp, this.file);
    this.#mtime = fs.statSync(this.file).mtimeMs;
  }

  #view(c) {
    const type = CREDENTIAL_TYPES[c.type];
    const shown = Object.fromEntries(type.fields.filter((f) => !f.secret).map((f) => [f.id, c.plain?.[f.id] ?? '']));
    return { id: c.id, type: c.type, typeLabel: type.label, name: c.name, shown, hint: c.hint ?? '', createdAt: c.createdAt };
  }

  list() {
    this.#load();
    return this.#list.map((c) => this.#view(c));
  }

  has(id) {
    this.#load();
    return this.#list.some((c) => c.id === id);
  }

  typeOf(id) {
    this.#load();
    return this.#list.find((c) => c.id === id)?.type ?? null;
  }

  /** The decrypted credential, for the one request that needs it. Never sent anywhere else. */
  get(id) {
    this.#load();
    const c = this.#list.find((x) => x.id === id);
    if (!c) return null;
    let secret = {};
    try {
      secret = JSON.parse(vaultFor(this.file).decrypt(c.secret ?? '') || '{}');
    } catch {
      throw fail(`The credential "${c.name}" cannot be read (was secret.local.key replaced?)`);
    }
    return { type: c.type, ...c.plain, ...secret };
  }

  async add(input = {}) {
    this.#load();
    const type = CREDENTIAL_TYPES[input.type];
    if (!type) throw fail('Pick what kind of credential it is');
    if (this.#list.length >= MAX_CREDENTIALS) throw fail(`At most ${MAX_CREDENTIALS} credentials`, 409);
    const plain = {};
    const secret = {};
    for (const field of type.fields) {
      const value = one(input[field.id], 2000);
      if (!value && !field.optional) throw fail(`${field.label} is needed`);
      if (value && field.pattern && !new RegExp(field.pattern).test(value)) throw fail(`That does not look like a ${field.label.toLowerCase()}`);
      if (field.secret && /\s/.test(value)) throw fail(`${field.label} has no spaces in it`);
      if (value) (field.secret ? secret : plain)[field.id] = value;
    }
    const first = type.fields.find((f) => f.secret && secret[f.id]);
    const credential = {
      id: crypto.randomBytes(6).toString('hex'),
      type: input.type,
      name: one(input.name, 40) || type.label,
      plain,
      secret: vaultFor(this.file).encrypt(JSON.stringify(secret)),
      hint: first ? maskKey(secret[first.id]) : '',
      createdAt: Date.now(),
    };
    this.#list.push(credential);
    await this.#save();
    return this.#view(credential);
  }

  async remove(id) {
    this.#load();
    if (!this.#list.some((c) => c.id === id)) throw fail('No such credential', 404);
    this.#list = this.#list.filter((c) => c.id !== id);
    await this.#save();
    return { removed: id };
  }

  /** One cheap request that only works with a good credential. Errors never carry the secret. */
  async test(id) {
    const cred = this.get(id);
    if (!cred) throw fail('No such credential', 404);
    const verify = CREDENTIAL_TYPES[cred.type].verify;
    if (!verify) return { ok: true, note: 'This kind cannot be checked in advance; it is used as it is.' };
    try {
      return { ok: true, note: await verify(cred, this.fetch) };
    } catch (err) {
      let message = String(err.message);
      for (const v of Object.values(cred)) if (typeof v === 'string' && v.length > 6) message = message.replaceAll(v, '***');
      return { ok: false, note: message };
    }
  }
}
