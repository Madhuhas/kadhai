#!/usr/bin/env node
// Kadhai as an Agent Client Protocol agent over stdio.
// Usage (from an ACP client such as Zed):  node bin/acp-agent.js [--mock]
import { createEngine } from '../src/core/engine.js';
import { startAcpAgent } from '../src/protocols/acpAgent.js';

startAcpAgent({
  createEngine,
  engineOptions: { persist: true, sealSecrets: true, ...(process.argv.includes('--mock') ? { mock: true } : {}) },
});
