#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { start } from '../server.mjs';
process.on('unhandledRejection', error => console.error('Unhandled rejection:', error?.name || 'Error'));
process.on('uncaughtException', error => console.error('Uncaught exception:', error?.name || 'Error'));

const help = `opencode-agent-flow 0.1.0 — live OpenCode V2 agent visualization

Usage: npx opencode-agent-flow [options]
  --server URL      OpenCode V2 URL (OPENCODE_URL; http://127.0.0.1:4096)
  --username NAME   Basic auth username (OPENCODE_SERVER_USERNAME; opencode)
  --port NUMBER     UI port (PORT; 3340)
  --host ADDRESS    UI bind address (127.0.0.1)
  --allowed-host HOST Allow an additional Host hostname (repeatable)
  --window HOURS    Recent activity window (WINDOW_HOURS; 4)
  --open            Open the UI in your default browser
  --demo            Use built-in fictional data; no upstream connection
  --help, -h        Show this help

Password: OPENCODE_SERVER_PASSWORD environment variable only.
The UI has no authentication. Keep the default loopback bind address.`;

try {
  const config = { server: process.env.OPENCODE_URL || 'http://127.0.0.1:4096', username: process.env.OPENCODE_SERVER_USERNAME || 'opencode', password: process.env.OPENCODE_SERVER_PASSWORD, port: process.env.PORT || 3340, host: '127.0.0.1', window: process.env.WINDOW_HOURS || 4, open: false, demo: false };
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const [flag, inline] = args[i].split(/=(.*)/s);
    if (['--help', '-h'].includes(flag)) { console.log(help); process.exit(0); }
    if (['--open', '--demo'].includes(flag)) { if (inline !== undefined) throw new Error(`${flag} does not take a value.`); config[flag.slice(2)] = true; continue; }
    if (!['--server', '--username', '--port', '--host', '--window', '--allowed-host'].includes(flag)) throw new Error('Unknown option. Use --help. Passwords are accepted only via OPENCODE_SERVER_PASSWORD.');
    const value = inline ?? args[++i];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}.`);
    if (flag === '--allowed-host') (config.allowedHosts ||= []).push(value); else config[flag.slice(2)] = value;
  }
  config.port = Number(config.port); config.window = Number(config.window);
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) throw new Error('--port must be an integer from 1 to 65535.');
  if (!Number.isFinite(config.window) || config.window <= 0) throw new Error('--window must be a positive number of hours.');
  let url;
  try { url = new URL(config.server); } catch { throw new Error('--server must be a valid HTTP(S) URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('--server must be HTTP(S), without credentials, query or fragment.');
  config.server = url.href.replace(/\/$/, '');
  if (config.host === '[::1]') config.host = '::1';
  if (!['127.0.0.1', 'localhost', '::1'].includes(config.host)) console.error('WARNING: UI has no authentication and exposes session data. Non-loopback bind requested.');
  if (config.password && url.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) console.error('WARNING: use HTTPS for a remote OpenCode server; Basic authentication is not encrypted over HTTP.');
  await start(config);
  if (config.open) {
    const target = `http://${config.host.includes(':') ? `[${config.host}]` : config.host}:${config.port}`;
    const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'rundll32' : 'xdg-open';
    const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', target] : [target];
    const child = spawn(command, args, { detached: true, stdio: 'ignore' }); child.on('error', () => console.error('Unable to open browser; open the UI URL manually.')); child.unref();
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
