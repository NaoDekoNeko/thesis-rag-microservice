/**
 * Compara el reporte de evaluación IR recién generado contra un baseline
 * versionado, y falla (exit 1) si alguna métrica cae más del umbral
 * permitido. Pieza central del prototipo de regresión semántica: detecta
 * si un cambio documental degrada la calidad de recuperación, algo que un
 * CI convencional (que solo valida estructura y build) no observa.
 *
 * Además de la salida por consola, escribe un resumen en Markdown
 * (COMMENT_FILE) pensado para publicarse como comentario automático en el
 * pull request, para que el resultado no dependa de que un revisor lea el
 * log del job.
 *
 * Uso: REPORT_FILE=... BASELINE_FILE=... REGRESSION_THRESHOLD=0.05 COMMENT_FILE=... ts-node eval/compare-baseline.ts
 */
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const reportPath = process.env.REPORT_FILE || join(__dirname, 'report.json');
const baselinePath = process.env.BASELINE_FILE || join(__dirname, 'baseline-report.json');
const commentPath = process.env.COMMENT_FILE || join(__dirname, 'pr-comment.md');
const threshold = parseFloat(process.env.REGRESSION_THRESHOLD || '0.05');

const report = JSON.parse(readFileSync(reportPath, 'utf-8'));
const baseline = JSON.parse(readFileSync(baselinePath, 'utf-8'));

const metrics = ['recall5', 'recall10', 'precision5', 'mrr', 'ndcg10'] as const;
const metricLabels: Record<string, string> = {
  recall5: 'Recall@5',
  recall10: 'Recall@10',
  precision5: 'Precision@5',
  mrr: 'MRR',
  ndcg10: 'nDCG@10',
};

let regressed = false;
const rows: string[] = [];

for (const mode of Object.keys(baseline.byMode)) {
  const cur = report.byMode[mode];
  const base = baseline.byMode[mode];
  console.log(`\n--- modo: ${mode} ---`);
  if (!cur) {
    console.error(`  Modo ausente en el reporte nuevo (esperado por el baseline).`);
    regressed = true;
    rows.push(`| ${mode} | (ausente) | — | — | — | ❌ |`);
    continue;
  }
  for (const m of metrics) {
    const curVal = cur[m] ?? 0;
    const baseVal = base[m] ?? 0;
    const delta = curVal - baseVal;
    const isRegression = delta < -threshold;
    const flag = isRegression ? '  <-- REGRESION' : '';
    console.log(`  ${m}: ${baseVal.toFixed(3)} -> ${curVal.toFixed(3)} (delta ${delta.toFixed(3)})${flag}`);
    if (isRegression) regressed = true;
    rows.push(
      `| ${mode} | ${metricLabels[m]} | ${baseVal.toFixed(3)} | ${curVal.toFixed(3)} | ${delta >= 0 ? '+' : ''}${delta.toFixed(3)} | ${isRegression ? '❌' : '✅'} |`,
    );
  }
}

const verdictLine = regressed
  ? `❌ **Regresión semántica detectada** (umbral -${threshold}). Este PR degrada la calidad de recuperación respecto al baseline.`
  : `✅ **Sin regresión semántica** (umbral -${threshold}).`;

const comment = [
  '## 🔎 Resultado de Semantic CI',
  '',
  verdictLine,
  '',
  '| Estrategia | Métrica | Baseline | PR | Δ | |',
  '|---|---|---|---|---|---|',
  ...rows,
  '',
  '<sub>Generado automáticamente por el job `semantic-regression`. El ground truth y el baseline se versionan en `thesis-rag-microservice/eval/`.</sub>',
].join('\n');

writeFileSync(commentPath, comment);

if (regressed) {
  console.error(`\nRegresion semantica detectada (umbral -${threshold}). El PR degrada la calidad de recuperacion respecto al baseline.`);
  process.exit(1);
}

console.log(`\nSin regresion semantica (umbral -${threshold}).`);
