import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { log } from './util.js';

const PREFIX = 'enc:v1:';
export const KEY_FILE = 'secret.local.key';

/**
 * Windows' own per-user secret store (DPAPI): what it protects can be opened
 * again only by the same Windows account on the same computer. The value
 * travels in an environment variable, never on the command line.
 */
function dpapi(mode, base64) {
  const script = `Add-Type -AssemblyName System.Security; [Console]::Out.Write([Convert]::ToBase64String([Security.Cryptography.ProtectedData]::${mode}([Convert]::FromBase64String($env:KADHAI_VAULT_IN), $null, 'CurrentUser')))`;
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, KADHAI_VAULT_IN: base64 },
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30000,
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

/**
 * Encrypts the secrets Kadhai keeps on disk (provider keys, connector tokens,
 * MCP server settings) with AES-256-GCM.
 *
 * The 32-byte master key lives in secret.local.key beside them. On Windows it
 * is wrapped with DPAPI, so the files are useless if they are copied, backed
 * up or synced somewhere else. On other systems the key file is plain (mode
 * 0600): that still keeps secrets out of the files people open, paste and
 * share, but anyone who can read the whole folder can read the key too. It is
 * not protection against a program already running as you - nothing local is.
 */
export class Vault {
  #key = null;
  #broken = false;

  constructor(keyFile, { protect = process.platform === 'win32' && process.env.KADHAI_VAULT_PROTECTION !== 'file' } = {}) {
    this.keyFile = keyFile;
    this.protect = protect;
  }

  /** The master key: read it, or make one the first time a secret is stored. */
  #master(create) {
    if (this.#key || this.#broken) return this.#key;
    let saved = null;
    try {
      saved = JSON.parse(fs.readFileSync(this.keyFile, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') log.warn(`The secret key file could not be read: ${err.message}`);
    }
    if (saved) {
      try {
        const key = Buffer.from(saved.protection === 'dpapi' ? dpapi('Unprotect', saved.key) : saved.key, 'base64');
        if (key.length !== 32) throw new Error('wrong length');
        this.#key = key;
      } catch {
        // Another account or another computer: the saved secrets cannot be opened here.
        this.#broken = true;
        log.warn('Saved secrets cannot be opened on this account or computer. Add your keys again (delete secret.local.key to start fresh).');
      }
      return this.#key;
    }
    if (!create) return null;

    const key = crypto.randomBytes(32);
    let record = { v: 1, protection: 'file', key: key.toString('base64') };
    if (this.protect) {
      try {
        record = { v: 1, protection: 'dpapi', key: dpapi('Protect', key.toString('base64')) };
      } catch (err) {
        log.warn(`Windows key protection is not available (${err.message.split('\n')[0]}); the secret key is kept as a plain file.`);
      }
    }
    try {
      // "wx": if another process created it first, use theirs.
      fs.writeFileSync(this.keyFile, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
      this.#key = key;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      return this.#master(false);
    }
    return this.#key;
  }

  /** How the master key is kept: "dpapi", "file", or null before anything has been stored. */
  get protection() {
    try {
      return JSON.parse(fs.readFileSync(this.keyFile, 'utf8')).protection ?? null;
    } catch {
      return null;
    }
  }

  isEncrypted(value) {
    return typeof value === 'string' && value.startsWith(PREFIX);
  }

  /** '' stays ''. Throws if the vault cannot be opened: a secret is never written unprotected by accident. */
  encrypt(text) {
    const plain = String(text ?? '');
    if (!plain || this.isEncrypted(plain)) return plain;
    const key = this.#master(true);
    if (!key) throw Object.assign(new Error('Secrets cannot be stored: the secret key file belongs to another account or computer'), { status: 500 });
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const sealed = `${PREFIX}${[iv, cipher.getAuthTag(), body].map((part) => part.toString('base64url')).join('.')}`;
    // Belt and braces: what was just sealed must open again before anyone relies on it.
    if (this.decrypt(sealed) !== plain) throw new Error('Secrets cannot be stored: the vault failed its own check');
    return sealed;
  }

  /** Plain text (from before encryption, or typed by hand) passes through. An unreadable secret comes back as ''. */
  decrypt(value) {
    if (!this.isEncrypted(value)) return typeof value === 'string' ? value : '';
    const key = this.#master(false);
    if (!key) return '';
    try {
      const [iv, tag, body] = value.slice(PREFIX.length).split('.').map((part) => Buffer.from(part, 'base64url'));
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
    } catch {
      return '';
    }
  }
}

const vaults = new Map();

/** The vault for a data file: one key file per folder, opened once per process. */
export function vaultFor(dataFile) {
  const keyFile = path.join(path.dirname(path.resolve(dataFile)), KEY_FILE);
  if (!vaults.has(keyFile)) vaults.set(keyFile, new Vault(keyFile));
  return vaults.get(keyFile);
}
