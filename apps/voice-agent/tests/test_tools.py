from __future__ import annotations

import socket

import pytest
from pytest_socket import SocketBlockedError

from sitelog_voice.contract import default_contract
from sitelog_voice.tools import TOOL_NAMES


def test_every_tool_has_a_contract_route() -> None:
    routes = default_contract().routes
    assert set(TOOL_NAMES) <= set(routes)
    # calls/start and the recording upload are code's, never the model's.
    assert set(routes) - set(TOOL_NAMES) == {"calls_start", "recording_upload"}


@pytest.mark.filterwarnings("ignore:A test tried to use socket")
def test_the_network_is_blocked() -> None:
    """pytest-socket (pyproject addopts): a test that reaches for the network fails."""
    with pytest.raises(SocketBlockedError):
        socket.socket(socket.AF_INET, socket.SOCK_STREAM)
