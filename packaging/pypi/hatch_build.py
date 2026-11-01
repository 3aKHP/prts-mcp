"""Mark the wheel as platform-specific without rebuilding native code."""
import os
from hatchling.builders.hooks.plugin.interface import BuildHookInterface


class NativeWheelHook(BuildHookInterface):
    def initialize(self, version, build_data):
        if self.target_name != "wheel":
            raise ValueError("Only precompiled wheels are supported")
        build_data["pure_python"] = False
        build_data["tag"] = "py3-none-" + os.environ["PRTS_PYPI_PLATFORM_TAG"]
