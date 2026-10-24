/** Minimal synchronous pub/sub. Everything the UI, MCP and ACP layers show flows through here. */
export class EventBus {
  #subscribers = new Set();

  subscribe(fn) {
    this.#subscribers.add(fn);
    return () => this.#subscribers.delete(fn);
  }

  publish(type, data = {}) {
    const event = { type, data, ts: Date.now() };
    for (const fn of this.#subscribers) {
      try {
        fn(event);
      } catch {
        // A broken subscriber must never take the engine down with it.
      }
    }
  }
}
