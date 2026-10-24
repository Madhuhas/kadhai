import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const PATCH_CAP = 300000;
// Kadhai's own files never belong in the user's history.
const EXCLUDES = ['.kadhai/', 'memory.md'];
const BRANCH_NAME = /^(?!-)[\w][\w./-]{0,99}$/;

/**
 * Source control for the workspace: the folder's *own* git repository, the one
 * the user commits to and pushes from. (Not to be confused with checkpoints.js,
 * which keeps a private shadow repository for undo and never touches this one.)
 *
 * Every path that reaches git has been through Workspace.resolve first, and is
 * passed after "--", so nothing here can address a file outside the folder.
 */
export class Repo {
  #excluded = false;

  constructor({ root, workspace, bus, isBusy = () => false }) {
    this.root = root;
    this.workspace = workspace;
    this.bus = bus;
    this.isBusy = isBusy;
  }

  #git(args, { timeoutMs = 15000, allowFail = false } = {}) {
    return new Promise((resolve, reject) => {
      execFile(
        'git',
        ['-c', 'core.quotepath=false', ...args],
        {
          cwd: this.root,
          windowsHide: true,
          timeout: timeoutMs,
          maxBuffer: 32 * 1024 * 1024,
          // Never stop to ask for a password in a console nobody can see.
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
        },
        (err, stdout, stderr) => {
          if (!err) return resolve(stdout);
          if (allowFail) return resolve(null);
          if (err.code === 'ENOENT') return reject(fail('Git is not installed on this computer', 501));
          if (err.killed) return reject(fail('Git took too long and was stopped (it may be waiting for a password)', 504));
          const text = (stderr || stdout || err.message).trim();
          reject(fail(text.split('\n').filter(Boolean).slice(-3).join(' ') || 'Git failed'));
        },
      );
    });
  }

  #paths(list) {
    const paths = (Array.isArray(list) ? list : [list]).filter((p) => p != null).map((p) => this.workspace.resolve(p).rel);
    if (!paths.length) throw fail('No file was given');
    return paths;
  }

  #changed() {
    this.bus?.publish('git:change', {});
  }

  #guardBusy(what) {
    if (this.isBusy()) throw fail(`Wait for the crew to finish before you ${what}: it would change files under them`, 409);
  }

  /** Is this folder the top of a git repository? null if git is missing. */
  async #where() {
    const top = await this.#git(['rev-parse', '--show-toplevel'], { allowFail: true }).catch(() => undefined);
    if (top === undefined) return { available: false };
    if (top === null) return { available: true, repo: false };
    const same = path.resolve(top.trim()).toLowerCase() === path.resolve(this.root).toLowerCase();
    return same ? { available: true, repo: true } : { available: true, repo: false, parent: path.resolve(top.trim()) };
  }

  /** Keep Kadhai's own files out of the user's repo without touching their .gitignore. */
  async #exclude() {
    if (this.#excluded) return;
    const file = path.join(this.root, '.git', 'info', 'exclude');
    const current = await fs.readFile(file, 'utf8').catch(() => '');
    const missing = EXCLUDES.filter((line) => !current.split(/\r?\n/).includes(line));
    if (missing.length) {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, `${current}${current && !current.endsWith('\n') ? '\n' : ''}${missing.join('\n')}\n`);
    }
    this.#excluded = true;
  }

  async status() {
    const where = await this.#where();
    if (!where.repo) return where;
    await this.#exclude();

    const raw = await this.#git(['status', '--porcelain=v1', '-b', '-z', '--untracked-files=all']);
    const tokens = raw.split('\0').filter(Boolean);
    const head = tokens.shift() ?? '';
    const branchLine = head.replace(/^## /, '');
    const noCommits = branchLine.startsWith('No commits yet on ');
    const match = /^(?:No commits yet on )?([^\s.]+(?:\.[^\s.]+)*?)(?:\.\.\.(\S+))?(?: \[(.*)\])?$/.exec(branchLine);
    const counts = match?.[3] ?? '';

    const files = [];
    for (let i = 0; i < tokens.length; i++) {
      const entry = tokens[i];
      const index = entry[0];
      const work = entry[1];
      // Renames and copies are followed by the old path; it is not a file of its own.
      if (index === 'R' || index === 'C' || work === 'R' || work === 'C') i += 1;
      const untracked = index === '?';
      files.push({
        path: entry.slice(3),
        index: untracked ? ' ' : index,
        work: untracked ? 'U' : work,
        staged: !untracked && index !== ' ',
        unstaged: untracked || work !== ' ',
        conflicted: index === 'U' || work === 'U' || (index === 'A' && work === 'A') || (index === 'D' && work === 'D'),
      });
    }
    return {
      available: true,
      repo: true,
      branch: branchLine.startsWith('HEAD (no branch)') ? '(detached)' : (match?.[1] ?? branchLine),
      upstream: match?.[2] ?? null,
      ahead: Number(/ahead (\d+)/.exec(counts)?.[1] ?? 0),
      behind: Number(/behind (\d+)/.exec(counts)?.[1] ?? 0),
      hasCommits: !noCommits,
      files,
    };
  }

  async init() {
    const where = await this.#where();
    if (!where.available) throw fail('Git is not installed on this computer', 501);
    if (where.repo) return this.status();
    if (where.parent) throw fail(`This folder is already inside a repository (${where.parent}). Open that folder instead.`, 409);
    await this.#git(['init', '-q']);
    this.#changed();
    return this.status();
  }

  async stage(paths, all = false) {
    await this.#git(all ? ['add', '-A'] : ['add', '-A', '--', ...this.#paths(paths)]);
    this.#changed();
  }

  async unstage(paths, all = false) {
    const hasCommits = (await this.#git(['rev-parse', '--verify', '-q', 'HEAD'], { allowFail: true })) !== null;
    const targets = all ? ['.'] : this.#paths(paths);
    // Before the first commit there is no HEAD to reset to.
    await this.#git(hasCommits ? ['reset', '-q', 'HEAD', '--', ...targets] : ['rm', '-r', '-q', '--cached', '--', ...targets]);
    this.#changed();
  }

  /** Throw away the changes to one file: restore it, or delete it if git never knew it. */
  async discard(file) {
    this.#guardBusy('discard changes');
    const [rel] = this.#paths(file);
    const tracked = (await this.#git(['ls-files', '--error-unmatch', '--', rel], { allowFail: true })) !== null;
    if (tracked) {
      await this.#git(['reset', '-q', 'HEAD', '--', rel], { allowFail: true });
      await this.#git(['checkout', '--', rel]);
    } else {
      await this.workspace.deleteFile(rel, { owner: 'user', timeoutMs: 1500 });
    }
    this.#changed();
  }

  async commit(message) {
    const text = String(message ?? '').trim();
    if (!text) throw fail('Write a commit message first');
    const name = await this.#git(['config', 'user.name'], { allowFail: true });
    const email = await this.#git(['config', 'user.email'], { allowFail: true });
    if (!name?.trim() || !email?.trim()) {
      throw fail('Git does not know who you are yet. Run these two commands once (in a terminal, or in the chat starting with "!"): git config --global user.name "Your Name"   and   git config --global user.email "you@example.com"', 409);
    }
    // Like most editors: with nothing staged, "commit" means "commit everything".
    const staged = await this.#git(['diff', '--cached', '--name-only']);
    if (!staged.trim()) await this.#git(['add', '-A']);
    if (!(await this.#git(['diff', '--cached', '--name-only'])).trim()) throw fail('There is nothing to commit');
    await this.#git(['commit', '-q', '-m', text]);
    this.#changed();
    return { commit: (await this.#git(['rev-parse', '--short', 'HEAD'])).trim() };
  }

  /** The change to one file, as a patch. An untracked file is shown as entirely new. */
  async diff(file, staged = false) {
    const [rel] = this.#paths(file);
    let patch = await this.#git(['diff', '--no-color', '--no-ext-diff', ...(staged ? ['--cached'] : []), '--', rel]);
    if (!patch && !staged) {
      const data = await this.workspace.readFile(rel).catch(() => null);
      if (data && !data.binary) {
        const lines = data.content.replace(/\n$/, '').split('\n');
        patch = `new file: ${rel}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join('\n')}\n`;
      } else if (data) patch = `new file: ${rel}\n(binary file)\n`;
    }
    return { path: rel, patch: patch.slice(0, PATCH_CAP), truncated: patch.length > PATCH_CAP };
  }

  async log(limit = 15) {
    const raw = await this.#git(['log', '-n', String(limit), '--pretty=format:%h%x1f%s%x1f%an%x1f%cr'], { allowFail: true });
    return (raw ?? '')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [hash, subject, author, when] = line.split('\x1f');
        return { hash, subject, author, when };
      });
  }

  async branches() {
    const raw = await this.#git(['branch', '--format=%(refname:short)'], { allowFail: true });
    return (raw ?? '').split('\n').map((b) => b.trim()).filter(Boolean);
  }

  async checkout(branch, create = false) {
    this.#guardBusy('switch branch');
    const name = String(branch ?? '').trim();
    if (!BRANCH_NAME.test(name) || name.includes('..')) throw fail('That is not a valid branch name');
    await this.#git(create ? ['checkout', '-q', '-b', name] : ['checkout', '-q', name]);
    this.#changed();
    this.bus?.publish('fs:change', { paths: [] });
  }

  async pull() {
    this.#guardBusy('pull');
    const out = await this.#git(['pull', '--ff-only'], { timeoutMs: 45000 });
    this.#changed();
    this.bus?.publish('fs:change', { paths: [] });
    return { message: out.trim().split('\n').pop() || 'Up to date' };
  }

  async push() {
    await this.#git(['push'], { timeoutMs: 45000 });
    this.#changed();
    return { message: 'Pushed' };
  }
}
