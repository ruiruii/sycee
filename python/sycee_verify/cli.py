"""Command-line entry point: ``python3 -m sycee_verify [files...]``.

With no arguments it verifies every vector in ``conformance/vectors`` next to
this repository, using ``manifest.json`` as the expected outcome. Explicit
file or directory arguments are accepted; directories are expanded to
``*.json`` (``manifest.json`` excluded).
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .verify import verify_envelope

_REPO_ROOT = Path(__file__).resolve().parents[2]
_VECTOR_DIR = _REPO_ROOT / "conformance" / "vectors"


def _default_paths() -> list[Path]:
    directory = _VECTOR_DIR
    if not directory.is_dir():
        directory = Path.cwd() / "conformance" / "vectors"
    return _expand(directory)


def _expand(path: Path) -> list[Path]:
    if path.is_dir():
        return sorted(p for p in path.glob("*.json") if p.name != "manifest.json")
    return [path]


def _load_expectations(paths: list[Path]) -> dict[str, dict]:
    candidates = [_VECTOR_DIR / "manifest.json"]
    candidates += [p.resolve().parent / "manifest.json" for p in paths]
    for candidate in candidates:
        try:
            data = json.loads(candidate.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        return {Path(case["file"]).name: case for case in data.get("cases", [])}
    return {}


def _display(path: Path) -> str:
    try:
        return str(path.resolve().relative_to(Path.cwd()))
    except ValueError:
        return str(path)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python3 -m sycee_verify",
        description="Verify SYCEE VSR envelopes offline (SPEC.md §7.3).",
    )
    parser.add_argument(
        "paths",
        nargs="*",
        help="VSR envelope files or directories (default: conformance/vectors)",
    )
    args = parser.parse_args(argv)

    paths: list[Path] = []
    for raw in args.paths or [None]:
        if raw is None:
            paths.extend(_default_paths())
        else:
            # `conformance/vectors/*.json` includes manifest.json; it is
            # metadata, not an envelope, so drop it silently.
            paths.extend(p for p in _expand(Path(raw)) if p.name != "manifest.json")
    if not paths:
        print("FAIL  no input files", file=sys.stderr)
        return 1

    expectations = _load_expectations(paths)
    passed = 0

    for path in paths:
        name = path.name
        try:
            envelope = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            print(f"FAIL  {_display(path)}  level=invalid")
            print(f"      load: {exc}")
            continue

        report = verify_envelope(envelope)
        expected = expectations.get(name)
        if expected is None:
            ok = report.accepted
        else:
            ok = (
                report.level == expected.get("level")
                and report.schema_valid == expected.get("schemaValid")
                and report.signature_valid == expected.get("signatureValid")
            )
        passed += int(ok)
        status = "PASS" if ok else "FAIL"
        print(f"{status}  {_display(path)}  level={report.level}")
        if not ok and expected is not None:
            print(
                "      expected "
                f"level={expected.get('level')} "
                f"schema={str(expected.get('schemaValid')).lower()} "
                f"signature={str(expected.get('signatureValid')).lower()}"
            )
        if not ok or expected is None:
            for issue in report.schema_errors:
                print(f"      schema:   [{issue.code}] {issue}")
            for issue in report.errors:
                print(f"      semantic: [{issue.code}] {issue}")

    total = len(paths)
    print(f"{passed}/{total} case(s) passed")
    return 0 if passed == total else 1


if __name__ == "__main__":
    raise SystemExit(main())
