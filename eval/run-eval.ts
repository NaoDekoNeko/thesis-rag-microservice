/**
 * Job de evaluación IR: corre el conjunto anotado (ground-truth.json) contra
 * el endpoint GET /search del microservicio desplegado, en sus tres modos
 * (lexical, vector, hybrid), y calcula Recall@5, Recall@10, Precision@5,
 * MRR y nDCG@10. Sin costo de LLM (no llama /chat/ask).
 *
 * Uso: MICROSERVICE_URL=https://... ts-node eval/run-eval.ts
 */
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

interface GroundTruthDoc {
  doc_folder: string;
  url: string;
  relevance_grade: 0 | 1 | 2;
}
interface Query {
  query_id: string;
  query_text: string;
  query_type: string;
  relevant_documents: GroundTruthDoc[];
}
interface SearchHit {
  doc_folder: string;
  url: string;
  score: number;
}

// EVAL_MODES permite añadir modos (p. ej. hybrid_full en la implementación
// local de la Etapa 1) sin tocar el uso por defecto contra el cloud.
const MODES: string[] = process.env.EVAL_MODES
  ? process.env.EVAL_MODES.split(',').map((m) => m.trim()).filter(Boolean)
  : ['lexical', 'vector', 'hybrid'];
const BASE_URL = process.env.MICROSERVICE_URL;
if (!BASE_URL) throw new Error('MICROSERVICE_URL no configurado');

const key = (d: { doc_folder: string; url: string }) => `${d.doc_folder}::${d.url}`;

function recallAtK(hits: SearchHit[], relevant: Map<string, number>, k: number) {
  if (relevant.size === 0) return null;
  const top = new Set(hits.slice(0, k).map(key));
  const hit = [...relevant.keys()].filter((k2) => top.has(k2)).length;
  return hit / relevant.size;
}

function precisionAtK(hits: SearchHit[], relevant: Map<string, number>, k: number) {
  const top = hits.slice(0, k);
  if (top.length === 0) return null;
  const hit = top.filter((h) => relevant.has(key(h))).length;
  return hit / top.length;
}

function mrr(hits: SearchHit[], relevant: Map<string, number>) {
  if (relevant.size === 0) return null;
  const idx = hits.findIndex((h) => relevant.has(key(h)));
  return idx === -1 ? 0 : 1 / (idx + 1);
}

function ndcgAtK(hits: SearchHit[], relevant: Map<string, number>, k: number) {
  if (relevant.size === 0) return null;
  const dcg = hits
    .slice(0, k)
    .reduce((acc, h, i) => acc + (Math.pow(2, relevant.get(key(h)) ?? 0) - 1) / Math.log2(i + 2), 0);
  const ideal = [...relevant.values()].sort((a, b) => b - a);
  const idcg = ideal
    .slice(0, k)
    .reduce((acc, rel, i) => acc + (Math.pow(2, rel) - 1) / Math.log2(i + 2), 0);
  return idcg === 0 ? 0 : dcg / idcg;
}

function avg(nums: (number | null)[]) {
  const vals = nums.filter((n): n is number => n !== null);
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}

function p95(nums: number[]) {
  if (nums.length === 0) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
}

async function search(
  query: string,
  mode: string,
): Promise<{ hits: SearchHit[]; latencyMs: number }> {
  const url = `${BASE_URL}/search?q=${encodeURIComponent(query)}&mode=${mode}&k=10`;
  const start = performance.now();
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  const body = await res.json();
  return { hits: body.results, latencyMs: performance.now() - start };
}

async function main() {
  const gt = JSON.parse(readFileSync(join(__dirname, 'ground-truth.json'), 'utf-8'));
  const queries: Query[] = gt.queries;

  const perModeRows: Record<string, any[]> = Object.fromEntries(MODES.map((m) => [m, []]));
  const abstention: Record<string, number[]> = Object.fromEntries(MODES.map((m) => [m, []]));
  const latencies: Record<string, number[]> = Object.fromEntries(MODES.map((m) => [m, []]));

  for (const q of queries) {
    const relevant = new Map(q.relevant_documents.map((d) => [key(d), d.relevance_grade]));
    for (const mode of MODES) {
      const { hits, latencyMs } = await search(q.query_text, mode);
      latencies[mode].push(latencyMs);
      if (q.query_type === 'sin_evidencia') {
        abstention[mode].push(hits[0]?.score ?? 0);
        continue;
      }
      perModeRows[mode].push({
        query_id: q.query_id,
        query_type: q.query_type,
        recall5: recallAtK(hits, relevant, 5),
        recall10: recallAtK(hits, relevant, 10),
        precision5: precisionAtK(hits, relevant, 5),
        mrr: mrr(hits, relevant),
        ndcg10: ndcgAtK(hits, relevant, 10),
      });
    }
  }

  const report: any = { generatedAt: new Date().toISOString(), byMode: {}, byModeAndType: {} };

  for (const mode of MODES) {
    const rows = perModeRows[mode];
    report.byMode[mode] = {
      n: rows.length,
      recall5: avg(rows.map((r) => r.recall5)),
      recall10: avg(rows.map((r) => r.recall10)),
      precision5: avg(rows.map((r) => r.precision5)),
      mrr: avg(rows.map((r) => r.mrr)),
      ndcg10: avg(rows.map((r) => r.ndcg10)),
      avgTopScoreOnNoEvidenceQueries: avg(abstention[mode]),
      latencyAvgMs: avg(latencies[mode]),
      latencyP95Ms: p95(latencies[mode]),
    };
    report.byModeAndType[mode] = {};
    for (const type of [...new Set(rows.map((r) => r.query_type))]) {
      const typeRows = rows.filter((r) => r.query_type === type);
      report.byModeAndType[mode][type] = {
        n: typeRows.length,
        recall5: avg(typeRows.map((r) => r.recall5)),
        recall10: avg(typeRows.map((r) => r.recall10)),
        precision5: avg(typeRows.map((r) => r.precision5)),
        mrr: avg(typeRows.map((r) => r.mrr)),
        ndcg10: avg(typeRows.map((r) => r.ndcg10)),
      };
    }
  }

  writeFileSync(join(__dirname, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report.byMode, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
