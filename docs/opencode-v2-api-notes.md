# OpenCode V2 public API: contributor notes

Contract verified against OpenCode **2.0.30** and clean **2.0.32**. The server describes this HTTP API
as experimental. Version checks reject non-V2 servers but do not guarantee that
every future V2 revision preserves this contract.

## HTTP snapshots

| Endpoint | Response and important details |
| --- | --- |
| `/api/info` | Server `version`; OpenAPI info.version is not the server version |
| `/api/session?order=desc&limit=100` | `{data: Session[], cursor:{previous,next}}`, ordered by time.updated then ID |
| `/api/session?parentID=ID` | Children, also paginated; parentID=null lists roots |
| `/api/session/ID` | `{data: Session}` |
| `/api/session/ID/message?order=desc&limit=100` | `{data: Message[],cursor}`, sequence order within a session |
| `/api/session/active` | `{data: {sessionID: {type:"running"}}}` |
| `/api/permission/request?location[directory]=PATH` | `{location,data: Permission[]}` |
| `/api/form?location[directory]=PATH` | `{location,data: Form[]}` |

Subsequent pages use opaque `cursor` **without order**. Stop on empty pages as
well as null cursors: the final nonempty page may still contain a next cursor.
There are no session/message time filters. Apply cutoffs locally. Archived
sessions are not automatically excluded. A session directory is
`session.location.directory`; parentID is a tree edge, while fork is not.
Old descendants must be loaded independently of an updated-time cutoff.

Messages contain `id`, `type`, `time.created`, and assistant `content`, `model`,
`tokens`, optional `finish`, `time.streamed/completed`. Tool content contains
`id`, `name`, `state.input/status`, `time.created/ran/completed`. Statuses are
streaming, running, completed, error; streaming input can be a JSON string.
Unfiltered history includes idle messages, although `type=idle` is rejected.
The public API does not expose message row update timestamps or sequence fields.

Tokens are `{input,output,reasoning,cache:{read,write}}`. Session token totals are
cumulative: replace them, never add successive usage snapshots. A latest
assistant token snapshot approximates context size. Model cost can be zero;
local pricing is an estimate, not billing.

Permissions and forms are **location-scoped**. Omitting location only accesses
the server's default directory, not every session. Permission resources use
`resources: string[]`; forms contain id, sessionID, title and fields. Pending
forms count as waiting too. Session-scoped alternatives exist at
`/api/session/ID/permission` and `/api/session/ID/form`.

## Global event stream

`GET /api/event` covers all locations with one subscription. Frames use `data:`
containing JSON `{id,created,type,location?,data,durable?}`. The first frame is
`server.connected`. Heartbeats are comments. There is no documented replay,
time filter, cursor, or Last-Event-ID recovery; JSON event IDs do not imply replay.
Slow readers may be disconnected. The BFF must reconnect and reload snapshots.

Relevant event families include:

- session.created/deleted/renamed/moved, agent.selected/model.selected
- session.step.started/streamed/ended/failed and session.usage.updated
- session.tool.input.started/delta/ended, tool.called/progress/success/failed
- session.text.started/delta/ended, reasoning.started/delta/ended
- session.execution.started/succeeded/failed/interrupted, session.status/idle
- session.inbox.*, permission.asked/replied, form.created/replied/cancelled

Most data carries `sessionID`; assistant events carry `assistantMessageID` and
tool events carry tool `id`. form.created nests its session ID in `data.form`.
V1-style message.updated and message.part.updated events are not available.
Invalidating per-session snapshots avoids implementing a fragile full event store.
Do not log reasoning, prompts, tool outputs, form answers or authorization headers.

The experimental session log endpoint did not yield historical events in the
verified deployment (only log.synced); it is not used as a recovery guarantee.
Historical permission decisions and transient streaming deltas are not recoverable
from standard snapshots. Exact message row update timestamps cannot be reproduced.

## Authentication and portability

Basic authentication works with the configured server username/password. A
protected server returns 401 without credentials. Bearer authentication is not
equivalent. Keep credentials in environment variables and use HTTPS remotely.
Native browser EventSource cannot set Authorization, and arbitrary origins may
not be allowed by upstream CORS. The same-origin Node BFF avoids both issues.
It never forwards credentials to browser clients and performs only GET requests.

Verified against 2.0.30: version, session/active snapshots, pagination, idle
messages, location-scoped pending requests, Basic authentication and a live global
stream containing multiple locations. Remote deployments and future versions
require additional verification; capability changes should fail clearly.

### Clean 2.0.32 verification (2026-10-17)

Installed official `@opencode/cli@2.0.32` locally with isolated HOME/XDG paths;
the similarly named `opencode-ai` npm package is V1. No existing service or data
was used. Root and linked child sessions were created through `POST /api/session`
without model calls. One CLIProxy `gemini-3.8-flash-high` turn read a fixture
README using `read` and completed successfully.

Session/message/active snapshots and the global SSE envelope still match the
contract above. Observed 22 frames including `session.tool.input.started/ended`,
`session.tool.called/success`, `session.step.*`, `session.usage.updated`,
`session.text.*`, and `session.execution.started/succeeded`. Tool events retain
`data.sessionID`, `data.assistantMessageID`, and `data.id`. The BFF emitted four
live state frames (idle → working → tool completion → idle), retained the child,
and reported 10,301 input tokens, matching the two assistant snapshots. Upstream
output tokens were zero despite a text answer; the BFF preserves reported usage
rather than inventing output counts.

Both `/api/state` and `/api/state?session=ID`, `/api/sessions`, and the browser
session view were verified. Browser viewport: 1440×900; no console errors or
failed requests (headless WebGL ReadPixels performance warnings only).

Authentication caveat: an unset password does **not** produce an unprotected
server on this clean version. `serve` generates a password and unauthenticated
requests return 401. Basic auth works with both its generated password and an
explicit `OPENCODE_SERVER_PASSWORD`; a real password-free upstream scenario was
therefore unavailable. Wrong credentials now produce an actionable 401 log
without exposing credentials, while retaining the existing retry behavior.
Successful initialization logs the negotiated server version. No event-schema
adapter changes were needed. Multi-location streams and permission/form flows
were not re-exercised on 2.0.32; their earlier 2.0.30 checks remain the evidence.

Sources: [API](https://opencode.ai/v2/docs/api),
[client](https://opencode.ai/v2/docs/build/client), published
`@opencode/client@2.0.30` event types, and live read-only HTTP/SSE observations.
