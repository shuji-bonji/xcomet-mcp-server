# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
