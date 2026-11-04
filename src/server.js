#!/usr/bin/env node
import { existsSync } from 'node:fs';

// An install has no dependency tree and runs the bundle (npm run bundle); a checkout with its own runs the source.
const checkout = existsSync(new URL('../node_modules/@modelcontextprotocol/sdk/package.json', import.meta.url));
await import(checkout ? './main.js' : '../dist/server.js');
