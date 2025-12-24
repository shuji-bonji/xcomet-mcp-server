# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

### Fixed

- **Race condition on startup**: Wait for uvicorn to be ready before sending requests
  - Previously, requests could fail with "fetch failed" if sent immediately after port detection

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
