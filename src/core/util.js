import { spawn } from 'node:child_process';

/** Logs go to stderr so the stdio transports (MCP, ACP) keep stdout clean for JSON-RPC. */
export const log = {
  info: (...args) => console.error('[kadhai]', ...args),
  warn: (...args) => console.error('[kadhai] WARN', ...args),
};

export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Stop a child process and everything it started. On Windows a command launched through a
 * shell is a child of cmd.exe, so killing the child alone would leave the real program running.
 */
export function killTree(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => {});
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL'); // the whole process group, when the child leads one
  } catch {
    child.kill('SIGKILL');
  }
}

export function clip(text, max) {
  const s = String(text ?? '');
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** Rough token estimate for providers that do not report usage. */
export const estimateTokens = (text) => Math.ceil(String(text ?? '').length / 4);

/** Text made safe to put inside HTML (and inside a quoted attribute), for the few pages the server writes itself. */
export const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
