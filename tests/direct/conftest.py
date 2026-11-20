"""Skip the direct-mode suite cleanly when genlayer-test is not installed.

Also patch three gaps in genlayer-test 0.29.2 against the contract's pinned
py-genlayer runner (babwp9t37… / GenVM v0.2.16):

1. Storage codegen lives at genlayer.storage._internal, not
   genlayer.py.storage._internal, so the stock allocator never sets
   __type_desc__.
2. Message context lives on the genlayer.message module, not genlayer.gl,
   so vm.sender changes were ignored.
3. run_nondet / run_validator look up genlayer.gl.vm, which this runner
   does not have. We patch genlayer.vm and wrap results as genlayer.vm.Return.

EVM external messages (EthSend / EthCall) are also unhandled gl_call types.
The hook records them so MandateVerdictDirect tests can assert the gate call.
"""

from __future__ import annotations

import sys

import pytest

pytest.importorskip("gltest.direct", reason="genlayer-test is not installed")

from gltest.direct import loader
from gltest.direct.vm import VMContext, _sentinel

_orig_allocate = loader._allocate_contract
_orig_refresh = VMContext._refresh_gl_message


def _allocate_contract(contract_cls, vm, *args, **kwargs):
    try:
        from genlayer.storage import ROOT_SLOT_ID
        from genlayer.storage._internal.generate import (
            ORIGINAL_INIT_ATTR,
            _BuilderCtx,
            _storage_build,
        )
    except ImportError:
        instance = _orig_allocate(contract_cls, vm, *args, **kwargs)
        _patch_run_nondet_sdk()
        return instance

    td = _storage_build(_BuilderCtx.empty(), contract_cls)
    instance = td.get(vm._storage.get_store_slot(ROOT_SLOT_ID), 0)
    init = getattr(td, "cls", None)
    if init is None:
        init = getattr(contract_cls, "__init__", None)
    else:
        init = getattr(init, "__init__", None)
    if init is not None:
        if hasattr(init, ORIGINAL_INIT_ATTR):
            init = getattr(init, ORIGINAL_INIT_ATTR)
        init(instance, *args, **kwargs)
    _patch_run_nondet_sdk()
    return instance


loader._allocate_contract = _allocate_contract


def _refresh_gl_message(self):
    """Update genlayer.message for this SDK (module-level fields, not genlayer.gl)."""
    _orig_refresh(self)
    msg = sys.modules.get("genlayer.message")
    if msg is None:
        return
    try:
        from genlayer.types import Address, u256
    except ImportError:
        return

    def as_addr(value):
        if value is None or isinstance(value, Address):
            return value
        if isinstance(value, bytes):
            return Address(value)
        if hasattr(value, "as_bytes"):
            return Address(value.as_bytes)
        return value

    sender = as_addr(self.sender)
    origin = as_addr(self.origin)
    if getattr(msg, "raw", None) is not None:
        msg.raw["sender_address"] = sender
        msg.raw["origin_address"] = origin
        msg.raw["value"] = u256(self._value)
    msg.sender_address = sender
    msg.origin_address = origin
    if hasattr(msg, "value"):
        msg.value = u256(self._value)


VMContext._refresh_gl_message = _refresh_gl_message


def _patch_run_nondet_sdk() -> None:
    """Capture validators from this SDK's genlayer.vm.run_nondet."""
    try:
        import genlayer.vm as gl_vm
    except ImportError:
        return
    if getattr(gl_vm, "_mandate_demo_direct_patched", False):
        return
    from gltest.direct import wasi_mock

    def _direct_run_nondet(leader_fn, validator_fn, /, **kwargs):
        vm = wasi_mock.get_vm()
        vm._in_nondet = True
        try:
            result = leader_fn()
        finally:
            vm._in_nondet = False
        vm._captured_validators.append((result, leader_fn, validator_fn))
        return result

    gl_vm.run_nondet = _direct_run_nondet
    gl_vm._mandate_demo_direct_patched = True


def _run_validator(self, *, leader_result=_sentinel, leader_error=None, index=-1):
    if not self._captured_validators:
        raise RuntimeError(
            "No validator captured. Call a contract method that uses "
            "gl.vm.run_nondet before calling run_validator()."
        )
    stored_result, _leader_fn, validator_fn = self._captured_validators[index]
    import genlayer.vm as gl_vm

    if leader_error is not None:
        wrapped = gl_vm.UserError(str(leader_error))
    elif leader_result is not _sentinel:
        wrapped = gl_vm.Return(calldata=leader_result)
    else:
        wrapped = gl_vm.Return(calldata=stored_result)
    return validator_fn(wrapped)


VMContext.run_validator = _run_validator


@pytest.fixture(autouse=True)
def _capture_eth_messages(direct_vm):
    sends: list = []
    calls: list = []

    def hook(_vm, request):
        if not isinstance(request, dict):
            return None
        if "EthSend" in request:
            sends.append(request["EthSend"])
            return {"ok": None}
        if "EthCall" in request:
            calls.append(request["EthCall"])
            return {"ok": b""}
        return None

    direct_vm._gl_call_hook = hook
    direct_vm.eth_sends = sends
    direct_vm.eth_calls = calls
    return sends
