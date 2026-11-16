from __future__ import annotations

from freeocs.sdk import ModuleContext

from .module import WisdomTreeModule


def setup(api: ModuleContext) -> None:
    api.register_module(WisdomTreeModule(api))
