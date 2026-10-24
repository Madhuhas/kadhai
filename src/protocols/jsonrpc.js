import readline from 'node:readline';

export class RpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
    this.data = data;
  }
}

/**
 * Transport-agnostic JSON-RPC 2.0 peer. Give it a `send` function and feed it
 * parsed messages through `receive`; it plays server and client at once.
 * Shared by the MCP server, the MCP client and the ACP agent.
 */
export class JsonRpcPeer {
  #nextId = 1;
  #pending = new Map();

  constructor({ send, methods = {}, notifications = {} }) {
    this.send = send;
    this.methods = methods;
    this.notifications = notifications;
  }

  async receive(message) {
    if (Array.isArray(message)) {
      await Promise.all(message.map((m) => this.receive(m)));
      return;
    }
    if (!message || typeof message !== 'object') {
      this.send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } });
      return;
    }

    if (typeof message.method === 'string') {
      const isRequest = message.id !== undefined && message.id !== null;
      if (!isRequest) {
        try {
          await this.notifications[message.method]?.(message.params ?? {});
        } catch {
          // Notifications have no reply channel; errors stay local.
        }
        return;
      }
      try {
        const handler = this.methods[message.method];
        if (!handler) throw new RpcError(-32601, `Method not found: ${message.method}`);
        const result = await handler(message.params ?? {});
        this.send({ jsonrpc: '2.0', id: message.id, result: result ?? {} });
      } catch (err) {
        const code = Number.isInteger(err.code) ? err.code : -32603;
        this.send({ jsonrpc: '2.0', id: message.id, error: { code, message: err.message, data: err.data } });
      }
      return;
    }

    const waiter = this.#pending.get(message.id);
    if (!waiter) return;
    this.#pending.delete(message.id);
    clearTimeout(waiter.timer);
    if (message.error) waiter.reject(new RpcError(message.error.code, message.error.message, message.error.data));
    else waiter.resolve(message.result);
  }

  request(method, params, { timeoutMs = 30000 } = {}) {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new RpcError(-32001, `${method} timed out`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method, params) {
    this.send({ jsonrpc: '2.0', method, params });
  }

  close(reason = 'Connection closed') {
    for (const waiter of this.#pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new RpcError(-32000, reason));
    }
    this.#pending.clear();
  }
}

/** Newline-delimited JSON framing, as used by both MCP and ACP over stdio. */
export function readLines(stream, onMessage, onClose) {
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return; // Not ours - e.g. a child process logging to stdout.
    }
    onMessage(message);
  });
  rl.on('close', () => onClose?.());
  return rl;
}

export const lineWriter = (stream) => (message) => {
  if (stream.writable) stream.write(`${JSON.stringify(message)}\n`);
};

/** Wire a peer to a pair of stdio streams. Requests are handled concurrently. */
export function stdioPeer({ methods, notifications, input = process.stdin, output = process.stdout, onClose }) {
  const peer = new JsonRpcPeer({ send: lineWriter(output), methods, notifications });
  readLines(
    input,
    (message) => {
      peer.receive(message);
    },
    onClose,
  );
  return peer;
}
