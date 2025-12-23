#!/usr/bin/env python3
"""
xCOMET Persistent Server
Keeps the model loaded in memory for fast inference.
"""

import os
import sys
import json
import signal
import warnings
from typing import Optional, List
from contextlib import asynccontextmanager

# Suppress warnings
warnings.filterwarnings("ignore")
os.environ["TOKENIZERS_PARALLELISM"] = "false"

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
import uvicorn

# Global model instance
_model = None
_model_name = None


class EvaluateRequest(BaseModel):
    source: str
    translation: str
    reference: Optional[str] = None
    use_gpu: bool = False


class TranslationPair(BaseModel):
    source: str
    translation: str
    reference: Optional[str] = None


class BatchEvaluateRequest(BaseModel):
    pairs: List[TranslationPair]
    batch_size: int = 8
    use_gpu: bool = False


class DetectErrorsRequest(BaseModel):
    source: str
    translation: str
    reference: Optional[str] = None
    min_severity: str = "minor"
    use_gpu: bool = False


def get_model():
    """Lazy load the model on first request."""
    global _model, _model_name

    if _model is None:
        model_name = os.environ.get("XCOMET_MODEL", "Unbabel/XCOMET-XL")
        print(f"[xcomet-server] Loading model: {model_name}", file=sys.stderr)

        from comet import download_model, load_from_checkpoint
        model_path = download_model(model_name)
        _model = load_from_checkpoint(model_path)
        _model_name = model_name

        print(f"[xcomet-server] Model loaded successfully", file=sys.stderr)

    return _model


def model_requires_reference(model_name: str) -> bool:
    """Check if the model requires a reference translation."""
    ref_required = ["wmt22-comet-da", "wmt21-comet-da", "wmt20-comet-da"]
    return any(r in model_name.lower() for r in ref_required)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Handle startup and shutdown."""
    print(f"[xcomet-server] Starting on port {os.environ.get('PORT', 'unknown')}", file=sys.stderr)
    yield
    print("[xcomet-server] Shutting down...", file=sys.stderr)


app = FastAPI(title="xCOMET Server", lifespan=lifespan)


@app.get("/health")
async def health():
    """Health check endpoint."""
    global _model, _model_name
    return {
        "status": "ok",
        "model_loaded": _model is not None,
        "model_name": _model_name or os.environ.get("XCOMET_MODEL", "Unbabel/XCOMET-XL")
    }


@app.post("/evaluate")
async def evaluate(request: EvaluateRequest):
    """Evaluate a single translation."""
    try:
        model = get_model()
        model_name = os.environ.get("XCOMET_MODEL", "Unbabel/XCOMET-XL")

        # Validate reference requirement
        if not request.reference and model_requires_reference(model_name):
            raise HTTPException(
                status_code=400,
                detail=f'Model "{model_name}" requires a reference translation.'
            )

        data = [{
            "src": request.source,
            "mt": request.translation,
        }]
        if request.reference:
            data[0]["ref"] = request.reference

        gpus = 1 if request.use_gpu else 0
        output = model.predict(data, batch_size=1, gpus=gpus, num_workers=1)

        score = float(output.scores[0])
        errors = []

        # Extract error spans if available
        if hasattr(output, 'metadata') and output.metadata:
            metadata = output.metadata[0]
            if metadata and 'error_spans' in metadata:
                for span in metadata['error_spans']:
                    errors.append({
                        "text": span.get("text", ""),
                        "start": span.get("start", 0),
                        "end": span.get("end", 0),
                        "severity": span.get("severity", "minor")
                    })

        # Generate summary
        if score >= 0.9:
            quality = "Excellent"
        elif score >= 0.7:
            quality = "Good"
        elif score >= 0.5:
            quality = "Fair"
        else:
            quality = "Poor"

        return {
            "score": score,
            "errors": errors,
            "summary": f"{quality} quality (score: {score:.3f}) with {len(errors)} error(s) detected."
        }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/detect_errors")
async def detect_errors(request: DetectErrorsRequest):
    """Detect errors in a translation."""
    try:
        # Get evaluation result first
        eval_request = EvaluateRequest(
            source=request.source,
            translation=request.translation,
            reference=request.reference,
            use_gpu=request.use_gpu
        )
        eval_result = await evaluate(eval_request)

        # Filter errors by severity
        severity_order = {"minor": 0, "major": 1, "critical": 2}
        min_severity_order = severity_order.get(request.min_severity, 0)

        filtered_errors = [
            e for e in eval_result["errors"]
            if severity_order.get(e["severity"], 0) >= min_severity_order
        ]

        # Count by severity
        errors_by_severity = {"minor": 0, "major": 0, "critical": 0}
        for error in filtered_errors:
            errors_by_severity[error["severity"]] += 1

        return {
            "total_errors": len(filtered_errors),
            "errors_by_severity": errors_by_severity,
            "errors": [{"suggestion": None, **e} for e in filtered_errors]
        }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/batch_evaluate")
async def batch_evaluate(request: BatchEvaluateRequest):
    """Evaluate multiple translations in a batch."""
    try:
        if not request.pairs:
            return {
                "average_score": 0,
                "total_pairs": 0,
                "results": [],
                "summary": "No pairs to evaluate."
            }

        model = get_model()
        model_name = os.environ.get("XCOMET_MODEL", "Unbabel/XCOMET-XL")

        # Validate reference requirement
        if model_requires_reference(model_name):
            missing_ref_count = sum(1 for p in request.pairs if not p.reference)
            if missing_ref_count > 0:
                raise HTTPException(
                    status_code=400,
                    detail=f'Model "{model_name}" requires reference translations. {missing_ref_count} pairs are missing reference.'
                )

        # Build data list
        data = []
        for pair in request.pairs:
            item = {"src": pair.source, "mt": pair.translation}
            if pair.reference:
                item["ref"] = pair.reference
            data.append(item)

        gpus = 1 if request.use_gpu else 0
        output = model.predict(data, batch_size=request.batch_size, gpus=gpus, num_workers=1)

        # Build results
        results = []
        for i, score in enumerate(output.scores):
            result = {
                "index": i,
                "score": float(score),
                "errors": [],
                "error_count": 0,
                "has_critical_errors": False
            }

            # Extract error spans if available
            if hasattr(output, 'metadata') and output.metadata and i < len(output.metadata):
                metadata = output.metadata[i]
                if metadata and 'error_spans' in metadata:
                    for span in metadata['error_spans']:
                        result["errors"].append({
                            "text": span.get("text", ""),
                            "start": span.get("start", 0),
                            "end": span.get("end", 0),
                            "severity": span.get("severity", "minor")
                        })
                        if span.get("severity") == "critical":
                            result["has_critical_errors"] = True
                    result["error_count"] = len(result["errors"])

            results.append(result)

        # Calculate statistics
        total_score = sum(r["score"] for r in results)
        average_score = total_score / len(results) if results else 0
        good_count = sum(1 for r in results if r["score"] >= 0.7)
        critical_count = sum(1 for r in results if r["has_critical_errors"])

        return {
            "average_score": average_score,
            "total_pairs": len(request.pairs),
            "results": results,
            "summary": f"Evaluated {len(request.pairs)} pairs. Average score: {average_score:.3f}. {good_count} good quality, {critical_count} with critical errors."
        }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/shutdown")
async def shutdown():
    """Graceful shutdown endpoint."""
    print("[xcomet-server] Shutdown requested", file=sys.stderr)
    os.kill(os.getpid(), signal.SIGTERM)
    return {"status": "shutting_down"}


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "0"))

    # If port is 0, let uvicorn pick a random available port
    config = uvicorn.Config(
        app,
        host="127.0.0.1",
        port=port,
        log_level="warning"
    )
    server = uvicorn.Server(config)

    # Print the actual port to stdout for the Node.js process to read
    if port == 0:
        import socket
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
        sock.close()
        config.port = port

    print(json.dumps({"port": port}), flush=True)

    server.run()
