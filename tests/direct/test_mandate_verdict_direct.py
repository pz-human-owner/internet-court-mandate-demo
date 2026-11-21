"""Official GenLayer direct-mode tests against contracts/MandateVerdictDirect.py.

Same in-memory VM as test_mandate_verdict.py (web and LLM mocked). Extra coverage
is the gate constructor argument and the finalized EthSend to postVerdictTrue()
on TRUE only. Nothing is deployed and no wallet is used.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
CONTRACT = str(ROOT / "contracts" / "MandateVerdictDirect.py")
SAMPLE = json.loads((ROOT / "examples/sample_mandate.json").read_text())
DELIVERABLES = json.loads((ROOT / "examples/sample_deliverables.json").read_text())

BOUND = SAMPLE["evidence_url"]
PAGE = DELIVERABLES["source_page_excerpt"]
STUB = DELIVERABLES["stub_page_text"]
GOOD_QUOTE = "The Smart Accounts Kit follows the ERC-7710 standard for smart contract delegation."
CAVEAT_QUOTE = (
    "The delegator creates a delegation, configuring a scope and optional caveats "
    "that define the conditions under which the delegation can be redeemed."
)
EXACT_BOUND_PATTERN = "^" + re.escape(BOUND) + "$"
JUROR_PATTERN = r"impartial Internet Court juror"
ZERO = "0x" + "00" * 20
GATE = "0x" + "11" * 20
# Selector of VerdictGateDirectEnforcer.postVerdictTrue() (no arguments).
POST_SELECTOR = bytes.fromhex("fefceb7f")


def _addr_bytes(value) -> bytes:
    if hasattr(value, "as_bytes"):
        return bytes(value.as_bytes)
    if isinstance(value, (bytes, bytearray)):
        raw = bytes(value)
        return raw[-20:] if len(raw) >= 20 else raw
    if isinstance(value, str):
        hexpart = value[2:] if value.startswith("0x") else value
        return bytes.fromhex(hexpart)
    raise TypeError(f"unsupported address {type(value)!r}")


def _deploy(direct_deploy, vm, principal, agent, gate=GATE, evidence_url=BOUND, allow_subpaths=False):
    vm.sender = principal
    return direct_deploy(
        CONTRACT, agent, SAMPLE["mandate"], SAMPLE["guidelines"], evidence_url, allow_subpaths, gate
    )


def _submit(vm, contract, agent, key="pass", url=BOUND):
    vm.sender = agent
    contract.submit_deliverable(DELIVERABLES[key]["deliverable"], url)


def _mock_page(vm, text=PAGE):
    vm.mock_web(EXACT_BOUND_PATTERN, {"status": 200, "body": text})


def _mock_jury(vm, verdict, reasoning="Reasoned.", quote=GOOD_QUOTE, pattern=JUROR_PATTERN):
    vm.mock_llm(pattern, json.dumps({"verdict": verdict, "reasoning": reasoning, "quote": quote}))


def _verdict(contract):
    return json.loads(contract.get_verdict())


def _case(contract):
    return json.loads(contract.get_case())


def _assert_post_true(vm, gate=GATE):
    assert len(vm.eth_sends) == 1
    send = vm.eth_sends[0]
    assert _addr_bytes(send["address"]) == _addr_bytes(gate)
    data = bytes(send["calldata"])
    assert data == POST_SELECTOR
    assert int(send.get("value") or 0) == 0


def test_constructor_rejects_zero_gate(direct_vm, direct_deploy, direct_alice, direct_bob):
    with direct_vm.expect_revert("Gate address is required"):
        _deploy(direct_deploy, direct_vm, direct_alice, direct_bob, gate=ZERO)


def test_constructor_stores_gate(direct_vm, direct_deploy, direct_alice, direct_bob):
    contract = _deploy(direct_deploy, direct_vm, direct_alice, direct_bob)
    case = _case(contract)
    assert _addr_bytes(case["gate"]) == _addr_bytes(GATE)
    assert case["gate_notified"] is False
    assert _verdict(contract)["gate_notified"] is False


def test_true_emits_post_verdict_true_once(direct_vm, direct_deploy, direct_alice, direct_bob):
    contract = _deploy(direct_deploy, direct_vm, direct_alice, direct_bob)
    _submit(direct_vm, contract, direct_bob)
    _mock_page(direct_vm)
    _mock_jury(direct_vm, "TRUE", "Matches the page.")
    direct_vm.sender = direct_alice
    contract.request_verdict()
    v = _verdict(contract)
    assert (v["status"], v["verdict"], v["quote"], v["gate_notified"], v["attempts"]) == (
        "resolved", "TRUE", GOOD_QUOTE, True, 1,
    )
    assert _case(contract)["gate_notified"] is True
    _assert_post_true(direct_vm)


def test_false_does_not_notify_gate(direct_vm, direct_deploy, direct_alice, direct_bob):
    contract = _deploy(direct_deploy, direct_vm, direct_alice, direct_bob)
    _submit(direct_vm, contract, direct_bob, key="fail")
    _mock_page(direct_vm)
    _mock_jury(direct_vm, "FALSE", "Claims custody of the key; the page says caveats restrict redemption.", CAVEAT_QUOTE)
    direct_vm.sender = direct_bob
    contract.request_verdict()
    v = _verdict(contract)
    assert (v["status"], v["verdict"], v["gate_notified"]) == ("resolved", "FALSE", False)
    assert direct_vm.eth_sends == []


def test_undetermined_does_not_notify_gate(direct_vm, direct_deploy, direct_alice, direct_bob):
    contract = _deploy(direct_deploy, direct_vm, direct_alice, direct_bob)
    _submit(direct_vm, contract, direct_bob, key="undetermined")
    _mock_page(direct_vm, STUB)
    _mock_jury(direct_vm, "UNDETERMINED", "The page no longer covers delegation.", "")
    direct_vm.sender = direct_alice
    contract.request_verdict()
    v = _verdict(contract)
    assert (v["status"], v["verdict"], v["gate_notified"]) == ("resolved", "UNDETERMINED", False)
    assert direct_vm.eth_sends == []


def test_fetch_error_does_not_notify_gate(direct_vm, direct_deploy, direct_alice, direct_bob):
    contract = _deploy(direct_deploy, direct_vm, direct_alice, direct_bob)
    _submit(direct_vm, contract, direct_bob)
    _mock_jury(direct_vm, "TRUE")  # no web mock: fetch fails
    direct_vm.sender = direct_alice
    contract.request_verdict()
    v = _verdict(contract)
    assert v["status"] != "resolved"
    assert v["gate_notified"] is False
    assert direct_vm.eth_sends == []
