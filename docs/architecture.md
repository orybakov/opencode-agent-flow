# Architecture

Agent Flow is a read-only backend-for-frontend (BFF) for OpenCode V2. Node.js
20+ serves static browser assets and aggregates the public HTTP API in memory.
There is no database access, build step, or runtime npm dependency.

## Data lifecycle

1. Check `/api/info` for a V2 server version. Authenticate with Basic only when
   an environment password is configured. Credentials never reach the browser.
2. Open one global `/api/event` SSE subscription before loading history.
3. Page `/api/session` descending by `time.updated`, stopping locally at the
   aggregation cutoff: the earliest of the activity window, 12 hours, and midnight.
4. Recover missing ancestors and recursively enumerate children of active roots,
   including dormant children. Fetch message pages with concurrency capped at four.
   Messages have no time filter; pagination stops locally after an old page.
5. Semantic SSE events mark affected sessions dirty. Coalesced GET requests replace
   authoritative session/message snapshots, avoiding double-counted usage and
   duplicated tool events. Reconnect uses exponential backoff (1–30 seconds), then
   resynchronizes snapshots. A 60-second reconciliation covers missed events.
6. Poll pending permissions and forms every five seconds for every known active
   session directory. Locations refer to the upstream server, not the BFF machine.

The selected-session endpoint lazily loads the complete descendant history,
including sessions outside the activity window. Default aggregates include only
the aggregation horizon; session-scoped aggregates include the selected tree.
The in-memory cache lasts for the process lifetime; no prompts or tool results
are written to disk. Unknown events are ignored or reconciled by snapshots.

## Browser contract

- `GET /api/state[?session=ID]`: roots, trees, grouped agents, last 200 events,
  token aggregates, pending approvals, permission health, upstream version/status.
- `GET /api/sessions`: recent root session picker summaries.
- `GET /api/stream[?session=ID]`: `event: state` snapshots and 15-second heartbeats.
- `GET /api/permission/request`: normalized pending permissions/forms.

Children with the same nonempty agent name under one parent form a group (`×N`).
Unnamed sessions retain distinct identities; empty unnamed children are hidden.
Group status precedence is waiting, working, idle, done. `agentCount` counts visible
groups including the root; `callCount` counts all descendant sessions including
the root. Group popovers preserve individual sessions and token totals.

Statuses use active-session snapshots, running tools, pending permissions/forms,
and final idle messages. Context is the latest assistant input plus cache read and
write; missing current usage is marked estimated. Costs use `prices.json` and are
always approximate (`≈ est.`), not provider billing.

## Rendering and security

Vanilla browser modules render all/session modes, event log, hourly token chart,
cache ratio, activity heatmap, estimated cost, ledger and accessible group popovers.
Vendored three.js powers WebGL flow connections with a Canvas fallback.

Static assets use an explicit allowlist. The BFF exposes only GET routes, not a
general upstream proxy. Loopback is the default; non-loopback binding warns that
the UI has no authentication. Use HTTPS for remote upstream Basic authentication.
See [API contract notes](opencode-v2-api-notes.md) for compatibility limitations.
