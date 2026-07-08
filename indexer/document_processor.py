#!/usr/bin/env python3
"""
Indexa documentos Docusaurus en PostgreSQL+pgvector.
Uso: python document_processor.py --docs-path /path/to/docsite/docs

Variables de entorno requeridas:
  GEMINI_API_KEY, DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD
Variables opcionales:
  CHUNK_SIZE (default 500), CHUNK_OVERLAP_PCT (default 0.25),
  GEMINI_EMBEDDING_MODEL (default gemini-embedding-001),
  VECTOR_TABLE_NAME (default doc_embeddings_rag),
  DOC_FOLDER (default "unknown"), BATCH_SIZE (default 20)

Indexacion incremental: la identidad estable de una unidad reprocesable es
(doc_folder, source_file, chunk_index). Cada chunk se compara por hash MD5
de su contenido contra el valor persistido; solo los chunks nuevos o
modificados se reembeben, los chunks sobrantes (archivo mas corto) se
borran, y los archivos que desaparecen del corpus se borran por completo.
"""
import hashlib
import os
import re
import time
from dataclasses import dataclass
from pathlib import Path

import psycopg2
from google import genai
from google.genai import types

# ── Config ────────────────────────────────────────────────────────────────────
GEMINI_API_KEY = os.environ["GEMINI_API_KEY"]
DB_HOST = os.environ["DB_HOST"]
DB_PORT = int(os.environ.get("DB_PORT", 5432))
DB_NAME = os.environ["DB_NAME"]
DB_USER = os.environ["DB_USER"]
DB_PASSWORD = os.environ["DB_PASSWORD"]
MICROSERVICE_URL = os.environ.get("MICROSERVICE_URL", "")

CHUNK_SIZE = int(os.environ.get("CHUNK_SIZE", 500))
CHUNK_OVERLAP = int(CHUNK_SIZE * float(os.environ.get("CHUNK_OVERLAP_PCT", 0.25)))
EMBEDDING_MODEL = os.environ.get("GEMINI_EMBEDDING_MODEL", "gemini-embedding-001")
TABLE = os.environ.get("VECTOR_TABLE_NAME", "doc_embeddings_rag")
DOC_FOLDER = os.environ.get("DOC_FOLDER", "unknown")
BATCH_SIZE = int(os.environ.get("BATCH_SIZE", 20))
SYNC_REPORT_FILE = os.environ.get("SYNC_REPORT_FILE", "")
EMBEDDING_DIM = 768
# ──────────────────────────────────────────────────────────────────────────────


@dataclass
class SyncPlan:
    to_upsert: list[int]
    to_delete: list[int]


def compute_content_hash(text: str) -> str:
    return hashlib.md5(text.encode("utf-8")).hexdigest()


def plan_sync(existing: dict[int, str], new_chunks: list[str]) -> SyncPlan:
    """Diff puro entre el estado persistido y el contenido actual de un archivo.

    existing: {chunk_index: content_hash} tal como esta en el indice.
    new_chunks: contenido actual de cada chunk, en orden.
    """
    to_upsert = [
        i for i, chunk in enumerate(new_chunks)
        if existing.get(i) != compute_content_hash(chunk)
    ]
    to_delete = [i for i in existing if i >= len(new_chunks)]
    return SyncPlan(to_upsert=to_upsert, to_delete=to_delete)


def activate_schema():
    if not MICROSERVICE_URL:
        print("MICROSERVICE_URL no configurado — omitiendo setup-db")
        return
    import urllib.request
    url = f"{MICROSERVICE_URL.rstrip('/')}/admin/setup-db"
    req = urllib.request.Request(url, data=b'', method='POST')
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            print(f"Schema activado: {resp.read().decode()}")
    except Exception as e:
        print(f"Advertencia: setup-db endpoint falló: {e}")


def setup_db(conn):
    with conn.cursor() as cur:
        cur.execute(f"""
            CREATE TABLE IF NOT EXISTS {TABLE} (
                id          SERIAL PRIMARY KEY,
                doc_folder  TEXT NOT NULL,
                title       TEXT,
                url         TEXT,
                category    TEXT,
                content     TEXT NOT NULL,
                source_file TEXT,
                chunk_index INTEGER,
                content_hash TEXT,
                embedding   vector({EMBEDDING_DIM}),
                fts_vector  tsvector GENERATED ALWAYS AS (
                                to_tsvector('spanish', content)
                            ) STORED
            );
        """)
        cur.execute(f"""
            ALTER TABLE {TABLE}
                ADD COLUMN IF NOT EXISTS source_file TEXT,
                ADD COLUMN IF NOT EXISTS chunk_index INTEGER,
                ADD COLUMN IF NOT EXISTS content_hash TEXT;
        """)
        cur.execute(f"""
            CREATE INDEX IF NOT EXISTS {TABLE}_embedding_idx
                ON {TABLE} USING hnsw (embedding vector_cosine_ops);
        """)
        cur.execute(f"""
            CREATE INDEX IF NOT EXISTS {TABLE}_fts_idx
                ON {TABLE} USING gin (fts_vector);
        """)
        cur.execute(f"""
            CREATE UNIQUE INDEX IF NOT EXISTS {TABLE}_chunk_identity_idx
                ON {TABLE} (doc_folder, source_file, chunk_index);
        """)
    conn.commit()


def extract_frontmatter(text: str) -> dict:
    meta = {"title": "", "category": ""}
    match = re.match(r"^---\n(.*?)\n---", text, re.DOTALL)
    if not match:
        return meta
    for line in match.group(1).splitlines():
        if ":" in line:
            k, _, v = line.partition(":")
            meta[k.strip()] = v.strip().strip('"')
    return meta


def strip_markdown(text: str) -> str:
    text = re.sub(r"^---.*?^---\s*", "", text, flags=re.MULTILINE | re.DOTALL)
    text = re.sub(r"```.*?```", "", text, flags=re.DOTALL)
    text = re.sub(r"`[^`]+`", "", text)
    text = re.sub(r"!\[.*?\]\(.*?\)", "", text)
    text = re.sub(r"\[([^\]]+)\]\([^\)]+\)", r"\1", text)
    text = re.sub(r"#{1,6}\s+", "", text)
    text = re.sub(r"[*_]{1,2}([^*_]+)[*_]{1,2}", r"\1", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def chunk_text(text: str) -> list[str]:
    chunks, start = [], 0
    while start < len(text):
        end = min(start + CHUNK_SIZE, len(text))
        chunks.append(text[start:end].strip())
        start += CHUNK_SIZE - CHUNK_OVERLAP
    return [c for c in chunks if len(c) > 50]


def collect_docs(docs_path: Path) -> list[dict]:
    """Agrupa por archivo (no por chunk) para poder diffear con lo indexado."""
    files = []
    for md_file in sorted(docs_path.rglob("*.md")) + sorted(docs_path.rglob("*.mdx")):
        text = md_file.read_text(encoding="utf-8")
        meta = extract_frontmatter(text)
        clean = strip_markdown(text)
        rel = md_file.relative_to(docs_path.parent)
        url = "/" + str(rel).replace("\\", "/").removesuffix(".md").removesuffix(".mdx")
        files.append({
            "source_file": str(rel),
            "doc_folder": DOC_FOLDER,
            "title": meta.get("title") or md_file.stem,
            "url": url,
            "category": meta.get("category", ""),
            "chunks": chunk_text(clean),
        })
    return files


def embed_batch(client: genai.Client, texts: list[str]) -> list[list[float]]:
    for attempt in range(3):
        try:
            res = client.models.embed_content(
                model=EMBEDDING_MODEL,
                contents=texts,
                config=types.EmbedContentConfig(output_dimensionality=EMBEDDING_DIM),
            )
            embeddings = [e.values for e in res.embeddings]
            for emb in embeddings:
                if len(emb) != EMBEDDING_DIM:
                    raise ValueError(
                        f"Embedding dimension mismatch: expected {EMBEDDING_DIM}, got {len(emb)}"
                    )
            return embeddings
        except Exception as e:
            if attempt == 2:
                raise
            print(f"  Embed attempt {attempt + 1} failed: {e}. Retrying...")
            time.sleep(2 ** attempt)


def get_existing_chunks(conn, doc_folder: str, source_file: str) -> dict[int, str]:
    with conn.cursor() as cur:
        cur.execute(
            f"SELECT chunk_index, content_hash FROM {TABLE} "
            "WHERE doc_folder = %s AND source_file = %s",
            (doc_folder, source_file),
        )
        return {row[0]: row[1] for row in cur.fetchall()}


def get_indexed_source_files(conn, doc_folder: str) -> set[str]:
    with conn.cursor() as cur:
        cur.execute(
            f"SELECT DISTINCT source_file FROM {TABLE} "
            "WHERE doc_folder = %s AND source_file IS NOT NULL",
            (doc_folder,),
        )
        return {row[0] for row in cur.fetchall()}


def delete_source_file(conn, doc_folder: str, source_file: str):
    with conn.cursor() as cur:
        cur.execute(
            f"DELETE FROM {TABLE} WHERE doc_folder = %s AND source_file = %s",
            (doc_folder, source_file),
        )
    conn.commit()


def delete_chunks(conn, doc_folder: str, source_file: str, indices: list[int]):
    if not indices:
        return
    with conn.cursor() as cur:
        cur.execute(
            f"DELETE FROM {TABLE} WHERE doc_folder = %s AND source_file = %s "
            "AND chunk_index = ANY(%s)",
            (doc_folder, source_file, indices),
        )
    conn.commit()


def describe_plan(source_file: str, existing: dict[int, str], new_chunks: list[str], plan: SyncPlan):
    """Traza legible del diff: hash anterior vs. actual por chunk (evidencia de auditoria)."""
    for i, chunk in enumerate(new_chunks):
        old_hash = existing.get(i)
        new_hash = compute_content_hash(chunk)
        if i not in plan.to_upsert:
            estado = "sin cambios"
        elif old_hash is None:
            estado = "NUEVO"
        else:
            estado = "MODIFICADO"
        print(f"    [{source_file}#{i}] {estado:<11} hash_anterior={old_hash} hash_actual={new_hash}")
    for i in plan.to_delete:
        print(f"    [{source_file}#{i}] ELIMINADO   hash_anterior={existing.get(i)}")


def append_markdown_report(source_file: str, existing: dict[int, str], new_chunks: list[str], plan: SyncPlan):
    """Anexa a SYNC_REPORT_FILE solo los chunks afectados (evidencia compacta para PR)."""
    if not SYNC_REPORT_FILE:
        return
    rows = []
    for i in plan.to_upsert:
        old_hash = existing.get(i)
        new_hash = compute_content_hash(new_chunks[i])
        estado = "🆕 nuevo" if old_hash is None else "✏️ modificado"
        rows.append(f"| `{source_file}` | {i} | {estado} | `{(old_hash or '—')[:12]}` | `{new_hash[:12]}` |")
    for i in plan.to_delete:
        rows.append(f"| `{source_file}` | {i} | 🗑️ eliminado | `{(existing.get(i) or '—')[:12]}` | — |")
    if rows:
        with open(SYNC_REPORT_FILE, "a", encoding="utf-8") as f:
            f.write("\n".join(rows) + "\n")


def sync_docs(conn, files: list[dict], client: genai.Client, doc_folder: str, force_clear: bool):
    if force_clear:
        with conn.cursor() as cur:
            cur.execute(f"DELETE FROM {TABLE} WHERE doc_folder = %s", (doc_folder,))
        conn.commit()

    current_files = {f["source_file"] for f in files}
    for stale in sorted(get_indexed_source_files(conn, doc_folder) - current_files):
        existing = get_existing_chunks(conn, doc_folder, stale)
        plan = plan_sync(existing, [])
        describe_plan(stale, existing, [], plan)
        append_markdown_report(stale, existing, [], plan)
        delete_source_file(conn, doc_folder, stale)
        print(f"  Eliminado del indice (archivo ya no existe): {stale}")

    pending: list[tuple[dict, int, str]] = []
    total_chunks = 0
    for f in files:
        existing = {} if force_clear else get_existing_chunks(conn, doc_folder, f["source_file"])
        plan = plan_sync(existing, f["chunks"])
        describe_plan(f["source_file"], existing, f["chunks"], plan)
        append_markdown_report(f["source_file"], existing, f["chunks"], plan)
        delete_chunks(conn, doc_folder, f["source_file"], plan.to_delete)
        total_chunks += len(f["chunks"])
        for i in plan.to_upsert:
            pending.append((f, i, f["chunks"][i]))

    print(f"  {total_chunks} chunks totales, {len(pending)} a reprocesar")

    for i in range(0, len(pending), BATCH_SIZE):
        batch = pending[i:i + BATCH_SIZE]
        embeddings = embed_batch(client, [c[2] for c in batch])
        with conn.cursor() as cur:
            for (f, chunk_index, content), emb in zip(batch, embeddings):
                cur.execute(
                    f"""
                    INSERT INTO {TABLE}
                        (doc_folder, source_file, chunk_index, title, url, category, content, content_hash, embedding)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s::vector)
                    ON CONFLICT (doc_folder, source_file, chunk_index) DO UPDATE SET
                        title = EXCLUDED.title,
                        url = EXCLUDED.url,
                        category = EXCLUDED.category,
                        content = EXCLUDED.content,
                        content_hash = EXCLUDED.content_hash,
                        embedding = EXCLUDED.embedding
                    """,
                    (
                        doc_folder,
                        f["source_file"],
                        chunk_index,
                        f["title"],
                        f["url"],
                        f["category"],
                        content,
                        compute_content_hash(content),
                        f"[{','.join(str(v) for v in emb)}]",
                    ),
                )
        conn.commit()
        print(f"  [{min(i + BATCH_SIZE, len(pending))}/{len(pending)}] chunks reprocesados")
        time.sleep(0.5)  # rate-limit conservador


def main():
    docs_path = Path(os.environ.get("DOCS_PATH", "")).resolve()
    if not docs_path.exists():
        raise SystemExit(f"Ruta no existe: {docs_path}")

    force_clear = os.environ.get("CLEAR", "false").lower() == "true"

    if SYNC_REPORT_FILE:
        with open(SYNC_REPORT_FILE, "w", encoding="utf-8") as f:
            f.write("| Archivo | Chunk | Estado | Hash anterior | Hash actual |\n|---|---|---|---|---|\n")

    print(f"Conectando a {DB_HOST}:{DB_PORT}/{DB_NAME}...")
    activate_schema()
    conn = psycopg2.connect(
        host=DB_HOST, port=DB_PORT, dbname=DB_NAME,
        user=DB_USER, password=DB_PASSWORD,
    )
    setup_db(conn)

    print(f"Recolectando documentos de {docs_path}...")
    files = collect_docs(docs_path)
    total = sum(len(f["chunks"]) for f in files)
    print(f"  {len(files)} archivos, {total} chunks totales")

    client = genai.Client(api_key=GEMINI_API_KEY)
    sync_docs(conn, files, client, DOC_FOLDER, force_clear=force_clear)
    conn.close()
    print("Indexación completada.")


if __name__ == "__main__":
    main()
