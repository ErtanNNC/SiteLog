from __future__ import annotations

import json
from collections.abc import AsyncIterator, Iterator
from pathlib import Path
from typing import Any

import pytest

from sitelog_voice.field_api import FieldApi
from tests.fakes.field_api import BASE_URL, SECRET, FakeFieldApi

AGENT_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = AGENT_DIR.parents[1]
CALL_FIXTURES = REPO_ROOT / "fixtures" / "calls"
SPEC = REPO_ROOT / "docs" / "SITELOG_SPEC.md"


def load_call_fixture(name: str) -> dict[str, Any]:
    return json.loads((CALL_FIXTURES / f"{name}.json").read_text(encoding="utf-8"))


@pytest.fixture
def smoke_fixture() -> dict[str, Any]:
    return load_call_fixture("smoke-get-context")


@pytest.fixture
def fake_api(smoke_fixture: dict[str, Any]) -> Iterator[FakeFieldApi]:
    with FakeFieldApi(smoke_fixture) as fake:
        yield fake


@pytest.fixture
async def api(fake_api: FakeFieldApi) -> AsyncIterator[FieldApi]:
    client = FieldApi(base_url=BASE_URL, tool_secret=SECRET, timeout_s=2, retry_delay_s=0)
    yield client
    await client.aclose()
