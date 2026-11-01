/** A unified diff for the terminal: additions green, removals red, hunk headers cyan. */
export function renderDiffText(patch, c) {
  return String(patch)
    .split('\n')
    .map((l) => (l.startsWith('@@') ? c.cyan(l) : /^(diff |index |--- |\+\+\+ )/.test(l) ? c.bold(l) : l.startsWith('+') ? c.green(l) : l.startsWith('-') ? c.red(l) : l))
    .join('\n');
}
