# Memory profiling: 2026-10-18

Read-only live verification against OpenCode 2.0.30 at `127.0.0.1:4096`,
Node.js 26.11.1, four-hour window: six visible root sessions, 26 rendered groups,
71 underlying sessions initially. One root aged out of the sliding four-hour UI
window later in the experiment; dormant descendants outside the day cutoff
could then be evicted (62 summaries in the final full-history snapshot).
The deployed `:3340` service was not restarted or edited.
Temporary instances used ports 3396–3398. No GC/heap-size flags were used as a fix.

## Evidence and cause

- Baseline `fb8db8e`: the first profiling run reached 211 MiB RSS after three
  minutes while heapUsed was only 24.1 MiB. Taking a heap snapshot reduced
  heapUsed to 11.7 MiB, but RSS remained 168.7 MiB. This is primarily allocation
  peak/high-water retention, not a 200 MiB live message cache.
- Dominator analysis of the baseline snapshot: static Buffer cache 855,552 B,
  agent cache 251,696 B, row cache 92,840 B, serialized signature 192,392 B,
  snapshot 51,200 B. Scoped snapshots/full-history scopes were empty. Strings
  accounted for 6,294,471 B; the largest individual string was Undici's bundled
  source (817,329 B), not a retained tool output. Shared references mean the
  exclusive retained sizes of the message Map alone undercount its data.
- Reading the first `limit=100` message page of each of the 71 sessions transferred
  33,329,902 B in total; the largest page was 3,651,549 B. `response.json()` fully
  materialized each page before trimming, with four loads in flight. The first
  SSE handshake also forced a second full history scan immediately after startup.
- Streaming projection alone still left approximately 113 MiB RSS after three
  minutes. Native HTTP(S), smaller pages and bounded loading were also necessary;
  the intermediate native-HTTP run reached 82.4 MiB RSS (96.9 MiB peak).
- The reduced-history snapshot retained 483,024 B exclusively under `summaries`,
  177,416 B under the agent cache, and 13,520 B under the row cache. Snapshot/GC
  heapUsed was approximately 9.6 MiB. Static Buffers were already appropriate and
  were not the source of excess memory.
- The final full-history stress snapshot retained 984,520 B under all 62
  summaries combined, 176,480 B under the agent cache and 24,040 B under the row
  cache; no raw histories or large output caches appeared as major retainers.

## Method

A temporary preload recorded `process.memoryUsage()` before application imports,
immediately after the first complete sync, and 180 seconds after that sync. A
20 ms RSS sampler and `/proc/PID/status` VmHWM tracked peaks. The baseline was a
clean `git archive fb8db8e` with the same upstream/environment. Heap snapshots
and detailed measurements remain private under `/tmp/opencode`, not in Git.

Inspector attachment and especially heap snapshots increase RSS themselves.
The final timing run therefore used only the preload plus
`--heapsnapshot-signal=SIGUSR2`; snapshots were taken **after** the timed points.
Reported workload peaks exclude snapshot/profiler overhead. The original
baseline had an unattached inspector listener, which does not explain its
roughly 100 MiB larger peak.

## Timed measurements

All values are **MiB** (1,048,576 bytes). Baseline is `fb8db8e`; after is the
final code including the initial-handshake and discarded-allocation fixes.

| Build / point | RSS | heapUsed | external | arrayBuffers | VmHWM |
| --- | ---: | ---: | ---: | ---: | ---: |
| Before / startup | 45.9 | 4.6 | 2.0 | 0.1 | 46.4 |
| After / startup | 47.7 | 4.7 | 2.0 | 0.1 | 48.3 |
| Before / first sync | 168.3 | 25.7 | 26.3 | 13.9 | 175.8 |
| After / first sync | 88.2 | 11.7 | 5.9 | 1.7 | 89.9 |
| Before / +180 s | 170.2 | 15.0 | 6.1 | 1.9 | 212.4 |
| After / +180 s | 89.8 | 14.6 | 6.1 | 1.9 | 99.5 |

Thus final three-minute RSS was 94,142,464 B; the recorded workload peak was
104,382,464 B (99.5 MiB). In a separate complete timed run before the last
allocation-only refinement, the six-root window remained below 100,000,000 B
throughout (93,073,408 B at +180 s; 96,735,232 B peak). These are measured runs,
not a guarantee that every future live activity pattern stays below that peak.

An additional full-history browsing stress after the final timed interval
reached 111,783,936 B peak (106.6 MiB); RSS settled to 100,794,368 B (96.1 MiB)
before the snapshot. Its larger transient peak is reported separately, not
hidden in the four-hour baseline. History retention is bounded, but neither
allocation peaks nor exact recent timestamp counters are a hard 100 MB cap.

## Contract and regression checks

- PASS: `node --test`, 30 tests. Coverage includes 30,000 old messages reducing
  to aggregate totals plus 200 events, exact reference aggregates/events/heat,
  replacement of mutable usage snapshots, skipped outputs, bounded strings,
  opaque cursors, SSE bounds/recovery, scope LRU/TTL and initial handshake races.
  An HTTP integration fixture also verifies that all 2,001 events contribute to
  heatmap counters while only 200 are serialized for display.
- PASS: live `:3340` versus final temporary instance: `/api/sessions` IDs,
  agentCount/callCount; `/api/state` model/day/hour usage, totalToday, estimated
  cost, cacheHit, heatmap and complete 200-event tail (object/array order and
  floating-point accumulation noise normalized).
- PASS: two simultaneous SSE clients received identical initial state frames,
  retaining the same public state keys as the deployed service.
- Additional scoped-history checks against the archived baseline: five inactive
  roots matched fully, including agents and event tails. The active sixth root
  changed while requests ran: lastActivity advanced 4,723 ms, assistant context
  and usage increased, and a new permission appeared. A later check differed by
  approximately 80,000–120,000 tokens out of 81.8–87 million historical tokens; these were
  live activity, not missing historical usage. A transient one-permission heat
  and event-tail difference in global state disappeared on the next comparison.
  The final global comparison was repeated after full-history browsing and all
  requested fields still matched the deployed service.
- NOT RUN: browser automation / WebGL visual regression. Frontend files and API
  response shapes were not changed.

## Retention boundaries and trade-offs

History stores per-model totals, current day/hour usage, exact numeric recent
timestamp counters, at most three representative messages, and a 200-event
tail per session. Old history no longer retains one object per message or text
byte. Exact rolling cache-hit/heat counters still scale with **distinct recent
timestamps** within fixed time windows; this is not a claim of constant memory
under arbitrarily high event rates or an arbitrary number of sessions/models.
The prerelease-review follow-up replaces that full scan on every dirty batch
with a bounded 32-message contribution tail plus an older aggregate base. Recent
pages stop at a known tail ID; updated contributions replace their prior values.
A missing anchor or forced reconciliation rebuilds the base. The contribution
tail is bounded independently of historical message count, but adds fixed
per-session overhead compared with the original reduction-only implementation.

Scoped reductions use a four-entry LRU and five-minute idle TTL, except that
active SSE scopes are pinned within the 32-client cap. Rendered scope snapshots
use four entries and an absolute ten-second TTL. SSE clients share serialization
and retain only content hashes. Upstream frames above 64 KiB are discarded and
reconciled from HTTP snapshots rather than parsed as large tool-output strings.

### Known counter bound (review item 8)

`heat`/`globalHeat` Maps retain exact event-timestamp counters within one hour;
`window` Maps retain exact input/cache-read timestamp counters within the
configured rolling window. The base, bounded tail contributions and published
reduction all prune these counters. Their cardinality still depends on the
number of distinct timestamps in those windows: they are **not** a fixed-size
ring or a hard memory cap under arbitrarily high event rates. Old message bodies
and tool outputs do not affect their retained size.

## Prerelease review follow-up

### 0.1.2 convergence and retained-memory bounds

The 32-message tail is an ordered, replaceable prefix over the older base.
Recent loads remove absent IDs newer than the oldest returned tail anchor and
exclude rows after that anchor. Pages exceeding the requested ten messages
trigger an authoritative rebuild instead. Historical message IDs use a fixed
8 KiB Bloom filter per tracked session; an SSE update identifying an older ID
requests a rebuild (false positives cause extra work, never missed membership).
Unhinted older edits/deletions converge through independent per-session audit
deadlines, staggered at five to ten minutes after each full rebuild. Recent
traffic does not extend those deadlines. Audits run one session at a time through
the existing coalescing/history lane; upstream failures or backlog can delay
completion beyond the nominal deadline.

The four-scope LRU is not a four-scope limit for pinned histories: up to **32
distinct active SSE scopes** can stay pinned, limited by the SSE-client cap.
Each scope can include multiple descendant sessions. Each session retains up to
32 mutable message contributions, each with event arrays bounded at 400 entries
before compaction (up to 400 × 32 per event-array category), in addition to the
older base and combined display reductions. Thus 200 displayed events is not
the total internal retention bound. Exact heat/window timestamp cardinality and
the number of tracked descendant sessions remain workload-dependent; neither
the pinned-scope design nor contribution bounds guarantee RSS below 100 MB.

Baseline: `dd0b46b`. Production fixes: `a16dd01` (subsequent commit only extends
wire-level regression coverage and records this evidence). The deployed `:3340`
instance was already running that baseline when this follow-up began; it was
neither restarted nor edited here. Temporary probes used `:3397` before and
`:3396` after, against the same live OpenCode 2.0.30 upstream.

### 0.1.2 final verification (2026-10-18)

- PASS: `node --test`, **48/48**. Added real HTTP/loadMessages scenarios use
  100-message histories for historical SSE edits, newest-message deletion/revert,
  a page crossing the older-base boundary, ignored page limits, independent
  periodic audits with unchanged versions, and incomplete/16-ID-capped oversized
  extraction recovering an otherwise unidentified session. Release metadata,
  `--help` and the dated changelog agree on 0.1.2.
- PASS: short live comparison of `:3396` against deployed `:3340`: session IDs,
  agentCount/callCount, day/model/hourly tokens, costs, cache hit, heat and event
  tail all matched. No production restart or push.
- PASS: `npm pack --dry-run --json` includes the new `lib/message-ids.mjs` and
  remaining runtime modules (38 files); no archive was published.
- NOT RUN: independent review could not start (`Subagent depth limit reached`).
  Browser/WebGL visual checks were not run; frontend assets were unchanged.

The final temporary 0.1.2 instance used the same native-HTTP counter preload,
without Inspector/explicit GC. After initial sync RSS / VmHWM was
100,470,784 / 104,124,416 B (**95.8 / 99.3 MiB**); after 180 seconds it was
101,814,272 / 114,679,808 B (**97.1 / 109.4 MiB**). This does not meet a hard
100 MB cap. The two-minute activity counter recorded 474 total / 44 message-page
requests, but traffic was not replayed and no matched baseline was repeated
for this final convergence fix. Raw measurements:
`/tmp/opencode/review-v012.jsonl`. The temporary PID was stopped after the
measurement; the deployed `:3340` service was not restarted.

### Request count: two minutes of real activity

A temporary preload wrapped native `http.get`/`https.get` with counters only.
Counting began after the first complete sync and ended after 120 seconds;
startup requests and later scope-browsing requests were excluded. The agent's
ongoing session generated real SSE invalidations. This is a rough live workload
comparison, not identical replay traffic or a synthetic model benchmark.

| Two-minute requests | Before | After |
| --- | ---: | ---: |
| All upstream HTTP requests | 547 | 359 |
| Message-page requests | 213 | 19 |

Message pages fell approximately 91%; total requests fell approximately 34%.
An earlier corrected run recorded 374 total / 22 message requests, consistent
with the same improvement despite different live activity. Permissions/forms
retain their independent five-second polling cadence; they do not share the
history loading slot. Metadata/discovery uses two control jobs, histories one.

### Timed memory after the review fixes

The same request-counting preload recorded memory at startup, first complete
sync and +180 seconds. It imports HTTP(S) to install its counters, so its startup
figures are not comparable to the earlier simpler preload's startup row.
No Inspector, heap snapshot or explicit GC was used during these intervals.
All values below are MiB; each cell is RSS / heapUsed / VmHWM.

| Point | Before review fixes | After review fixes |
| --- | ---: | ---: |
| Startup | 59.2 / 7.9 / 60.1 | 58.6 / 7.9 / 60.0 |
| First full sync | 86.1 / 11.5 / 88.1 | 96.1 / 17.1 / 100.7 |
| +180 seconds | 87.2 / 15.2 / 89.9 | 90.8 / 15.2 / 103.8 |

The bounded contribution tail trades a small fixed per-session overhead for
substantially fewer requests. Final +180-second RSS was 95,186,944 B; VmHWM was
108,875,776 B. This is not a hard peak-memory cap. After browsing six complete
scopes twice, RSS was 103,890,944 B (99.1 MiB), with 114,618,368 B peak
(109.3 MiB); those requests were outside the timed request-count interval.

### Verification

- PASS: `node --test`, 40 tests. The added tests cover one-/two-/three-byte
  escape/exponent/Unicode boundaries; truncated numbers and trailing root data;
  omitted non-scalar inputs; native redirect/credential/encoding behavior;
  real HTTP/SSE usage replacement; tail rollover/missing-anchor fallback;
  coalescing mixed HTTP/SSE bursts into no more than two loads; control requests
  completing while history is blocked; real oversized SSE frames preserving a
  deferred force across sync and respecting throttling; pinned scope retention
  and heartbeat restoration of a deliberately lost full-history scope.
- PASS: live `/api/sessions` IDs, agentCount/callCount and `/api/state` day/model/
  hourly tokens, cost, cache hit and event tail matched `:3340`, including after
  scope browsing. A comparison before browsing also matched heatmap bins exactly.
- PARTIAL raw heat-bin equality in the final post-browsing capture: one event
  moved between adjacent bins. Snapshots differed by 246 ms; the matching
  `tool complete` event lay within those 246 ms at the 30-minute bin boundary.
  Every group's total heat count matched. This is the sliding-clock boundary,
  not added/lost history or duplicate usage.
- PASS: six distinct inactive session scopes, two consecutive traversal rounds:
  token/model totals, costs, event counts, agentCount and callCount were unchanged
  after LRU eviction/reload. Event counts were 105, 117, 130, 12, 122 and 200;
  all totals were nonzero. Separate SSE integration coverage retains the old
  history total (30, not the recent-only 20) through six other scopes and an
  explicit scope loss/heartbeat restoration.
- NOT RUN: a second independent prerelease review or browser visual regression.
  No version bump, push, release or production service restart was performed.
