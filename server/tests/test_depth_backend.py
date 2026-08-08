"""The lazy torch/transformers plumbing, exercised without torch or transformers.

`depth_backend` is the one module in the project that genuinely needs a 2 GB wheel to run, and
the suite must keep passing without it — so the wheel is *substituted*: fake `torch` and
`transformers` modules are installed into `sys.modules` for the duration of a test. That is
enough to drive the real control flow (device selection, the model cache, the processor
contract, the two post-processing paths, the error wrapping) and none of it is reachable any
other way, which is why this file exists rather than leaving the module at a quarter covered.

The fakes are deliberately dumb: they record what they were called with and hand back arrays.
Anything that would need real inference semantics is out of scope here — that lives in
`test_depth_geometry.py`, downstream of this module, on real numpy.
"""

import contextlib
import sys
import types

import numpy as np
import pytest
from PIL import Image

from app.config import Settings
from app.engines import depth_backend
from app.engines import depth_models as catalog
from app.engines.base import EngineError


def _settings(**kw) -> Settings:
    base = dict(auth_disabled=True, depth_range=8.0)
    base.update(kw)
    return Settings(**base)


# ── fake torch / transformers ─────────────────────────────────────────────────────────────

class FakeTensor:
    """Just enough tensor to satisfy `predict_depth`'s use of one."""

    def __init__(self, array):
        self.array = np.asarray(array, dtype=np.float32)
        self.moved_to: list[str] = []

    @property
    def ndim(self) -> int:
        return self.array.ndim

    def unsqueeze(self, axis):
        return FakeTensor(np.expand_dims(self.array, axis))

    def detach(self):
        return self

    def to(self, device):
        self.moved_to.append(str(device))
        return self

    def float(self):
        return self

    def numpy(self):
        return self.array

    def reshape(self, *shape):
        return FakeTensor(self.array.reshape(*shape))

    def item(self) -> float:
        return float(self.array.reshape(-1)[0])

    def __getitem__(self, index):
        return FakeTensor(self.array[index])


def _interpolate(tensor, size=None, mode=None, align_corners=None):
    """Nearest-neighbour stand-in for `torch.nn.functional.interpolate`.

    Only the *shape* it produces matters to `predict_depth` — the resampling quality is
    torch's problem, not this project's.
    """
    h, w = size
    a = tensor.array
    ys = np.linspace(0, a.shape[-2] - 1, h).round().astype(int)
    xs = np.linspace(0, a.shape[-1] - 1, w).round().astype(int)
    return FakeTensor(a[..., ys[:, None], xs[None, :]])


def _make_torch(*, cuda: bool = False, mps: bool | None = False) -> types.ModuleType:
    torch = types.ModuleType("torch")
    torch.cuda = types.SimpleNamespace(is_available=lambda: cuda)
    # `mps=None` models an old torch build where `torch.backends.mps` does not exist at all —
    # the reason `select_device` uses getattr instead of a plain attribute access.
    backends = types.SimpleNamespace()
    if mps is not None:
        backends.mps = types.SimpleNamespace(is_available=lambda: mps)
    torch.backends = backends
    torch.no_grad = contextlib.nullcontext
    torch.nn = types.SimpleNamespace(functional=types.SimpleNamespace(interpolate=_interpolate))
    return torch


class FakeModel:
    def __init__(self, output, fail: bool = False):
        self._output = output
        self._fail = fail
        self.device = "cpu"
        self.eval_called = False
        self.seen_inputs: dict | None = None

    def to(self, device):
        self.device = device
        return self

    def eval(self):
        self.eval_called = True

    def __call__(self, **inputs):
        self.seen_inputs = inputs
        if self._fail:
            raise RuntimeError("CUDA out of memory")
        return self._output


class FakeProcessor:
    def __init__(self, *, inputs=None, post=None):
        self._inputs = inputs
        if post is not None:
            self.post_process_depth_estimation = post

    def __call__(self, images=None, return_tensors=None):
        w, h = images.size
        return self._inputs if self._inputs is not None else {
            "pixel_values": FakeTensor(np.zeros((1, 3, h, w), dtype=np.float32))
        }


@pytest.fixture(autouse=True)
def clean_model_cache():
    """The model cache is process-global, so a fake left in it would poison later tests."""
    depth_backend.reset_model_cache()
    yield
    depth_backend.reset_model_cache()


@pytest.fixture()
def fake_stack(monkeypatch):
    """Install fake torch + transformers and report what `from_pretrained` was asked for."""
    calls: list[tuple[str, dict]] = []

    def install(*, output=None, processor=None, model=None, cuda=False, mps=False, boom=None):
        monkeypatch.setattr(depth_backend, "missing_python_deps", lambda: [])
        monkeypatch.setattr(depth_backend, "downloads_disabled", lambda: False)
        monkeypatch.setitem(sys.modules, "torch", _make_torch(cuda=cuda, mps=mps))

        the_model = model if model is not None else FakeModel(output)
        the_processor = processor if processor is not None else FakeProcessor()

        def from_pretrained_processor(repo, **kwargs):
            calls.append((repo, kwargs))
            if boom:
                raise boom
            return the_processor

        def from_pretrained_model(repo, **kwargs):
            calls.append((repo, kwargs))
            return the_model

        transformers = types.ModuleType("transformers")
        transformers.AutoImageProcessor = types.SimpleNamespace(
            from_pretrained=from_pretrained_processor
        )
        transformers.AutoModelForDepthEstimation = types.SimpleNamespace(
            from_pretrained=from_pretrained_model
        )
        monkeypatch.setitem(sys.modules, "transformers", transformers)
        return types.SimpleNamespace(calls=calls, model=the_model, processor=the_processor)

    return install


# ── device selection ──────────────────────────────────────────────────────────────────────

@pytest.mark.parametrize(
    "cuda, mps, expected",
    [
        (True, True, "cuda"),        # a discrete GPU always wins
        (False, True, "mps"),        # Apple silicon: ~10x CPU on the small checkpoint
        (False, False, "cpu"),
        (False, None, "cpu"),        # a torch build with no torch.backends.mps at all
    ],
)
def test_select_device_prefers_cuda_then_mps_then_cpu(monkeypatch, cuda, mps, expected):
    monkeypatch.setitem(sys.modules, "torch", _make_torch(cuda=cuda, mps=mps))
    assert depth_backend.select_device() == expected


# ── the weights cache directory ───────────────────────────────────────────────────────────

def test_the_weights_mount_is_only_offered_to_transformers_when_it_exists(tmp_path):
    """MODEL_WEIGHTS_DIR defaults to /models, which exists in the container and not on a laptop.

    Handing transformers a non-existent absolute path makes it try to create it and fail with a
    permission error that reads nothing like "you have no weights", so the path is only passed
    on when it is really there.
    """
    assert depth_backend._cache_dir(_settings(model_weights_dir=tmp_path)) == str(tmp_path)
    missing = tmp_path / "not-created"
    assert depth_backend._cache_dir(_settings(model_weights_dir=missing)) is None


# ── loading ───────────────────────────────────────────────────────────────────────────────

def test_load_refuses_before_it_ever_reaches_the_transformers_import(monkeypatch):
    """The deps check has to come first: `from transformers import ...` would ImportError."""
    monkeypatch.setattr(depth_backend, "missing_python_deps", lambda: ["torch", "transformers"])
    monkeypatch.delitem(sys.modules, "transformers", raising=False)
    with pytest.raises(EngineError, match=r"\[depth\]"):
        depth_backend._load(catalog.DEPTH_ANYTHING_V2_SMALL, _settings())


def test_weights_are_loaded_once_and_reused_for_every_subsequent_frame(fake_stack):
    """The stated reason the cache exists: a 32-frame video would otherwise reload per frame.

    Two `from_pretrained` calls (processor + model) on the first request and none after — at
    ~100 MB to ~1.9 GB a checkpoint, getting this wrong does not fail a test, it just makes
    every video job unusably slow.
    """
    stack = fake_stack()
    settings = _settings()
    first = depth_backend._load(catalog.DEPTH_ANYTHING_V2_SMALL, settings)
    assert len(stack.calls) == 2
    for _ in range(5):
        # Tuple equality, not `is`: the first call returns a freshly built tuple while later
        # calls hand back the stored one. What must be identical is the processor and the
        # model inside it — those are the hundreds of megabytes.
        assert depth_backend._load(catalog.DEPTH_ANYTHING_V2_SMALL, settings) == first
    assert len(stack.calls) == 2
    assert stack.model.eval_called, "a model left in train mode gives non-deterministic depth"


def test_a_second_checkpoint_gets_its_own_cache_entry(fake_stack):
    """The key is (repo, device), so switching models must not hand back the previous one."""
    stack = fake_stack()
    settings = _settings()
    depth_backend._load(catalog.DEPTH_ANYTHING_V2_SMALL, settings)
    depth_backend._load(catalog.MIDAS_DPT_HYBRID, settings)
    assert {repo for repo, _ in stack.calls} == {
        catalog.DEPTH_ANYTHING_V2_SMALL.hf_repo,
        catalog.MIDAS_DPT_HYBRID.hf_repo,
    }


def test_reset_model_cache_forces_the_next_load_to_go_back_to_disk(fake_stack):
    stack = fake_stack()
    depth_backend._load(catalog.DEPTH_ANYTHING_V2_SMALL, _settings())
    depth_backend.reset_model_cache()
    depth_backend._load(catalog.DEPTH_ANYTHING_V2_SMALL, _settings())
    assert len(stack.calls) == 4


def test_offline_mode_and_the_weights_mount_reach_from_pretrained(fake_stack, monkeypatch, tmp_path):
    """`local_files_only` is what makes an air-gapped box fail fast instead of hanging on DNS."""
    stack = fake_stack()
    monkeypatch.setattr(depth_backend, "downloads_disabled", lambda: True)
    depth_backend._load(catalog.DEPTH_ANYTHING_V2_SMALL, _settings(model_weights_dir=tmp_path))
    for _repo, kwargs in stack.calls:
        assert kwargs["local_files_only"] is True
        assert kwargs["cache_dir"] == str(tmp_path)


def test_a_missing_weights_mount_is_omitted_rather_than_passed_as_none(fake_stack, tmp_path):
    """`cache_dir=None` and "no cache_dir" are the same to transformers today, but only one of
    them stays true across versions; the code chooses to omit and this pins that."""
    stack = fake_stack()
    depth_backend._load(
        catalog.DEPTH_ANYTHING_V2_SMALL, _settings(model_weights_dir=tmp_path / "nope")
    )
    assert all("cache_dir" not in kwargs for _repo, kwargs in stack.calls)


def test_a_download_failure_names_the_repo_the_size_and_the_way_out(fake_stack):
    """Network, auth, disk and version errors all land here and all read the same to a user."""
    fake_stack(boom=OSError("Connection reset by peer"))
    with pytest.raises(EngineError) as exc:
        depth_backend._load(catalog.DEPTH_PRO, _settings())
    message = str(exc.value)
    assert catalog.DEPTH_PRO.hf_repo in message
    assert "1900 MB" in message
    assert "Connection reset by peer" in message
    assert "HF_HUB_OFFLINE" in message


# ── prediction ────────────────────────────────────────────────────────────────────────────

def _image(w: int = 24, h: int = 16) -> Image.Image:
    return Image.new("RGB", (w, h), (30, 60, 90))


def test_predict_depth_rejects_a_checkpoint_that_is_not_an_in_process_one():
    """Video Depth Anything is a subprocess adapter; routing it here would be a silent no-op."""
    with pytest.raises(EngineError, match="not an in-process"):
        depth_backend.predict_depth(
            _image(), catalog.VIDEO_DEPTH_ANYTHING_SMALL, _settings()
        )


def test_predict_depth_leaves_non_tensor_processor_outputs_alone(fake_stack):
    """Regression: `.to()` on a plain list is an AttributeError that reads like a broken model.

    Depth Pro's processor returns image sizes as ordinary Python lists alongside the pixel
    tensor. Moving every value to the device unconditionally crashed on those, and the
    traceback pointed at the model rather than at a shape of data the code did not expect.
    """
    sizes = [[16, 24]]
    processor = FakeProcessor(
        inputs={"pixel_values": FakeTensor(np.zeros((1, 3, 16, 24))), "image_sizes": sizes}
    )
    stack = fake_stack(
        processor=processor,
        output=types.SimpleNamespace(
            predicted_depth=FakeTensor(np.ones((1, 16, 24), dtype=np.float32))
        ),
    )
    depth_backend.predict_depth(_image(), catalog.DEPTH_ANYTHING_V2_SMALL, _settings())
    assert stack.model.seen_inputs["image_sizes"] is sizes, "the list must pass through as-is"
    assert stack.model.seen_inputs["pixel_values"].moved_to == ["cpu"]


def test_predict_depth_keeps_the_focal_length_depth_pro_predicts(fake_stack):
    """The one thing Depth Pro offers over every other checkpoint here.

    Losing it silently degrades the back-projection to the assumed 60-degree field of view —
    the geometry still renders, it is just wrong, which is the hardest kind of bug to notice.
    """
    depth = np.linspace(1.0, 4.0, 16 * 24, dtype=np.float32).reshape(16, 24)
    processor = FakeProcessor(
        post=lambda outputs, target_sizes=None: [
            {"predicted_depth": FakeTensor(depth), "focal_length": FakeTensor([812.5])}
        ]
    )
    fake_stack(processor=processor, output=types.SimpleNamespace(predicted_depth=None))

    prediction = depth_backend.predict_depth(_image(), catalog.DEPTH_PRO, _settings())
    assert prediction.focal_px == pytest.approx(812.5)
    assert prediction.kind == "metric"
    assert prediction.values.shape == (16, 24)


def test_predict_depth_falls_back_to_interpolation_on_an_older_processor(fake_stack):
    """`post_process_depth_estimation` landed in transformers 4.48; older ones lack it."""
    raw = np.linspace(0.0, 1.0, 8 * 12, dtype=np.float32).reshape(1, 8, 12)  # model resolution
    fake_stack(
        processor=FakeProcessor(),  # no post_process_depth_estimation attribute at all
        output=types.SimpleNamespace(predicted_depth=FakeTensor(raw)),
    )
    prediction = depth_backend.predict_depth(
        _image(24, 16), catalog.DEPTH_ANYTHING_V2_SMALL, _settings()
    )
    assert prediction.values.shape == (16, 24), "depth must come back at the SOURCE resolution"
    assert prediction.focal_px is None
    assert prediction.kind == "relative"


def test_predict_depth_falls_back_when_post_processing_raises(fake_stack):
    """Signature drift across transformers versions must cost quality, not the whole job."""
    def exploding_post(outputs, target_sizes=None):
        raise TypeError("unexpected keyword argument 'target_sizes'")

    raw = np.ones((1, 8, 12), dtype=np.float32)
    fake_stack(
        processor=FakeProcessor(post=exploding_post),
        output=types.SimpleNamespace(predicted_depth=FakeTensor(raw)),
    )
    prediction = depth_backend.predict_depth(
        _image(24, 16), catalog.DEPTH_ANYTHING_V2_SMALL, _settings()
    )
    assert prediction.values.shape == (16, 24)


def test_predict_depth_wraps_an_inference_failure_with_the_model_id(fake_stack):
    """"CUDA out of memory" with no context is the least actionable error in the stack."""
    fake_stack(model=FakeModel(None, fail=True))
    with pytest.raises(EngineError, match="Depth inference with 'depth-anything-v2-small' failed"):
        depth_backend.predict_depth(_image(), catalog.DEPTH_ANYTHING_V2_SMALL, _settings())


# ── scalar coercion ───────────────────────────────────────────────────────────────────────

@pytest.mark.parametrize(
    "value, expected",
    [
        (None, None),
        (512.0, 512.0),
        (512, 512.0),
        (np.float32(512.0), 512.0),              # numpy scalar: has .item AND .reshape
        (np.array(512.0), 512.0),                # 0-d array
        (np.array([512.0]), 512.0),              # 1-element array
        (np.array([512.0, 999.0]), 512.0),       # takes the first, does not raise
        (FakeTensor([512.0]), 512.0),
        ("not a number", None),
        (object(), None),
    ],
)
def test_as_float_coerces_every_scalar_shape_a_processor_might_return(value, expected):
    """Processors return focal length as a float, a 0-d tensor or a 1-element tensor depending
    on version, and a failure to coerce must degrade to "no focal" rather than raise."""
    assert depth_backend._as_float(value) == expected


# ── raw prediction -> working volume ──────────────────────────────────────────────────────

def test_metric_and_relative_predictions_take_opposite_paths():
    """`kind` decides whether the scene is inverted, and getting it wrong turns it inside out.

    A relative model emits *disparity* — larger means nearer — so the largest value must come
    back as the smallest depth. A metric model emits metres and must be left in order. The two
    assertions are deliberately mirror images of each other: a single shared code path would
    have to fail one of them.
    """
    ramp = np.linspace(0.0, 1.0, 64, dtype=np.float32).reshape(8, 8)
    settings = _settings()

    relative = depth_backend.to_working_depth(
        depth_backend.DepthPrediction(values=ramp, kind="relative"), settings
    )
    assert relative.flat[-1] < relative.flat[0], "max disparity must become min depth"

    metric = depth_backend.to_working_depth(
        depth_backend.DepthPrediction(values=ramp + 1.0, kind="metric"), settings
    )
    assert metric.flat[-1] > metric.flat[0], "max metres must stay max depth"


def test_both_paths_land_inside_the_configured_working_volume():
    """Everything downstream assumes [1, DEPTH_RANGE]; a leak here mis-scales the whole cloud."""
    settings = _settings(depth_range=5.0)
    for kind, values in (
        ("relative", np.linspace(0.0, 100.0, 64, dtype=np.float32).reshape(8, 8)),
        ("metric", np.linspace(0.3, 9_000.0, 64, dtype=np.float32).reshape(8, 8)),
    ):
        out = depth_backend.to_working_depth(
            depth_backend.DepthPrediction(values=values, kind=kind), settings
        )
        assert out.min() >= 1.0 - 1e-5 and out.max() <= 5.0 + 1e-5, kind


def test_a_degenerate_prediction_raises_a_value_error_the_engine_can_translate():
    """`depth_image.run` catches ValueError specifically to name the model in the message."""
    with pytest.raises(ValueError):
        depth_backend.to_working_depth(
            depth_backend.DepthPrediction(
                values=np.full((4, 4), np.nan, dtype=np.float32), kind="relative"
            ),
            _settings(),
        )
