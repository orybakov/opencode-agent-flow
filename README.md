# opencode-agent-flow

[![npm version](https://img.shields.io/npm/v/opencode-agent-flow)](https://www.npmjs.com/package/opencode-agent-flow)
[![CI](https://github.com/orybakov/opencode-agent-flow/actions/workflows/ci.yml/badge.svg)](https://github.com/orybakov/opencode-agent-flow/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/node/v/opencode-agent-flow)](https://nodejs.org/)

**Watch your agents work, not just their logs.**

> **Note:** opencode-agent-flow is a community project. It is not built by the
> OpenCode team and is not affiliated with them in any way.

A live, read-only visualization of OpenCode V2 orchestration. See agent trees,
grouped parallel calls, current tools, approval waits, token usage and estimated
costs in one WebGL dashboard. Connect to a local or remote OpenCode server using
only its public HTTP API and SSE—no database access required.

Zero runtime npm dependencies. Node.js 20+; no frontend build step.

![Live Agent Flow demo: session tree, active tools and animated token transport](https://raw.githubusercontent.com/orybakov/opencode-agent-flow/main/docs/demo.gif)

[Watch the MP4 demo](https://github.com/orybakov/opencode-agent-flow/raw/refs/heads/main/docs/demo.mp4) · fictional data; no credentials or private sessions.

## Quick start

### Local OpenCode server

Start OpenCode V2 in one terminal:

```sh
opencode serve --hostname 127.0.0.1 --port 4096
```

In another terminal, set `OPENCODE_SERVER_PASSWORD` to the password printed by
that server (see below), then run:

```sh
npx opencode-agent-flow --open
```

### Remote OpenCode server

Set `OPENCODE_SERVER_PASSWORD` in your local terminal to the remote server's
password, then connect over HTTPS:

```sh
npx opencode-agent-flow --server https://opencode.example.org --open
```

The dashboard itself stays on loopback. The remote server must expose the V2
HTTP API and SSE; no database access or browser-side credentials are needed.

For a preview without any OpenCode server: `npx opencode-agent-flow --demo --open`.
Demo tools, agent states and events cycle every 1.5 seconds.

Open <http://127.0.0.1:3340>. For an unpublished local checkout:
`node bin/cli.mjs --demo`.

## Where do I get the password?

On a clean **OpenCode 2.0.32**, `opencode serve` generates a password when none
is configured and prints it in the launching terminal on the **`server password`**
line, after the listening URL. Copy that value privately into the
`OPENCODE_SERVER_PASSWORD` environment variable of the Agent Flow process.
The default HTTP Basic username is **`opencode`**; use `--username` or
`OPENCODE_SERVER_USERNAME` if yours differs.

Alternatively, choose a strong password yourself and set
`OPENCODE_SERVER_PASSWORD` **before starting `opencode serve`**, then supply the
same value to Agent Flow. For example, after loading it from your secret manager
into a shell variable (POSIX shell):

```sh
export OPENCODE_SERVER_PASSWORD="$YOUR_OPENCODE_PASSWORD"
opencode serve --hostname 127.0.0.1 --port 4096
# In another terminal, export the same environment variable, then:
npx opencode-agent-flow --open
```

In PowerShell, set an environment variable with
`$env:OPENCODE_SERVER_PASSWORD = $YourOpenCodePassword` instead. Do not put the
password in a URL, CLI flag, screenshot, issue or committed config. Agent Flow
does not discover credentials from the OpenCode database or managed service.
An already-running server does not inherit environment changes: set the value
when launching it, not only when launching this dashboard.

The generated-password output and explicit environment password were verified
against an isolated 2.0.32 installation. Current V2 docs describe the
[client/server model](https://opencode.ai/v2/docs/cli) and
[foreground server environment](https://opencode.ai/v2/docs/network#foreground);
`opencode serve` is distinct from the automatically managed background service.

## Options

| Flag | Environment fallback | Default |
| --- | --- | --- |
| `--server URL` | `OPENCODE_URL` | `http://127.0.0.1:4096` |
| `--username NAME` | `OPENCODE_SERVER_USERNAME` | `opencode` |
| `--port NUMBER` | `PORT` | `3340` |
| `--host ADDRESS` | — | `127.0.0.1` |
| `--allowed-host HOST` (repeatable) | — | Additional allowed hostname |
| `--window HOURS` | `WINDOW_HOURS` | `4` |
| `--open` | — | Open the browser |
| `--demo` | — | Built-in fictional data |
| `--help` | — | Show usage |

`OPENCODE_SERVER_PASSWORD` is accepted **only through the environment**. Without
it the BFF tries unauthenticated access; rejected access leaves the UI connecting
while the backend retries.

## How it works

A thin Node backend-for-frontend (BFF) loads paginated session/message history,
keeps one global upstream SSE subscription, and sends aggregated snapshots to
the browser. Reconnects use exponential backoff (1–30 seconds), reset only after
a connection lasts at least 30 seconds. Full resynchronization is limited to
once per 10 seconds; initial connection failures retry with the same backoff.
A periodic reconciliation (every 60 seconds) catches missed events. Permissions and forms are
polled for each active location. All/session modes, grouped `×N` agents and
individual-call popovers preserve the orchestration hierarchy.

`N agents · M calls` counts visible groups and all sessions respectively, each
including the root. The recent activity window applies to root selection; explicit
session mode loads the complete selected tree, including dormant children.

## Compatibility

- Verified with **OpenCode 2.0.30 and 2.0.32** on Linux (official V2 npm package:
  `@opencode/cli`, not the V1 `opencode-ai` package).
- Tests pass locally on Linux with **Node.js 20, 22 and 24**.
- CI runs the test suite, syntax checks and package dry-run on Linux with Node
  20/22/24, plus **macOS and Windows with Node 22**. Those platforms are covered
  by CI tests only, not a verified live OpenCode/browser deployment; the first
  hosted run happens after push.
- The V2 HTTP API is **experimental**; future changes may require adapter updates.
  Non-V2 servers remain in connecting state.

## Security and limitations

- Loopback binding by default. **The UI has no authentication**; exposing it on
  another interface reveals session titles, paths and activity. Use an authenticated
  reverse proxy for shared deployments.
- The upstream password stays in Node, never in browser responses or URLs.
  Use HTTPS to protect Basic authentication to remote servers.
- Host/Origin checks reject unapproved hostnames (DNS-rebinding protection).
  Extra hostnames require `--allowed-host`; the configured port is enforced.
- The UI displays session titles, commands and paths. Secret redaction is
  **best-effort**, not a guarantee. Do not expose it to a network without a
  reverse proxy providing authentication. Report vulnerabilities via
  [GitHub Security Advisories](https://github.com/orybakov/opencode-agent-flow/security/advisories/new).
- SSE is live-only, without replay. Reconciliation recovers durable snapshots,
  not every transient event. No historical permission-decision journal is available.
- Token/cost panels use available history (at least 12 hours/current day for
  default aggregates). Context size is approximate, not an exact provider meter.

## Cost estimates

`prices.json` supplies editable USD-per-million input/output/cache-read rates and
context limits. The UI labels costs **`≈ est.`**: pricing may be outdated, provider
subscriptions may differ, and these figures are not billing statements.

## Development

```sh
node bin/cli.mjs --demo
node scripts/check-syntax.mjs
npm test
npm pack --dry-run
```

See [architecture](docs/architecture.md) and
[public API notes](docs/opencode-v2-api-notes.md). Vendored browser modules avoid
CDN/network dependencies; there is no install or bundling step.

## Roadmap

- Ensemble team views and richer orchestration context.
- Memory and rendering performance for thousands of sessions.
- A small, ready-to-run Docker image.
- Additional themes and visual customization.

## License and acknowledgements

MIT © 2026 orybakov. WebGL rendering uses [three.js](https://threejs.org/),
vendored under its MIT license in `public/vendor/three/LICENSE`.
