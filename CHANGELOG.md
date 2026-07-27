# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.6.3] - 2026-07-27

> plugin マニフェストのみの変更。npm パッケージ (`xcomet-mcp-server`) の実装は 0.6.2 から変わっていないため、`package.json` は 0.6.2 のまま据え置く。

### Fixed

- **`.claude-plugin/plugin.json`: `XCOMET_PYTHON_PATH` を必須扱いにしていた問題** — `"${XCOMET_PYTHON_PATH}"` はデフォルト値を持たない展開なので、変数が未設定のホストでは Claude Code が config 検証の段階で `Invalid MCP server config for "xcomet": Missing environment variables: XCOMET_PYTHON_PATH` を出し、server が起動できなかった。`"${XCOMET_PYTHON_PATH:-}"` に変更し、未設定なら空文字に展開されるようにした。`detectPythonPath()` は `if (envPath)` で判定しているため空文字は falsy となり、pyenv / venv / system Python の自動検出に正しくフォールバックする。README が以前から「auto-detection で省略可」と書いていた挙動に、マニフェスト側をようやく合わせた形。

### Changed

- **plugin description** — Python 環境が必須である点は変えず、`XCOMET_PYTHON_PATH` 自体は任意 (venv 利用時の明示指定用) であることが分かる文面に修正。

## [0.6.2] - 2026-07-14

### Added

- **`.claude-plugin/plugin.json`** — Claude Code plugin マニフェストを追加。Claude Code の plugin marketplace 経由でインストールでき、`mcpServers.xcomet` (npx `xcomet-mcp-server@latest`) が自動設定される。利用には従来どおり `XCOMET_PYTHON_PATH` の指定が必要。

## [0.6.1] - 2026-05-09

### Build

- **build script に `chmod +x dist/index.js` を追加**: local dev で `./dist/index.js` を直接実行した際の `permission denied` を回避。npm install / npx 経由の通常利用には影響なし (npm が install 時に bin を chmod するため)。shuji 製 MCP 全体で build script を統一。

## [0.6.0] - 2026-04-24

### Added

- **`src/utils/logger.ts`** — centralized stderr-only logger
  (`logger.debug` / `info` / `warn` / `error`). All `console.error`
  calls in `src/index.ts` and `src/services/python-server.ts` now go
  through it. Reinforces the MCP stdio invariant that nothing must
  pollute stdout.
- **`tests/restart-await-exit.test.ts`** — regression test pinning
  down that `attemptRestart()` waits for the previous Python process
  to exit (cooperative SIGTERM or SIGKILL fallback) before spawning a
  new one. Prevents short-lived double-load of the multi-GB xCOMET
  model.
- **Python: `XCOMET_NUM_WORKERS` env var** — overrides DataLoader
  `num_workers` for `model.predict()`. Default remains 1.
- **Python: `_stats_lock`** — guards `_stats` counter updates with a
  `threading.Lock` as a forward-compatible safety net for any future
  multi-threaded dispatch (current main loop is strictly serial).
- **Python: `_require()` helper** — raises a friendly
  `missing required parameter: "X"` ValueError instead of an opaque
  `KeyError` when RPC params are missing.

### Changed

- **`modelRequiresReference` is now an exact case-insensitive match**
  (was substring-based). A future model named e.g.
  `Unbabel/wmt22-comet-da-v2-experimental` would previously have been
  misclassified as requiring a reference. The Python and TypeScript
  implementations are now in sync — `REFERENCE_REQUIRED_MODELS` lives
  in `src/config/constants.ts` and a mirror tuple in `python/server.py`
  with a comment pointing back to the canonical list.
- **`PythonServerManager._start()` exit/error handling consolidated.**
  Previously `proc.on("exit", ...)` was registered twice (once inside
  `readyPromise`, once after ready). Now a single unified handler covers
  both pre-ready and post-ready exits, makes the lifecycle easier to
  follow, and always rejects pending RPCs and tears down state.
- **`attemptRestart()` now awaits the old process exit** via the new
  `terminateProcess()` helper (EOF → SIGTERM → SIGKILL after
  `PYTHON_KILL_TIMEOUT_MS`). The same helper is shared with `stop()`.
- **`IPythonServerManager.healthCheck()` return type** now includes
  `status: string` to match the actual implementation. Mock manager in
  `tests/xcomet-service-di.test.ts` updated accordingly.
- **`LogMessages.ready` is now a plain string** (was a no-arg function),
  consistent with the other static log message constants.
- **Tool descriptions** for `xcomet_evaluate`, `xcomet_detect_errors`,
  and `xcomet_batch_evaluate` now document `use_gpu` (and
  `batch_size` for the batch tool) — these were silently missing.

### Tests

- **`should reject empty strings with a clear error`** — previously
  `it.skip`'d (model would hang on empty input). Now reactivated and
  asserts the new `_require()` rejection path (`/must not be empty/i`).
- **Stress suite split out** to `tests/stress/**/*.stress.test.ts`
  with its own `vitest.stress.config.ts` (5-minute test timeout) and
  the `npm run test:stress` script. The default `npm test` excludes
  `tests/stress/**`. The previously skipped 1000+ character long-text
  case lives there as `tests/stress/long-text.stress.test.ts`.

### Documentation

- **README (en/ja) Node.js requirement aligned to `>= 22.0.0`** to match
  `package.json#engines.node` and the CI matrix (was incorrectly listed
  as `>= 18.0.0`).
- **`tests/README.md` rewritten for v0.5.0** — removes obsolete HTTP-era
  references (`port detection`, `/shutdown`, `*_api_count`) and reflects
  the current stdio JSON-RPC suite (line-buffer, stop-race, DI, golden
  fixtures, integration, user-scenarios), plus the new stress suite.

## [0.5.0] - 2026-04-23

### Added

- **Service-layer dependency injection**. `XCometService` now accepts an
  optional `serverManager` argument (typed as the new `IPythonServerManager`
  interface), enabling unit tests to run without spawning a Python process.
  The default singleton behavior is preserved — `new XCometService()` and
  `new XCometService(config)` remain unchanged for existing callers.
- **Golden fixture regression suite**. `tests/fixtures/golden.json`
  provides 20 representative cases spanning good / fair / poor quality
  and edge cases (emoji, code blocks, multi-line). Each case declares a
  `[score_min, score_max]` range rather than an exact score, so the suite
  is robust against minor xCOMET drift while still catching regressions.
  `tests/golden-fixtures.test.ts` runs one assertion per case against a
  live Python worker; the whole suite auto-skips when `comet` is unavailable.
- **XCometService unit tests** using the new DI surface —
  `tests/xcomet-service-di.test.ts` covers parameter forwarding, reference
  validation for WMT models, empty-batch short-circuit, and batch timeout
  extrapolation — all without touching Python.

### BREAKING CHANGES

- **MCP HTTP transport removed**. The Node.js MCP server now supports
  `stdio` transport only. The `TRANSPORT=http` mode, the `/mcp` endpoint,
  the `/health` endpoint, and the `PORT` / `MCP_BODY_LIMIT` environment
  variables have all been removed.
  - **Why**: all supported MCP clients (Claude Desktop, Claude Code,
    Cursor, Windsurf, etc.) connect via stdio. The HTTP path carried an
    unauthenticated `/mcp` endpoint and a full `express` dependency for a
    use case nobody had. Removing it tightens the default attack surface
    and halves the top-level runtime dependency footprint.
  - **Impact**: nobody invoking `xcomet-mcp-server` from an MCP client
    config (`command` + `args`) is affected — stdio is the default and
    is unchanged. Only users who explicitly ran `TRANSPORT=http npm start`
    need to switch to stdio.
  - If remote-access is needed in the future, it will be reintroduced as
    a first-class SSE/Streamable HTTP transport with proper authentication.
- **`express` and `@types/express` dependencies removed** from
  `package.json`. Fewer installs, faster CI, smaller `node_modules`.

### Changed

- **Python transport: HTTP → stdio JSON-RPC**. The Node.js MCP server now
  spawns the Python worker with a three-pipe stdio (`stdin`/`stdout`/`stderr`)
  and speaks a line-delimited JSON-RPC protocol. No local HTTP listener,
  no port binding, no `fetch()` calls for inference.
  - Request shape: `{"id": <number>, "method": <str>, "params": <obj>}`
  - Response shape: `{"id": <number>, "result": <obj>}` or `{"id": <number>, "error": <str>}`
  - Startup handshake: Python emits `{"type": "ready", "ok": true}` on stdout
  - Graceful shutdown: Node closes Python's stdin (EOF) instead of calling `/shutdown`
- **Why**: removes a whole class of local-network concerns (port race,
  health-check polling, port leak on crash), simplifies lifecycle, and
  matches the way MCP itself talks over stdio.

### Removed

- **Python dependencies: `fastapi`, `uvicorn`, `pydantic`** are no longer
  required. Only `unbabel-comet>=2.2.0` is needed on the Python side.
- `PYTHON_HEALTH_CHECK_TIMEOUT_MS`, `PYTHON_SHUTDOWN_TIMEOUT_MS`,
  `PYTHON_SERVER_READY_POLL_INTERVAL_MS`, `PYTHON_SERVER_READY_MAX_ATTEMPTS`,
  `PYTHON_MAX_RETRIES` constants (no longer applicable).
- `DEFAULT_HTTP_PORT`, `DEFAULT_BODY_LIMIT`, `DEFAULT_TRANSPORT` constants
  (HTTP transport removed).
- HTTP port detection from Python stdout.
- `PythonServerManager.getPort()` (never part of the public surface).

### Migration notes

- **Users**: if your venv was set up before v0.5.0, you can uninstall
  `fastapi`/`uvicorn`/`pydantic` after upgrading — they are now unused.
  No config changes required; `XCOMET_PYTHON_PATH` / `XCOMET_MODEL` /
  `XCOMET_PRELOAD` behave the same.
- **If you were running the server via `TRANSPORT=http npm start`**:
  switch to stdio. Any MCP client (Claude Desktop, Claude Code, Cursor,
  etc.) can point directly at `node dist/index.js` or
  `npx -y xcomet-mcp-server`.
- **Stats field renames** (breaking for anyone who parsed `stats` output):
  `evaluate_api_count` → `evaluate_rpc_count`,
  `detect_errors_api_count` → `detect_errors_rpc_count`,
  `batch_api_count` → `batch_rpc_count`.

## [0.4.0] - 2026-04-23

### Changed

- **npm publish migrated to Trusted Publisher (OIDC + provenance)**:
  - `publish.yml` now uses npm's Trusted Publisher with OpenID Connect (no long-lived `NPM_TOKEN` required)
  - Published packages now include provenance statements (`--provenance`)
  - `permissions.id-token: write` added to the publish job
  - Publish step uses `npx -y npm@latest publish` because Trusted Publisher requires npm >= 11.5.1 while Node 22 ships with npm 10.x, and `npm install -g npm@latest` has a known self-overwrite race on GitHub Actions runners
- **Node.js support bumped to `>=22`** (Node 20 reached end-of-life in April 2026)
  - CI matrix updated to `[22, 24]` (both are current npm LTS lines)
  - `publish.yml` builds and publishes on Node 22 (the minimum supported version)
- **`package.json` metadata polish**:
  - Added `homepage` and `bugs` fields
  - Added `glama.json` and `README.ja.md` to the `files` array
  - Added `clean`, `typecheck`, `lint`, `lint:fix` scripts
  - `prepublishOnly` now runs `clean && build` for a deterministic dist/

### Added

- **ESLint (flat config)** with `typescript-eslint` and a rule set tuned for MCP stdio safety (`no-console` restricted to `error`/`warn`)
- **Lint step in CI** (`lint` job in `ci.yml`, and as a gate in `publish.yml`)

## [0.3.9] - 2026-04-10

### Fixed

- **`xcomet_batch_evaluate` output schema mismatch**: Added missing `errors` array to `BatchEvaluateOutputSchema` results. The Python server returned `errors` in each result item, but the Zod schema did not declare this property, causing MCP clients to reject the response with `additionalProperties` validation error.

### Changed

- **Model Selection table**: Added HuggingFace authentication column to clarify that XCOMET-XL and XCOMET-XXL each require **separate** access approval, while `wmt22-comet-da` does not require authentication

## [0.3.7] - 2026-04-10

### Fixed

- **Tilde expansion in `XCOMET_PYTHON_PATH`**: Paths like `~/.xcomet-venv/bin/python3` are now correctly expanded to the home directory. Previously, `~` was not resolved by Node.js `existsSync`, causing the environment variable to be silently ignored.

### Changed

- **Documentation overhaul** (README.md / README.ja.md):
  - Added Python version requirement (3.9-3.12 recommended, 3.13+ not yet supported)
  - Added HuggingFace gated model authentication instructions for XCOMET-XL/XXL
  - Clarified that repository cloning is not needed for npx users
  - Added `uv` as recommended tool for virtual environment setup
  - Added `XCOMET_PYTHON_PATH` to all configuration examples
  - Separated usage sections: npx / Claude Code / Global Install / Local Development Build
  - Added `npm test` to Development section (was missing in English README)
  - Added Mermaid diagram to Performance section (was missing in Japanese README)
  - Unified troubleshooting guidance across both languages
  - Fixed DeepL integration example missing `XCOMET_PYTHON_PATH`

## [0.3.6] - 2026-02-03

### Added

- **CI/CD Workflows**: Automated testing and npm publishing
  - `ci.yml`: Runs type check, tests, and build on push/PR to main
  - `publish.yml`: Auto-publishes to npm when version tags are pushed
  - Version verification ensures tag matches package.json

- **Centralized Constants** (`src/config/constants.ts`):
  - All hardcoded values moved to a single configuration file
  - Server version now dynamically read from package.json
  - Easier configuration management and future i18n support

- **Centralized Error Messages** (`src/config/errors.ts`):
  - Unified error messages for consistency
  - Supports dynamic parameters (e.g., model names, attempt counts)
  - Easier maintenance and future localization

- **Test Utilities** (`tests/helpers/test-utils.ts`):
  - Shared helpers for test files (reduced code duplication)
  - `startServer()`, `stopServer()`, `waitForServerReady()`
  - `createServerLifecycle()` for easy setup/teardown
  - Custom `toBeOneOf` matcher

- **Japanese Documentation** (`README.ja.md`):
  - Full Japanese translation of README

### Changed

- **Code structure improvements**:
  - Constants extracted from source files to `config/constants.ts`
  - Error messages extracted to `config/errors.ts`
  - Python path detection uses centralized package list
  - Schema constraints use centralized constants

- **Test refactoring**:
  - Reduced redundant code across test files
  - Tests now use shared utilities from `test-utils.ts`

### Fixed

- **Version mismatch**: SERVER_VERSION was hardcoded as "0.3.2" but package.json was "0.3.5"
  - Now dynamically reads version from package.json

## [0.3.5] - 2025-12-27

### Changed

- **Code refactoring**: Improved code organization and maintainability
  - Extracted tool descriptions to `descriptions.ts`
  - Added `READ_ONLY_ANNOTATIONS` constant for shared annotations
  - Created `createToolResponse()` helper for consistent response generation
  - Created `createErrorResponse()` helper for unified error handling

## [0.3.4] - 2025-12-25

### Fixed

- **Statistics double counting**: `detect_errors` no longer double-counts API calls when calling internal evaluate function
  - Created `_evaluate_internal()` function for internal use without stats updates
  - Each endpoint now correctly updates only its own statistics
- **Process orphaning on startup failure**: Kill Python process if `portPromise` or `waitForServerReady()` fails
- **Python path detection safety**: Changed `execSync` to `execFileSync` with args array to handle paths with spaces
- **Thread-safe model loading**: Added `threading.Lock` with double-checked locking to prevent concurrent model loading

### Added

- Unofficial project disclaimer in README

## [0.3.3] - 2025-12-25

### Fixed

- **Port detection robustness**: Use line-buffered stdout parsing to handle chunked JSON output
- **Stop race condition**: Avoid calling start() during stop() to prevent spawning extra processes
- **Port binding race**: Get actual bound port after uvicorn startup instead of bind-then-close pattern

### Changed

- **Statistics clarity**: Separate API call counts by endpoint for clearer metrics
  - `evaluate_api_count`: /evaluate endpoint calls
  - `detect_errors_api_count`: /detect_errors endpoint calls
  - `batch_api_count`: /batch_evaluate endpoint calls
  - `total_pairs_evaluated`: Total pairs evaluated (including internal calls)

## [0.3.2] - 2025-12-24

### Fixed

- **Race condition on startup**: Wait for uvicorn to be ready before sending requests
  - Previously, requests could fail with "fetch failed" if sent immediately after port detection

## [0.3.1] - 2025-12-24

### Added

- **Eager Loading** (`XCOMET_PRELOAD=true`): Pre-load model at server startup
  - First request is instant (~500ms) when enabled
  - Set `XCOMET_PRELOAD=true` environment variable to enable
- **Statistics Endpoint** (`/stats`): Monitor server performance
  - Uptime, evaluation count, average inference time
  - Model load time tracking
- **Auto Restart**: Automatic recovery from failures
  - Restarts after 3 consecutive health check failures
  - Up to 3 restart attempts with backoff
- **Debug Logging** (`XCOMET_DEBUG=true`): Verbose logging for troubleshooting
  - Set `XCOMET_DEBUG=true` to enable detailed logs

### Changed

- Improved health check with failure tracking
- Graceful shutdown now waits for current request to complete
- Code quality improvements:
  - Replaced `require()` with ESM `import` for consistency
  - Extracted magic numbers to named constants
  - Added comments for reserved parameters (`source_lang`, `target_lang`)

## [0.3.0] - 2025-12-24

### Added

- **Persistent Python Server**: FastAPI-based server keeps the xCOMET model in memory
  - First request loads model (~25-90s depending on model size)
  - Subsequent requests are **177x faster** (~500ms vs ~90s)
  - No more model reloading between evaluations
- **Graceful Shutdown**: Proper cleanup of Python subprocess on SIGTERM/SIGINT
- **Health Check Endpoint**: Server status monitoring via `/health`

### Changed

- **Architecture Overhaul**: Replaced subprocess-per-request with persistent HTTP server
  - Node.js manages Python FastAPI server lifecycle
  - HTTP communication between Node.js and Python
  - Automatic port allocation and process management
- **New Python Dependencies**: `fastapi`, `uvicorn`, `pydantic` now required

### Performance

| Request | Before (v0.2.x) | After (v0.3.0) | Improvement |
|---------|-----------------|----------------|-------------|
| First request | ~90s | ~90s | - |
| Subsequent requests | ~90s | ~500ms | **177x faster** |
| 10 consecutive evals | ~15 min | ~30s | **30x faster** |

### Prerequisites

```bash
# New Python dependencies required
pip install fastapi uvicorn
```

## [0.2.3] - 2025-12-24

### Added

- **XCOMET_MODEL environment variable**: Now supports model selection via environment variable
  - Example: `XCOMET_MODEL=Unbabel/wmt22-comet-da`
  - Default: `Unbabel/XCOMET-XL`
- **Reference validation**: Models like `wmt22-comet-da` now properly validate that `reference` is provided
  - Clear error message when reference is missing
  - Suggests using XCOMET models for referenceless evaluation

### Changed

- **Increased max pairs limit**: 100 → 500 pairs per batch for large-scale evaluation
- **Added lightweight model option**: Documented `Unbabel/wmt22-comet-da` as alternative (580M params, ~3GB memory)

### Documentation

- **Best Practices section**: Guidelines for optimal batch processing
  - Batch all pairs in single call to avoid repeated model loading
  - Time breakdown (model load ~25s, inference ~3-5s per 100 pairs)
  - Memory considerations for large batches
- **Memory troubleshooting**: Solutions for high memory usage and IDE crashes
- **Model comparison table**: Added memory requirements and use cases

## [0.2.2] - 2025-12-22

### Added

- **npx Support**: Added shebang for direct execution via `npx xcomet-mcp-server`
- **prepublishOnly**: Automatic build before npm publish

### Changed

- **Improved Error Messages**: Better guidance when Python or unbabel-comet is not found
  - Shows specific installation instructions
  - Displays detected Python path for debugging
  - Suggests `XCOMET_PYTHON_PATH` environment variable

### Fixed

- Fixed SERVER_VERSION mismatch (was showing 0.1.0)

## [0.2.1] - 2025-12-21

### Added

- **Python Auto-Detection**: Automatically finds Python with `unbabel-comet` installed
  - Checks `XCOMET_PYTHON_PATH` environment variable first
  - Scans pyenv versions for compatible Python
  - Falls back to Homebrew Python paths
  - Resolves issues when MCP host uses different Python than terminal

### Fixed

- Fixed "No module named 'comet'" error when MCP server runs in environments without pyenv (e.g., Claude Desktop, Claude Code)

## [0.2.0] - 2025-12-21

### Added

- **GPU Support**: All tools now support optional GPU acceleration via `use_gpu` parameter
  - `xcomet_evaluate`: Added `use_gpu` parameter
  - `xcomet_detect_errors`: Added `use_gpu` parameter
  - `xcomet_batch_evaluate`: Added `use_gpu` and `batch_size` parameters
- **Batch Size Control**: `xcomet_batch_evaluate` now accepts `batch_size` parameter (1-64, default: 8)

### Changed

- **Optimized Batch Processing**: `xcomet_batch_evaluate` now loads the model only once for all pairs
  - Previous: Each pair triggered a separate model load (~30 seconds each)
  - Now: Single model load for entire batch
  - Result: ~25x speedup for 100 pairs (from ~50 min to ~2 min on CPU)

### Performance

| Pairs | Before | After | Speedup |
|-------|--------|-------|---------|
| 10 | ~5 min | ~40 sec | ~7.5x |
| 50 | ~25 min | ~1.5 min | ~17x |
| 100 | ~50 min | ~2 min | ~25x |

## [0.1.0] - 2025-12-20

### Added

- Initial release
- `xcomet_evaluate`: Single translation pair evaluation
- `xcomet_detect_errors`: Error detection with severity filtering
- `xcomet_batch_evaluate`: Batch evaluation for multiple pairs
- Support for XCOMET-XL and XCOMET-XXL models
- stdio and HTTP transport modes
- JSON and Markdown response formats
