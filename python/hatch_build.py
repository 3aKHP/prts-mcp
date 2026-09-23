"""Materialize the repo-root NOTICE inside this project directory at build time.

The IP notices live at the repository root, one level above python/. Hatchling
force-include sources must resolve identically in every build context — a repo
checkout (NOTICE at ../NOTICE), a wheel rebuilt from the sdist, and the Docker
build context (NOTICE already beside pyproject.toml) — so the build declares a
single "NOTICE" source and this hook produces the local copy when it is absent.
"""

import os
import shutil

from hatchling.builders.hooks.plugin.interface import BuildHookInterface


class CustomBuildHook(BuildHookInterface):
    def initialize(self, version, build_data):
        local_notice = os.path.join(self.root, "NOTICE")
        if os.path.exists(local_notice):
            return
        repo_notice = os.path.normpath(os.path.join(self.root, os.pardir, "NOTICE"))
        if os.path.exists(repo_notice):
            shutil.copyfile(repo_notice, local_notice)
