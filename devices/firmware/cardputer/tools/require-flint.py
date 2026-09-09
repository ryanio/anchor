"""Say plainly that the flint submodule is missing, before the build does not.

PlatformIO runs this before anything is compiled. Without it, a checkout that
skipped `git submodule update --init` gets one of two unhelpful answers: an
empty `flint/` makes the config reference `flint/flint.ini`, which is not there,
and a build that reaches the compiler fails on a missing `view.h` thirty lines
into someone else's file. Neither says the word submodule.

A build that fails with a clear message beats one that fails mysteriously.
"""

import os
import sys

Import("env")  # noqa: F821  provided by SCons

PROJECT = env.subst("$PROJECT_DIR")  # noqa: F821
FLINT = os.path.join(PROJECT, "flint")

MESSAGE = """
  The flint submodule is not checked out.

  Anchor's Cardputer app is built against flint (ryanio/cardputer), which is a
  git submodule at devices/firmware/cardputer/flint. It is empty here, so
  {missing} does not exist.

  From anywhere in the Anchor checkout:

      git submodule update --init devices/firmware/cardputer/flint

  See devices/firmware/cardputer/README.md.
"""


def require(path):
    if not os.path.exists(os.path.join(FLINT, path)):
        print(MESSAGE.format(missing=os.path.join("flint", path)), file=sys.stderr)
        env.Exit(1)  # noqa: F821


# flint.ini is what this project's environments extend, and src/view.h is the
# contract the app is written against. Either one missing means the same thing.
require("flint.ini")
require(os.path.join("src", "view.h"))
