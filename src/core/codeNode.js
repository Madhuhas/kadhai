import { Worker } from 'node:worker_threads';

const TIME_LIMIT_MS = 5000;
const MEMORY_MB = 64;

/**
 * The body of a flow's code node runs here: in a worker thread of its own,
 * inside a fresh `vm` context that holds only the flow's data, with a time
 * and a memory limit. The worker is terminated afterwards (or when the limit
 * is hit), so a runaway loop cannot freeze Kadhai.
 *
 * This keeps a mistake contained; it is not a wall against hostile code.
 * The code comes from the operator, who wrote it in the dashboard - never from
 * a model and never from what a trigger delivered (that is only `input`).
 */
const WORKER = `
const { parentPort, workerData } = require('node:worker_threads');
const vm = require('node:vm');
const { code, input, trigger, nodes } = workerData;
const logs = [];
const sandbox = {
  input, trigger, nodes,
  node: (name) => nodes[name],
  console: { log: (...a) => logs.length < 50 && logs.push(a.map((x) => typeof x === 'string' ? x : JSON.stringify(x)).join(' ').slice(0, 500)) },
};
try {
  const result = vm.runInNewContext('(function () {"use strict";\\n' + code + '\\n})()', sandbox, { timeout: ${TIME_LIMIT_MS}, filename: 'code-node.js' });
  parentPort.postMessage({ ok: true, result: JSON.parse(JSON.stringify(result === undefined ? null : result)), logs });
} catch (err) {
  parentPort.postMessage({ ok: false, error: String(err && err.message || err), logs });
}
`;

/** Run a code node's body. Resolves with { result, logs } or rejects with the code's own error. */
export function runCode(code, { input, trigger, nodes }, signal) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER, { eval: true, workerData: { code, input, trigger, nodes }, resourceLimits: { maxOldGenerationSizeMb: MEMORY_MB }, stdout: true, stderr: true });
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      worker.terminate().catch(() => {});
      fn(value);
    };
    // The vm timeout covers a loop in plain code; this one covers everything else.
    const timer = setTimeout(() => finish(reject, new Error(`the code ran for more than ${TIME_LIMIT_MS / 1000} s`)), TIME_LIMIT_MS + 1500);
    const onAbort = () => finish(reject, new Error('stopped'));
    signal?.addEventListener('abort', onAbort);
    worker.once('message', (msg) => (msg.ok ? finish(resolve, { result: msg.result, logs: msg.logs }) : finish(reject, new Error(msg.error))));
    worker.once('error', (err) => finish(reject, new Error(err.code === 'ERR_WORKER_OUT_OF_MEMORY' ? `the code used more than ${MEMORY_MB} MB` : err.message)));
    worker.once('exit', (code) => finish(reject, new Error(`the code stopped unexpectedly (${code})`)));
  });
}
