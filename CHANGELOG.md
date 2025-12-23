# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
