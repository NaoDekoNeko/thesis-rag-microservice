#!/usr/bin/env python3
"""Self-test de la logica de diff para indexacion incremental (sin DB ni red)."""
import io
import os
import tempfile
from contextlib import redirect_stdout

for var in ("GEMINI_API_KEY", "DB_HOST", "DB_NAME", "DB_USER", "DB_PASSWORD"):
    os.environ.setdefault(var, "test")

import document_processor as dp  # noqa: E402
from document_processor import compute_content_hash, describe_plan, plan_sync  # noqa: E402


def test_unchanged_chunk_skipped():
    plan = plan_sync({0: compute_content_hash("hola mundo")}, ["hola mundo"])
    assert plan.to_upsert == []
    assert plan.to_delete == []


def test_modified_chunk_flagged():
    plan = plan_sync({0: compute_content_hash("version vieja")}, ["version nueva"])
    assert plan.to_upsert == [0]
    assert plan.to_delete == []


def test_new_chunk_appended():
    plan = plan_sync({0: compute_content_hash("primero")}, ["primero", "segundo"])
    assert plan.to_upsert == [1]
    assert plan.to_delete == []


def test_trailing_chunk_removed():
    existing = {0: compute_content_hash("a"), 1: compute_content_hash("b")}
    plan = plan_sync(existing, ["a"])
    assert plan.to_upsert == []
    assert plan.to_delete == [1]


def test_empty_existing_all_new():
    plan = plan_sync({}, ["x", "y"])
    assert plan.to_upsert == [0, 1]
    assert plan.to_delete == []


def test_hash_is_deterministic_and_content_sensitive():
    assert compute_content_hash("abc") == compute_content_hash("abc")
    assert compute_content_hash("abc") != compute_content_hash("abd")


def test_describe_plan_prints_hashes_for_each_case():
    existing = {0: compute_content_hash("a"), 1: compute_content_hash("vieja")}
    new_chunks = ["a", "nueva", "extra"]
    plan = plan_sync(existing, new_chunks)
    buf = io.StringIO()
    with redirect_stdout(buf):
        describe_plan("archivo.md", existing, new_chunks, plan)
    out = buf.getvalue()
    assert "sin cambios" in out
    assert "MODIFICADO" in out
    assert "NUEVO" in out
    assert compute_content_hash("vieja") in out
    assert compute_content_hash("nueva") in out


def test_append_markdown_report_only_lists_affected_chunks():
    existing = {0: compute_content_hash("a"), 1: compute_content_hash("vieja")}
    new_chunks = ["a", "nueva", "extra"]
    plan = plan_sync(existing, new_chunks)
    with tempfile.NamedTemporaryFile(mode="r", suffix=".md", delete=False) as tmp:
        path = tmp.name
    original = dp.SYNC_REPORT_FILE
    dp.SYNC_REPORT_FILE = path
    try:
        dp.append_markdown_report("archivo.md", existing, new_chunks, plan)
    finally:
        dp.SYNC_REPORT_FILE = original
    content = open(path, encoding="utf-8").read()
    os.remove(path)
    rows = [line for line in content.splitlines() if line.startswith("| `archivo.md`")]
    assert len(rows) == 2  # solo los 2 chunks afectados (indices 1 y 2), no el 0 (sin cambios)
    assert any("modificado" in r for r in rows)
    assert any("nuevo" in r for r in rows)
    assert compute_content_hash("nueva")[:12] in content


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for t in tests:
        t()
        print(f"ok  {t.__name__}")
    print(f"{len(tests)} tests pasaron")
