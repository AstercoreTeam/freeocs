# Copyright 2026 AstercoreTeam
# Copyright 2026 qincnd <qincnd@qq.com>
# Copyright 2026 XueZicheng <xuezicheng842@outlook.com>
# SPDX-License-Identifier: AGPL-3.0-only

from __future__ import annotations

from freeocs.sdk import ModuleContext

from .module import UcampusModule


def setup(api: ModuleContext) -> None:
    api.register_module(UcampusModule(api))
