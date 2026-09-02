"""Python-side unit tests.

Run with `npm run test:python` (needs pytest; nothing else — no comet, no
torch, no model download).

The stdio protocol itself is exercised end-to-end from the Node side (see
tests/integration.test.ts and tests/user-scenarios.test.ts). What lives here
is the part of python/server.py that reads COMET's prediction structures,
because getting that wrong is silent: the server keeps answering, the scores
stay correct, and only the error spans go missing. That is exactly what
happened between v0.3.4 and v0.6.3.
"""

import importlib.util
import os
from collections import OrderedDict

import pytest

SERVER_PY = os.path.join(os.path.dirname(__file__), "..", "python", "server.py")


def _load_server():
    spec = importlib.util.spec_from_file_location("xcomet_server", SERVER_PY)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


server = _load_server()


class ModelOutput(OrderedDict):
    """Copy of COMET's own ModelOutput (comet/models/utils.py:23).

    COMET vendored this from an old transformers release rather than using
    the current one. The behaviour that matters here is __getitem__: a key
    that is not a str indexes the *values*, so `metadata[0]` is the first
    value in the dict, not sample 0's entry.
    """

    def __getitem__(self, k):
        if isinstance(k, str):
            inner_dict = {k: v for (k, v) in self.items()}
            return inner_dict[k]
        return self.to_tuple()[k]

    def __setattr__(self, name, value):
        if name in self.keys() and value is not None:
            super().__setitem__(name, value)
        super().__setattr__(name, value)

    def __setitem__(self, key, value):
        super().__setitem__(key, value)
        super().__setattr__(key, value)

    def to_tuple(self):
        return tuple(self[k] for k in self.keys())


class Prediction(ModelOutput):
    """comet/models/utils.py:123"""


CRITICAL = {"text": "ten years", "start": 25, "end": 34, "severity": "critical", "confidence": 0.91}
MINOR = {"text": "purple", "start": 13, "end": 19, "severity": "minor", "confidence": 0.55}


def qe_output():
    """What predict() returns for XCOMET without a reference.

    XCOMETMetric.predict_step builds metadata with the keys src_scores,
    mqm_scores and error_spans, in that order; each value holds one entry
    per sample.
    """
    return Prediction(
        scores=[1.0, 0.95, 0.21],
        metadata=Prediction(
            src_scores=[1.0, 0.98, 0.30],
            mqm_scores=[1.0, 1.0, 0.60],
            error_spans=[[CRITICAL], [], [MINOR, CRITICAL]],
        ),
    )


def test_indexing_metadata_by_position_returns_the_wrong_thing():
    """Guards the assumption the fix rests on.

    If a future COMET release changes ModelOutput so that metadata[0] does
    return sample 0's entry, this test fails and the helper can be
    simplified. Until then, positional indexing yields src_scores.
    """
    output = qe_output()
    assert output.metadata[0] == [1.0, 0.98, 0.30]
    assert "error_spans" not in output.metadata[0]
    # Not the sample count — this is why bounding a batch loop with it broke.
    assert len(output.metadata) == 3


def test_error_spans_are_returned_per_sample():
    output = qe_output()
    assert server._error_spans(output, 0) == [
        {"text": "ten years", "start": 25, "end": 34, "severity": "critical"}
    ]
    assert server._error_spans(output, 1) == []
    assert server._error_spans(output, 2) == [
        {"text": "purple", "start": 13, "end": 19, "severity": "minor"},
        {"text": "ten years", "start": 25, "end": 34, "severity": "critical"},
    ]


def test_confidence_is_dropped():
    """The tool's output schema has text/start/end/severity and nothing else."""
    spans = server._error_spans(qe_output(), 0)
    assert set(spans[0]) == {"text", "start", "end", "severity"}


def test_index_past_the_last_sample_is_empty():
    assert server._error_spans(qe_output(), 3) == []


def test_reference_branch_has_five_metadata_keys():
    """With a reference, predict_step adds ref_scores and unified_scores."""
    output = Prediction(
        scores=[0.4],
        metadata=Prediction(
            src_scores=[0.5],
            ref_scores=[0.5],
            unified_scores=[0.5],
            mqm_scores=[0.6],
            error_spans=[[MINOR]],
        ),
    )
    assert server._error_spans(output, 0) == [
        {"text": "purple", "start": 13, "end": 19, "severity": "minor"}
    ]


def test_model_without_metadata_yields_no_spans():
    """Regression metrics such as Unbabel/wmt22-comet-da emit no metadata."""
    assert server._error_spans(Prediction(scores=[0.8]), 0) == []


def test_metadata_without_error_spans_yields_no_spans():
    output = Prediction(scores=[0.8], metadata=Prediction(src_scores=[0.8]))
    assert server._error_spans(output, 0) == []


def test_missing_span_fields_fall_back():
    output = Prediction(scores=[0.1], metadata=Prediction(error_spans=[[{"text": "x"}]]))
    assert server._error_spans(output, 0) == [
        {"text": "x", "start": 0, "end": 0, "severity": "minor"}
    ]


@pytest.mark.parametrize(
    "model_name,expected",
    [
        ("Unbabel/wmt22-comet-da", True),
        ("unbabel/WMT22-COMET-DA", True),
        ("Unbabel/XCOMET-XL", False),
        ("Unbabel/wmt22-comet-da-v2-experimental", False),
    ],
)
def test_model_requires_reference_is_an_exact_match(model_name, expected):
    assert server.model_requires_reference(model_name) is expected


@pytest.mark.parametrize(
    "raw,expected",
    [(None, 1), ("1", 1), ("4", 4), ("0", 1), ("-3", 1), ("abc", 1), ("", 1)],
)
def test_num_workers_falls_back_to_one(monkeypatch, raw, expected):
    monkeypatch.delenv("XCOMET_NUM_WORKERS", raising=False)
    if raw is not None:
        monkeypatch.setenv("XCOMET_NUM_WORKERS", raw)
    assert server._num_workers() == expected


@pytest.mark.parametrize(
    "raw,expected",
    [(None, False), ("true", True), ("TRUE", True), ("1", True), ("yes", True), ("false", False), ("no", False)],
)
def test_local_files_only_flag(monkeypatch, raw, expected):
    monkeypatch.delenv("XCOMET_LOCAL_FILES_ONLY", raising=False)
    if raw is not None:
        monkeypatch.setenv("XCOMET_LOCAL_FILES_ONLY", raw)
    assert server._local_files_only() is expected


def test_saving_directory_expands_home(monkeypatch):
    monkeypatch.setenv("XCOMET_SAVING_DIRECTORY", "~/models")
    assert server._saving_directory() == os.path.expanduser("~/models")
    monkeypatch.setenv("XCOMET_SAVING_DIRECTORY", "  ")
    assert server._saving_directory() is None
    monkeypatch.delenv("XCOMET_SAVING_DIRECTORY")
    assert server._saving_directory() is None
