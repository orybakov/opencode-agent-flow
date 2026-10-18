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
Dirty sessions scan the relevant history again to replace mutable usage rather
than retaining a per-message contribution index. This increases small upstream
requests, but avoids an unbounded historical cache and double-counted tokens.

Scoped reductions use a four-entry LRU and five-minute idle TTL; rendered scope
snapshots use four entries and a one-minute TTL. SSE clients share serialization
and retain only content hashes. Upstream frames above 64 KiB are discarded and
reconciled from HTTP snapshots rather than parsed as large tool-output strings.
