"""Skip the direct-mode suite cleanly when genlayer-test is not installed."""

import pytest

pytest.importorskip("gltest.direct", reason="genlayer-test is not installed")
