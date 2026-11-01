import { execFile } from 'node:child_process';

/**
 * Syntax problems in the workspace's files, for the dashboard's problems view and the editor's
 * margin: JSON is parsed here, JavaScript is given to `node --check` on stdin, which parses it and
 * never runs it. That is not a command from a model or the browser - the program and its flags
 * are fixed here, and the code arrives as input, never as an argument - so it does not go through
 * Runner (no approval card for a check nobody asked to approve, nothing in the terminal).
 *
 * -> [{ path, line, col, message, source }]
 */

const CHECKED = /\.(m?js|cjs|json)$/i;
// JSON with comments by design: checking them as JSON would report every comment.
const JSONC = /(^|\/)(tsconfig[^/]*|jsconfig[^/]*|\.eslintrc[^/]*|devcontainer)\.json$|(^|\/)\.vscode\/|\.jsonc$/i;
const MAX_SCAN = 300;
const CHECK_TIMEOUT_MS = 8000;

export const isCheckable = (path) => CHECKED.test(path) && !JSONC.test(path);

function jsonProblem(path, text) {
  try {
    JSON.parse(text.replace(/^\uFEFF/, ''));
    return [];
  } catch (err) {
    const message = err.message.replace(/^JSON\.parse: /, '');
    let m = /line (\d+) column (\d+)/.exec(message);
    let line = m ? Number(m[1]) : 1;
    let col = m ? Number(m[2]) : 1;
    if (!m && (m = /position (\d+)/.exec(message))) {
      const before = text.slice(0, Number(m[1]));
      line = before.split('\n').length;
      col = before.length - before.lastIndexOf('\n');
    }
    return [{ path, line, col, message: message.replace(/\s*\(line \d+ column \d+\)/, ''), source: 'JSON' }];
  }
}

/**
 * The code goes in on stdin, so node reads nothing from the folder: no package.json lookup (a
 * broken one made every .js file "fail" on node's own line 132 - seen in the first browser check)
 * and no path at all. Module or CommonJS comes from the extension, or for .js from the code itself.
 */
function nodeCheck(path, content) {
  const module = /\.mjs$/i.test(path) || (!/\.cjs$/i.test(path) && /^\s*(import\s*[\w{*'"]|export\s)/m.test(content));
  return new Promise((resolve) => {
    const child = execFile(process.execPath, ['--check', `--input-type=${module ? 'module' : 'commonjs'}`, '-'], { timeout: CHECK_TIMEOUT_MS, windowsHide: true, env: { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '' } }, (err, _out, stderr) => {
      if (!err) return resolve([]);
      if (err.killed) return resolve([]); // too slow to say: report nothing rather than a guess
      // [stdin]:3
      //   let x = ;
      //           ^
      //
      // SyntaxError: Unexpected token ';'
      const lines = String(stderr).split(/\r?\n/);
      const head = lines.findIndex((l) => /^\[stdin\]:\d+$/.test(l));
      const line = head >= 0 ? Number(/:(\d+)$/.exec(lines[head])[1]) : 1;
      const caret = head >= 0 ? lines.slice(head + 1, head + 4).find((l) => /^\s*\^+\s*$/.test(l)) : null;
      const col = caret ? caret.indexOf('^') + 1 : 1;
      const message = lines.find((l) => /^\w*Error: /.test(l)) ?? lines.find((l) => l && !/^\(node:\d+\)|^\(Use `node/.test(l)) ?? 'Syntax error';
      resolve([{ path, line, col, message: message.trim(), source: 'node --check' }]);
    });
    child.stdin.on('error', () => {}); // the child may exit before reading it all
    child.stdin.end(content);
  });
}

/** The problems in one file (none for a file it does not check). */
export async function checkFile(workspace, rel) {
  if (!isCheckable(rel)) return [];
  const file = await workspace.readFile(rel); // the sandbox and symlink checks
  if (file.binary || file.truncated) return [];
  if (/\.json$/i.test(file.path)) return jsonProblem(file.path, file.content);
  return nodeCheck(file.path, file.content);
}

/** Every checkable file in the folder, a few at a time. -> { problems, checked, capped } */
export async function checkAll(workspace) {
  const all = (await workspace.tree({ maxEntries: 20000, maxDepth: 20 })).filter((e) => e.type === 'file' && isCheckable(e.path)).map((e) => e.path);
  const paths = all.slice(0, MAX_SCAN);
  const problems = [];
  let next = 0;
  const lane = async () => {
    while (next < paths.length) {
      const path = paths[next++];
      problems.push(...(await checkFile(workspace, path).catch(() => [])));
    }
  };
  await Promise.all([lane(), lane(), lane(), lane()]);
  problems.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
  return { problems, checked: paths.length, capped: all.length > MAX_SCAN };
}
