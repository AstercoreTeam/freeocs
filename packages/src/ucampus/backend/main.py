from __future__ import annotations

from freeocs.sdk import ModuleContext

from .module import UcampusModule


def setup(api: ModuleContext) -> None:
    api.register_module(UcampusModule(api))
