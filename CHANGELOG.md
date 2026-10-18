# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Stream and project upstream message JSON before materializing tool outputs or long text; use ten-message pages and one bounded loading job.
- Use native HTTP(S) streaming instead of loading Undici into the backend.
- Reduce history to model/hour/day usage, exact recent timestamp counters, three representative messages and a bounded event tail; replace reductions on refresh to avoid double-counting.
- Retain four history scopes for five minutes and four scoped snapshots for one minute; share serialized state and small signatures between SSE clients.
- Bound upstream SSE frames to 64 KiB; oversized payloads reconcile snapshots instead of retaining tool-output buffers.
- Reconcile versions after the first SSE handshake without immediately loading every unchanged history a second time; reconnects still force full reconciliation.

### Added

- Regression tests for streamed projection, oversized SSE frames, aggregate parity, history bounds and scope expiry.

## [0.1.1] - 2026-10-17

### Added

- Actionable HTTP 401 error reporting without exposing upstream credentials.
- Connected OpenCode version in backend logs.
- Cyclic demo activity: tools, working states and bounded events every 1.5 seconds.
- Animated GIF and MP4 README demos, excluded from the npm package.
- CI for Node.js 20/22/24 on Linux and Node.js 22 on macOS/Windows.
- Bug report, feature request and pull request templates, plus security/discussion links.

### Changed

- Verified compatibility with a clean OpenCode 2.0.32 installation.
- Documented local/remote setup and generated or explicit server passwords.
- Normalized package.json metadata with `npm pkg fix`.
- CLI help reads the release version from package.json.

## [0.1.0] - 2026-10-16

### Added

- Initial release: read-only OpenCode V2 dashboard over public HTTP and SSE.
- WebGL agent trees, grouped parallel calls, tools, approval waits, tokens and estimated costs.
- Local/remote upstream support, fictional demo data and zero runtime npm dependencies.

[0.1.1]: https://github.com/orybakov/opencode-agent-flow/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/orybakov/opencode-agent-flow/releases/tag/v0.1.0
