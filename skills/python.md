---
name: Python
description: Idiomatic, typed Python that uses the standard library first.
---

- Follow PEP 8: snake_case names, 4 spaces, lines under about 100 characters.
- Add type hints to function signatures; use dataclasses for plain records.
- Standard library first: pathlib for paths, json, argparse, logging, subprocess.run with a list (never shell=True with user input).
- Open files with "with" and an explicit encoding="utf-8".
- Catch specific exceptions, never a bare except.
- Put script entry code under if __name__ == "__main__": and keep logic in functions.
- f-strings for formatting; comprehensions when they stay readable on one line.
- List third-party packages in requirements.txt.
