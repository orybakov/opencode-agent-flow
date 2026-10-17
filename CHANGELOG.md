# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
