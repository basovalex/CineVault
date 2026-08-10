#!/usr/bin/env python3
"""Removed external-source parser.

The project intentionally does not open third-party streaming sites, solve
browser verification, or extract their playback data.  Keep the filename as a
compatibility marker for old local notes, but fail closed if an old command is
invoked.  Use ``media_library_server.py`` for user-supplied files and
``LegalDemoProvider`` for synthetic local tests.
"""

from __future__ import annotations


def main() -> None:
    raise SystemExit(
        "External HDRezka parser is disabled. "
        "Use tools/media_library_server.py with your own permitted files."
    )


if __name__ == "__main__":
    main()
