# Copyright 2026 AstercoreTeam
# Copyright 2026 qincnd <qincnd@qq.com>
# Copyright 2026 XueZicheng <xuezicheng842@outlook.com>
# SPDX-License-Identifier: AGPL-3.0-only

from __future__ import annotations

from freeocs.sdk import Module, ModuleContext, ModuleRunner


class DemoModule(Module):
    id = "demo_module"
    name = "演示模块"

    def __init__(self, ctx: ModuleContext) -> None:
        super().__init__(ctx)
        self.runner = ModuleRunner(self)

    def start(self) -> None:
        if self.runner.running:
            return
        self.runner.start(self._loop, initial_message="演示运行中")

    def _loop(self, stop_event) -> None:
        self.runner.set_message("演示运行中")
        self.runner.set_progress(1, 2, "步骤 1")
        self.runner.wait(0.1)
        self.runner.set_progress(2, 2, "完成")
        self.runner.set_message("演示结束")
        self.runner.wait(0.1)
        self.runner.set_progress(2, 2, "完成")

    def stop(self) -> None:
        self.runner.stop("正在停止…")
        self.runner.join(2)

    def status(self) -> dict:
        return self.runner.status()

    def actions(self) -> list[dict]:
        return [{"id": "ping", "label": "测试", "style": "default"}]

    def invoke(self, action: str, payload: dict | None = None) -> dict:
        if action == "ping":
            return {"ok": True, "message": "pong"}
        return {"ok": False, "message": f"unknown action: {action}"}


def setup(api: ModuleContext) -> None:
    api.register_module(DemoModule(api))
