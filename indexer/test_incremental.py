#!/usr/bin/env python3
"""Self-test de la logica de diff para indexacion incremental (sin DB ni red)."""
import os

for var in ("GEMINI_API_KEY", "DB_HOST", "DB_NAME", "DB_USER", "DB_PASSWORD"):
    os.environ.setdefault(var, "test")

from document_processor import compute_content_hash, plan_sync  # noqa: E402


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


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for t in tests:
        t()
        print(f"ok  {t.__name__}")
    print(f"{len(tests)} tests pasaron")
