#!/usr/bin/env node
// ONEGP_MCP_AUTO_UPDATE=0 runs this package's own server and never moves to another version.
if (process.env.ONEGP_MCP_AUTO_UPDATE === '0') await import('./server.js');
else {
  const { startLauncher } = await import('./launcher.js');
  process.exit(await startLauncher().done);
}
