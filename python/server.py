#!/usr/bin/env python3
"""
xCOMET stdio server

Reads JSON-RPC style requests from stdin (one JSON object per line),
writes responses to stdout (one JSON object per line).
All logs go to stderr. stdout is reserved for protocol messages.

Protocol:
  Request:  {"id": <number>, "method": <str>, "params": <obj>}
  Response: {"id": <number>, "result": <obj>}  OR  {"id": <number>, "error": <str>}
  Ready:    {"type": "ready", "ok": true}       (emitted once at startup)
"""

import os
import sys
import json
import time
import errno
import warnings
import threading
from typing import Any, Callable, Dict, Optional

# Suppress warnings and noisy library defaults
warnings.filterwarnings("ignore")
os.environ["TOKENIZERS_PARALLELISM"] = "false"

# -----------------------------------------------------------------------------
# Global state
# -----------------------------------------------------------------------------

_model = None
_model_name: Optional[str] = None
_model_lock = threading.Lock()

# `_stats` is updated from RPC handlers. Today the main loop is strictly
# single-threaded (one `sys.stdin.readline()` at a time), so there is no
# realistic contention. The lock is kept as a cheap safety net so that any
# future change to a thread/asyncio dispatcher does not silently corrupt
# counters via non-atomic `dict[k] += n`.
_stats_lock = threading.Lock()
_stats: Dict[str, Any] = {
    "start_time": None,
    "model_load_time": None,
    "evaluate_rpc_count": 0,
    "detect_errors_rpc_count": 0,
    "batch_rpc_count": 0,
    "total_pairs_evaluated": 0,
    "total_inference_time_ms": 0,
}


def _bump_stats(**deltas: int) -> None:
    """Atomically increment one or more `_stats` counters."""
    with _stats_lock:
        for key, delta in deltas.items():
            _stats[key] += delta


# -----------------------------------------------------------------------------
# Logging (stderr only; stdout is reserved for protocol)
# -----------------------------------------------------------------------------

def log(msg: str) -> None:
    print(f"[xcomet-server] {msg}", file=sys.stderr, flush=True)


# -----------------------------------------------------------------------------
# Model management
# -----------------------------------------------------------------------------

def _saving_directory() -> Optional[str]:
    """Cache directory for the model checkpoint, or None for the default.

    `XCOMET_SAVING_DIRECTORY` maps to `cache_dir` in `snapshot_download()`.
    Unset, huggingface_hub uses its own cache (`HF_HOME`, default
    `~/.cache/huggingface`).
    """
    raw = os.environ.get("XCOMET_SAVING_DIRECTORY", "").strip()
    return os.path.expanduser(raw) if raw else None


def _local_files_only() -> bool:
    """Whether to resolve the checkpoint from the local cache only.

    Set `XCOMET_LOCAL_FILES_ONLY=true` to start without network access. The
    model must already be in the cache; otherwise loading raises with the
    message below instead of reaching out to the Hub.
    """
    return os.environ.get("XCOMET_LOCAL_FILES_ONLY", "").strip().lower() in ("1", "true", "yes")


def _download_checkpoint(model_name: str) -> str:
    """Return the path of `model_name`'s checkpoint, downloading it if needed.

    `comet.download_model()` wraps every failure in one message:

        KeyError: Model '<name>' not supported by COMET.

    A 401 from a gated repo, an unaccepted license, no network and a full disk
    all arrive as that sentence, which points at the model name — the one thing
    that is usually correct. So `snapshot_download` is called here directly and
    its own exception is translated into a message that names the actual cause.
    `comet.download_model()` still runs as the fallback, because it also knows
    the pre-Hub location of the older model names.
    """
    from huggingface_hub import snapshot_download

    try:
        from huggingface_hub.errors import GatedRepoError, LocalEntryNotFoundError
    except ImportError:  # huggingface_hub < 0.25
        from huggingface_hub.utils import GatedRepoError, LocalEntryNotFoundError

    saving_directory = _saving_directory()
    local_files_only = _local_files_only()

    try:
        model_path = snapshot_download(
            repo_id=model_name,
            cache_dir=saving_directory,
            local_files_only=local_files_only,
        )
    except GatedRepoError as exc:
        raise RuntimeError(
            f'Access to "{model_name}" was refused (HTTP 403). It is a gated model: '
            f"open https://huggingface.co/{model_name} while signed in and accept the "
            "license, then retry."
        ) from exc
    except LocalEntryNotFoundError as exc:
        if local_files_only:
            raise RuntimeError(
                f'XCOMET_LOCAL_FILES_ONLY is set and "{model_name}" is not in the local '
                "cache. Download it once with network access, or unset the variable."
            ) from exc
        raise RuntimeError(
            f'Could not reach huggingface.co to download "{model_name}", and it is not '
            "in the local cache. Check network access, or set XCOMET_LOCAL_FILES_ONLY=true "
            "once the model has been downloaded."
        ) from exc
    except Exception as exc:
        # One clause, not `except OSError` plus `except Exception`: every
        # huggingface_hub HTTP error derives from requests.RequestException,
        # which derives from OSError, so an `except OSError` placed first also
        # swallows 401/404 and hides them from the fallback below.
        if getattr(exc, "errno", None) == errno.ENOSPC:
            raise RuntimeError(
                f'No space left while downloading "{model_name}". XCOMET-XL needs about '
                "14GB and XCOMET-XXL about 43GB. Free space, or point "
                "XCOMET_SAVING_DIRECTORY at a larger volume."
            ) from exc

        # Repository missing, or authentication refused (a gated repo answers 401
        # rather than 403 when no token is sent). download_model() also resolves
        # the pre-Hub model names, so give it a turn before reporting.
        try:
            from comet import download_model

            return download_model(
                model_name,
                saving_directory=saving_directory,
                local_files_only=local_files_only,
            )
        except Exception:
            raise RuntimeError(
                f'Could not download "{model_name}": {type(exc).__name__}: {exc}. '
                "If it is a gated model (XCOMET-XL, XCOMET-XXL, the CometKiwi models), "
                "accept the license on its Hugging Face page and authenticate with "
                "`hf auth login` or by setting HF_TOKEN."
            ) from exc

    checkpoint = os.path.join(model_path, "checkpoints", "model.ckpt")
    if not os.path.isfile(checkpoint):
        # snapshot_download() returns the snapshot directory as soon as a cached
        # revision exists; it does not check that every file in it was fetched.
        # An interrupted download, or one that failed on the checkpoint alone,
        # leaves a directory that resolves but has no model.ckpt in it.
        raise RuntimeError(
            f'The cached snapshot of "{model_name}" has no checkpoints/model.ckpt '
            f"({checkpoint}). The download was interrupted or refused partway. "
            f"Delete that directory and download the model again."
        )
    return checkpoint


def get_model():
    """Lazy-load the model on first request. Thread-safe."""
    global _model, _model_name, _stats

    if _model is not None:
        return _model

    with _model_lock:
        if _model is not None:
            return _model

        model_name = os.environ.get("XCOMET_MODEL", "Unbabel/XCOMET-XL")
        log(f"Loading model: {model_name}")

        load_start = time.time()
        from comet import load_from_checkpoint
        model_path = _download_checkpoint(model_name)
        _model = load_from_checkpoint(model_path, local_files_only=_local_files_only())
        _model_name = model_name
        _stats["model_load_time"] = round((time.time() - load_start) * 1000)

        log(f"Model loaded successfully in {_stats['model_load_time']}ms")

    return _model


# Models that require a reference translation. Kept in sync with
# REFERENCE_REQUIRED_MODELS in src/config/constants.ts. Exact match
# (case-insensitive) — substring matching is too lax and would catch
# future variants like "Unbabel/wmt22-comet-da-v2-experimental".
REFERENCE_REQUIRED_MODELS = (
    "unbabel/wmt22-comet-da",
    "unbabel/wmt21-comet-da",
    "unbabel/wmt20-comet-da",
)


def model_requires_reference(model_name: str) -> bool:
    return model_name.lower() in REFERENCE_REQUIRED_MODELS


def _num_workers() -> int:
    """Number of DataLoader workers for `model.predict()`.

    Defaults to 1. Override with `XCOMET_NUM_WORKERS` to tune throughput on
    machines with idle CPU cores (especially relevant for large batches on
    GPU). Invalid values, and anything below 1, fall back to 1.

    The floor of 1 is not cosmetic on Apple Silicon. COMET builds its
    DataLoader with `multiprocessing_context="fork" if
    torch.backends.mps.is_available() else None`, and torch rejects a
    multiprocessing context when `num_workers=0`:

        ValueError: multiprocessing_context can only be used with
        multi-process loading (num_workers > 0), but got num_workers=0

    COMET's own default is `2 * gpus`, which is 0 for CPU inference, so
    calling `predict()` on a Mac without passing `num_workers` raises. This
    server always passes a value of at least 1, which is why CPU inference
    works here.
    """
    raw = os.environ.get("XCOMET_NUM_WORKERS", "1")
    try:
        n = int(raw)
        return n if n >= 1 else 1
    except ValueError:
        return 1


# -----------------------------------------------------------------------------
# Parameter helpers
# -----------------------------------------------------------------------------

def _require(params: Dict[str, Any], key: str) -> Any:
    """Return params[key] or raise a friendly ValueError if missing/empty."""
    if key not in params:
        raise ValueError(f'missing required parameter: "{key}"')
    value = params[key]
    if value is None or value == "":
        raise ValueError(f'parameter "{key}" must not be empty')
    return value


def _error_spans(output, index: int) -> list:
    """Error spans for sample `index` of a `model.predict()` result.

    COMET's `Prediction` extends its own `ModelOutput` (a vendored copy of an
    old transformers class, `comet/models/utils.py:23`), whose `__getitem__`
    returns `to_tuple()[k]` for any key that is not a `str`.
    `output.metadata[0]` therefore returns the first *value* of the metadata
    dict — for XCOMET that is `src_scores`, a list of floats — and not
    sample 0's entry. A following `"error_spans" in metadata` test then runs
    against that list of floats and is always False, which is why every
    result reported zero errors up to 0.6.3. `len(output.metadata)` is the
    number of keys (3 for the reference-free branch, 5 with a reference),
    not the number of samples, so bounding a batch loop with it was wrong
    for the same reason.

    The key has to be a string. `metadata["error_spans"]` is one list of
    spans per sample, in the order the samples were passed in
    (`predict()` restores the order after length batching).

    Returns an empty list for models that emit no spans at all, such as the
    regression metrics (`Unbabel/wmt22-comet-da`).
    """
    metadata = getattr(output, "metadata", None)
    if not metadata or "error_spans" not in metadata:
        return []

    spans_by_sample = metadata["error_spans"]
    if index >= len(spans_by_sample):
        return []

    return [
        {
            "text": span.get("text", ""),
            "start": span.get("start", 0),
            "end": span.get("end", 0),
            "severity": span.get("severity", "minor"),
        }
        for span in (spans_by_sample[index] or [])
    ]


# -----------------------------------------------------------------------------
# Core inference
# -----------------------------------------------------------------------------

def _evaluate_internal(source: str, translation: str, reference: Optional[str], use_gpu: bool):
    """Shared inference used by evaluate + detect_errors. Returns (result, inference_time_ms)."""
    model = get_model()
    model_name = os.environ.get("XCOMET_MODEL", "Unbabel/XCOMET-XL")

    if not reference and model_requires_reference(model_name):
        raise ValueError(f'Model "{model_name}" requires a reference translation.')

    data = [{"src": source, "mt": translation}]
    if reference:
        data[0]["ref"] = reference

    gpus = 1 if use_gpu else 0
    inference_start = time.time()
    output = model.predict(
        data, batch_size=1, gpus=gpus, num_workers=_num_workers(), progress_bar=False
    )
    inference_time = round((time.time() - inference_start) * 1000)

    score = float(output.scores[0])
    errors = _error_spans(output, 0)

    if score >= 0.9:
        quality = "Excellent"
    elif score >= 0.7:
        quality = "Good"
    elif score >= 0.5:
        quality = "Fair"
    else:
        quality = "Poor"

    result = {
        "score": score,
        "errors": errors,
        "summary": f"{quality} quality (score: {score:.3f}) with {len(errors)} error(s) detected.",
    }
    return result, inference_time


# -----------------------------------------------------------------------------
# RPC handlers
# -----------------------------------------------------------------------------

def handle_evaluate(params: Dict[str, Any]) -> Dict[str, Any]:
    result, inference_time = _evaluate_internal(
        _require(params, "source"),
        _require(params, "translation"),
        params.get("reference"),
        params.get("use_gpu", False),
    )
    _bump_stats(
        evaluate_rpc_count=1,
        total_pairs_evaluated=1,
        total_inference_time_ms=inference_time,
    )
    return result


def handle_detect_errors(params: Dict[str, Any]) -> Dict[str, Any]:
    eval_result, inference_time = _evaluate_internal(
        _require(params, "source"),
        _require(params, "translation"),
        params.get("reference"),
        params.get("use_gpu", False),
    )
    _bump_stats(
        detect_errors_rpc_count=1,
        total_pairs_evaluated=1,
        total_inference_time_ms=inference_time,
    )

    severity_order = {"minor": 0, "major": 1, "critical": 2}
    min_severity = params.get("min_severity", "minor")
    min_severity_order = severity_order.get(min_severity, 0)

    filtered_errors = [
        e for e in eval_result["errors"]
        if severity_order.get(e["severity"], 0) >= min_severity_order
    ]

    errors_by_severity = {"minor": 0, "major": 0, "critical": 0}
    for error in filtered_errors:
        errors_by_severity[error["severity"]] += 1

    return {
        "total_errors": len(filtered_errors),
        "errors_by_severity": errors_by_severity,
        "errors": filtered_errors,
    }


def handle_batch_evaluate(params: Dict[str, Any]) -> Dict[str, Any]:
    pairs = params.get("pairs", [])
    batch_size = params.get("batch_size", 8)
    use_gpu = params.get("use_gpu", False)

    if not pairs:
        return {
            "average_score": 0,
            "total_pairs": 0,
            "results": [],
            "summary": "No pairs to evaluate.",
        }

    model = get_model()
    model_name = os.environ.get("XCOMET_MODEL", "Unbabel/XCOMET-XL")

    if model_requires_reference(model_name):
        missing_ref_count = sum(1 for p in pairs if not p.get("reference"))
        if missing_ref_count > 0:
            raise ValueError(
                f'Model "{model_name}" requires reference translations. '
                f'{missing_ref_count} pairs are missing reference.'
            )

    # Validate per-pair required fields up front, before model.predict() —
    # otherwise a missing key surfaces as an opaque KeyError.
    data = []
    for i, pair in enumerate(pairs):
        if "source" not in pair or pair.get("source") in (None, ""):
            raise ValueError(f'pairs[{i}]: missing required field "source"')
        if "translation" not in pair or pair.get("translation") in (None, ""):
            raise ValueError(f'pairs[{i}]: missing required field "translation"')
        item = {"src": pair["source"], "mt": pair["translation"]}
        if pair.get("reference"):
            item["ref"] = pair["reference"]
        data.append(item)

    gpus = 1 if use_gpu else 0
    inference_start = time.time()
    output = model.predict(
        data, batch_size=batch_size, gpus=gpus, num_workers=_num_workers(), progress_bar=False
    )
    inference_time = round((time.time() - inference_start) * 1000)

    _bump_stats(
        batch_rpc_count=1,
        total_pairs_evaluated=len(pairs),
        total_inference_time_ms=inference_time,
    )

    results = []
    for i, score in enumerate(output.scores):
        errors = _error_spans(output, i)
        results.append({
            "index": i,
            "score": float(score),
            "errors": errors,
            "error_count": len(errors),
            "has_critical_errors": any(e["severity"] == "critical" for e in errors),
        })

    total_score = sum(r["score"] for r in results)
    average_score = total_score / len(results) if results else 0
    good_count = sum(1 for r in results if r["score"] >= 0.7)
    critical_count = sum(1 for r in results if r["has_critical_errors"])

    return {
        "average_score": average_score,
        "total_pairs": len(pairs),
        "results": results,
        "summary": (
            f"Evaluated {len(pairs)} pairs. Average score: {average_score:.3f}. "
            f"{good_count} good quality, {critical_count} with critical errors."
        ),
    }


def handle_health(_params: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "status": "ok",
        "model_loaded": _model is not None,
        "model_name": _model_name or os.environ.get("XCOMET_MODEL", "Unbabel/XCOMET-XL"),
    }


def handle_stats(_params: Dict[str, Any]) -> Dict[str, Any]:
    uptime_seconds = None
    if _stats["start_time"] is not None:
        uptime_seconds = round(time.time() - _stats["start_time"])

    total_rpc_calls = (
        _stats["evaluate_rpc_count"]
        + _stats["detect_errors_rpc_count"]
        + _stats["batch_rpc_count"]
    )
    avg_inference_time_ms = None
    if total_rpc_calls > 0:
        avg_inference_time_ms = round(_stats["total_inference_time_ms"] / total_rpc_calls)

    return {
        "uptime_seconds": uptime_seconds,
        "model_loaded": _model is not None,
        "model_load_time_ms": _stats["model_load_time"],
        "evaluate_rpc_count": _stats["evaluate_rpc_count"],
        "detect_errors_rpc_count": _stats["detect_errors_rpc_count"],
        "batch_rpc_count": _stats["batch_rpc_count"],
        "total_pairs_evaluated": _stats["total_pairs_evaluated"],
        "total_inference_time_ms": _stats["total_inference_time_ms"],
        "avg_inference_time_ms": avg_inference_time_ms,
    }


HANDLERS: Dict[str, Callable[[Dict[str, Any]], Dict[str, Any]]] = {
    "evaluate": handle_evaluate,
    "detect_errors": handle_detect_errors,
    "batch_evaluate": handle_batch_evaluate,
    "health": handle_health,
    "stats": handle_stats,
}


# -----------------------------------------------------------------------------
# I/O helpers
# -----------------------------------------------------------------------------

def send(msg: Dict[str, Any]) -> None:
    """Write a protocol message to stdout (one JSON per line, flushed)."""
    sys.stdout.write(json.dumps(msg, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def send_ready(ok: bool, error: Optional[str] = None) -> None:
    msg: Dict[str, Any] = {"type": "ready", "ok": ok}
    if error is not None:
        msg["error"] = error
    send(msg)


# -----------------------------------------------------------------------------
# Main loop
# -----------------------------------------------------------------------------

def main() -> None:
    _stats["start_time"] = time.time()
    log("Starting xCOMET stdio server")

    # Eager loading
    if os.environ.get("XCOMET_PRELOAD", "").lower() in ("true", "1", "yes"):
        log("Preloading model (XCOMET_PRELOAD=true)...")
        try:
            get_model()
        except Exception as e:
            log(f"Preload failed: {e}")
            send_ready(False, str(e))
            sys.exit(1)

    send_ready(True)
    log("Ready. Waiting for requests on stdin.")

    while True:
        line = sys.stdin.readline()
        if not line:  # EOF → parent closed stdin
            break
        line = line.strip()
        if not line:
            continue

        req_id: Any = None
        try:
            req = json.loads(line)
            req_id = req.get("id")
            method = req.get("method")
            params = req.get("params") or {}

            handler = HANDLERS.get(method) if isinstance(method, str) else None
            if handler is None:
                send({"id": req_id, "error": f"Unknown method: {method}"})
                continue

            try:
                result = handler(params)
                send({"id": req_id, "result": result})
            except ValueError as e:
                send({"id": req_id, "error": str(e)})
            except Exception as e:
                log(f"Handler error: {e}")
                send({"id": req_id, "error": str(e)})

        except json.JSONDecodeError as e:
            send({"id": req_id, "error": f"Invalid JSON: {e}"})
        except Exception as e:
            log(f"Unexpected error: {e}")
            send({"id": req_id, "error": str(e)})

    log("stdin closed, shutting down")


if __name__ == "__main__":
    main()
