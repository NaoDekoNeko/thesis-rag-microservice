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
"""
import os
import re
import time
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
EMBEDDING_DIM = 768
# ──────────────────────────────────────────────────────────────────────────────


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
        pass  # schema ya activado via microservicio
        cur.execute(f"""
            CREATE TABLE IF NOT EXISTS {TABLE} (
                id          SERIAL PRIMARY KEY,
                doc_folder  TEXT NOT NULL,
                title       TEXT,
                url         TEXT,
                category    TEXT,
                content     TEXT NOT NULL,
                embedding   vector({EMBEDDING_DIM}),
                fts_vector  tsvector GENERATED ALWAYS AS (
                                to_tsvector('spanish', content)
                            ) STORED
            );
        """)
        cur.execute(f"""
            CREATE INDEX IF NOT EXISTS {TABLE}_embedding_idx
                ON {TABLE} USING hnsw (embedding vector_cosine_ops);
        """)
        cur.execute(f"""
            CREATE INDEX IF NOT EXISTS {TABLE}_fts_idx
                ON {TABLE} USING gin (fts_vector);
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
    docs = []
    for md_file in sorted(docs_path.rglob("*.md")) + sorted(docs_path.rglob("*.mdx")):
        text = md_file.read_text(encoding="utf-8")
        meta = extract_frontmatter(text)
        clean = strip_markdown(text)
        rel = md_file.relative_to(docs_path.parent)
        url = "/" + str(rel).replace("\\", "/").removesuffix(".md").removesuffix(".mdx")
        for chunk in chunk_text(clean):
            docs.append({
                "doc_folder": DOC_FOLDER,
                "title": meta.get("title") or md_file.stem,
                "url": url,
                "category": meta.get("category", ""),
                "content": chunk,
            })
    return docs


def embed_batch(client: genai.Client, texts: list[str]) -> list[list[float]]:
    for attempt in range(3):
        try:
            res = client.models.embed_content(
                model=EMBEDDING_MODEL,
                contents=texts,
                config=types.EmbedContentConfig(output_dimensionality=EMBEDDING_DIM),
            )
            return [e.values for e in res.embeddings]
        except Exception as e:
            if attempt == 2:
                raise
            print(f"  Embed attempt {attempt + 1} failed: {e}. Retrying...")
            time.sleep(2 ** attempt)


def index_docs(conn, docs: list[dict], client: genai.Client):
    total = len(docs)
    inserted = 0
    for i in range(0, total, BATCH_SIZE):
        batch = docs[i: i + BATCH_SIZE]
        texts = [d["content"] for d in batch]
        embeddings = embed_batch(client, texts)

        with conn.cursor() as cur:
            for doc, emb in zip(batch, embeddings):
                cur.execute(
                    f"""
                    INSERT INTO {TABLE} (doc_folder, title, url, category, content, embedding)
                    VALUES (%s, %s, %s, %s, %s, %s::vector)
                    """,
                    (
                        doc["doc_folder"],
                        doc["title"],
                        doc["url"],
                        doc["category"],
                        doc["content"],
                        f"[{','.join(str(v) for v in emb)}]",
                    ),
                )
        conn.commit()
        inserted += len(batch)
        print(f"  [{inserted}/{total}] chunks indexados")
        time.sleep(0.5)  # rate-limit conservador


def main():
    docs_path = Path(os.environ.get("DOCS_PATH", "")).resolve()
    if not docs_path.exists():
        raise SystemExit(f"Ruta no existe: {docs_path}")

    clear = os.environ.get("CLEAR", "false").lower() == "true"

    print(f"Conectando a {DB_HOST}:{DB_PORT}/{DB_NAME}...")
    activate_schema()
    conn = psycopg2.connect(
        host=DB_HOST, port=DB_PORT, dbname=DB_NAME,
        user=DB_USER, password=DB_PASSWORD,
    )
    setup_db(conn)

    if clear:
        with conn.cursor() as cur:
            cur.execute(f"DELETE FROM {TABLE} WHERE doc_folder = %s", (DOC_FOLDER,))
        conn.commit()
        print(f"Registros de '{DOC_FOLDER}' eliminados.")

    print(f"Recolectando documentos de {docs_path}...")
    docs = collect_docs(docs_path)
    print(f"  {len(docs)} chunks a indexar")

    client = genai.Client(api_key=GEMINI_API_KEY)
    index_docs(conn, docs, client)
    conn.close()
    print("Indexación completada.")


if __name__ == "__main__":
    main()
