import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { log } from './util.js';

const DIFF_CAP = 300000;
const EXCLUDES = ['.kadhai/', 'memory.md', 'node_modules/', ''].join('\n');
// The only things that may name a checkpoint. Ids come back from a file in the folder, so they are checked.
const COMMIT_ID = /^[0-9a-f]{7,64}$/;
const commitId = (value) => {
  if (!COMMIT_ID.test(String(value))) throw new Error('That is not a checkpoint of this folder');
  return value;
};

/**
 * Workspace checkpoints, kept in a *shadow* git repository under
 * .kadhai/git. Because it uses its own git dir it never touches a .git the
 * workspace may already have (which matters in ACP mode, where the workspace is
 * the user's real project). Requires git on PATH; without it checkpoints are
 * simply unavailable and everything else carries on.
 */
export class Checkpoints {
  #chain = Promise.resolve();

  constructor({ root }) {
    this.root = root;
    this.gitDir = path.join(root, '.kadhai', 'git');
    this.available = false;
  }

  /** `workTree` / `index`: a CLI agent's private copy and its own index (see exportTo); never the workspace's. */
  #git(args, { workTree = this.root, index = null, raw = false } = {}) {
    const base = [
      '--git-dir', this.gitDir,
      '--work-tree', workTree,
      // Byte-exact snapshots, a fixed identity, and no surprises from user config.
      '-c', 'core.autocrlf=false',
      '-c', 'core.safecrlf=false',
      '-c', 'core.longpaths=true',
      '-c', 'core.quotepath=false',
      '-c', 'commit.gpgsign=false',
      // The folder may have come from someone else: nothing in it gets to run a program.
      '-c', `core.hooksPath=${path.join(this.gitDir, 'no-hooks')}`,
      '-c', 'core.fsmonitor=false',
      '-c', 'user.name=Kadhai',
      '-c', 'user.email=kadhai@localhost',
    ];
    return new Promise((resolve, reject) => {
      execFile(
        'git',
        [...base, ...args],
        {
          cwd: this.root,
          windowsHide: true,
          maxBuffer: 32 * 1024 * 1024,
          encoding: raw ? 'buffer' : 'utf8',
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...(index ? { GIT_INDEX_FILE: index } : {}) },
        },
        (err, stdout, stderr) => (err ? reject(new Error((String(stderr ?? '') || err.message).trim().split('\n')[0])) : resolve(stdout)),
      );
    });
  }

  /** One git operation at a time: the index is not safe for concurrent use. */
  #serial(fn) {
    const run = this.#chain.then(fn);
    this.#chain = run.catch(() => {});
    return run;
  }

  async init() {
    try {
      await this.#git(['--version']);
      // The shadow repository is ours alone, so its settings are written fresh every time: a
      // config that arrived with the folder (and could name programs for git to run) is discarded.
      await fs.rm(path.join(this.gitDir, 'config'), { force: true });
      await this.#git(['init', '-q']);
      await fs.mkdir(path.join(this.gitDir, 'info'), { recursive: true });
      await fs.writeFile(path.join(this.gitDir, 'info', 'exclude'), EXCLUDES);
      this.available = true;
    } catch (err) {
      this.available = false;
      log.warn(`Checkpoints disabled (git not usable: ${err.message})`);
    }
  }

  /** Record the workspace as it is now. Returns the commit id, or null if unavailable. */
  snapshot(message) {
    if (!this.available) return Promise.resolve(null);
    return this.#serial(async () => {
      try {
        await this.#git(['add', '-A']);
        await this.#git(['commit', '-q', '--allow-empty', '-m', message.slice(0, 200)]);
        return (await this.#git(['rev-parse', 'HEAD'])).trim();
      } catch (err) {
        log.warn(`Checkpoint failed: ${err.message}`);
        return null;
      }
    });
  }

  /** What changed between two checkpoints. */
  diff(from, to) {
    return this.#serial(async () => {
      commitId(from);
      commitId(to);
      const names = await this.#git(['diff', '--no-color', '--no-ext-diff', '--name-status', from, to]);
      const patch = await this.#git(['diff', '--no-color', '--no-ext-diff', from, to]);
      return {
        files: names
          .split('\n')
          .filter(Boolean)
          .map((line) => {
            const [status, ...rest] = line.split('\t');
            return { status: status[0], path: rest.at(-1) };
          }),
        patch: patch.slice(0, DIFF_CAP),
        truncated: patch.length > DIFF_CAP,
      };
    });
  }

  // ---------------------------------------------- private copies for CLI agents

  /**
   * Write the files of checkpoint `commit` into `dir` (an empty folder outside the workspace),
   * using an index of its own: the shadow repository's index and the workspace are not touched,
   * and the copy has no .git, so nothing in it leads back here.
   */
  exportTo(commit, dir, index) {
    return this.#serial(async () => {
      commitId(commit);
      await fs.mkdir(dir, { recursive: true });
      await this.#git(['read-tree', commit], { workTree: dir, index });
      await this.#git(['checkout-index', '-a', '-f'], { workTree: dir, index });
    });
  }

  /** What changed in a copy made by exportTo, against the checkpoint it came from: [{ status: 'A'|'M'|'D', path }]. */
  changesIn(dir, index, commit) {
    return this.#serial(async () => {
      commitId(commit);
      // The shadow repository's excludes apply here too: node_modules and the like are never "changes".
      await this.#git(['add', '-A'], { workTree: dir, index });
      const names = await this.#git(['diff', '--cached', '--no-renames', '--no-ext-diff', '--name-status', commit], { workTree: dir, index });
      return names
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [status, ...rest] = line.split('\t');
          return { status: status[0] === 'D' ? 'D' : status[0] === 'A' ? 'A' : 'M', path: rest.join('\t') };
        });
    });
  }

  /** A file as it was in a checkpoint, as text, or null if it was not there. */
  async textAt(commit, file) {
    commitId(commit);
    try {
      return (await this.#git(['cat-file', 'blob', `${commit}:${file}`], { raw: true })).toString('utf8');
    } catch {
      return null;
    }
  }

  /**
   * Three-way merge of one text file: `ours` (the workspace now), `base` (the checkpoint the copy
   * came from), `theirs` (the copy). Returns { text, clean }. `scratch` is a folder for the three
   * temp files. No repository is involved.
   */
  async merge(ours, base, theirs, scratch) {
    const names = ['ours', 'base', 'theirs'].map((n) => path.join(scratch, `merge-${n}`));
    await Promise.all([ours, base, theirs].map((text, i) => fs.writeFile(names[i], text)));
    return new Promise((resolve) => {
      execFile('git', ['merge-file', '-p', ...names], { windowsHide: true, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
        // merge-file exits with the number of conflicts (negative on a real error).
        resolve({ text: stdout, clean: !err });
      });
    });
  }

  /**
   * Put the workspace back to a checkpoint. The current state is committed
   * first, so even an undo can be recovered from the shadow repository.
   */
  restore(commit) {
    return this.#serial(async () => {
      commitId(commit);
      await this.#git(['add', '-A']);
      await this.#git(['commit', '-q', '--allow-empty', '-m', 'before undo']);
      await this.#git(['reset', '-q', '--hard', commit]);
    });
  }
}
