/**
 * Compara el reporte de evaluación IR recién generado contra un baseline
 * versionado, y falla (exit 1) si alguna métrica cae más del umbral
 * permitido. Pieza central del prototipo de regresión semántica: detecta
 * si un cambio documental degrada la calidad de recuperación, algo que un
 * CI convencional (que solo valida estructura y build) no observa.
 *
 * Uso: REPORT_FILE=... BASELINE_FILE=... REGRESSION_THRESHOLD=0.05 ts-node eval/compare-baseline.ts
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const reportPath = process.env.REPORT_FILE || join(__dirname, 'report.json');
const baselinePath = process.env.BASELINE_FILE || join(__dirname, 'baseline-report.json');
const threshold = parseFloat(process.env.REGRESSION_THRESHOLD || '0.05');

const report = JSON.parse(readFileSync(reportPath, 'utf-8'));
const baseline = JSON.parse(readFileSync(baselinePath, 'utf-8'));

const metrics = ['recall5', 'recall10', 'precision5', 'mrr', 'ndcg10'] as const;

let regressed = false;

for (const mode of Object.keys(baseline.byMode)) {
  const cur = report.byMode[mode];
  const base = baseline.byMode[mode];
  console.log(`\n--- modo: ${mode} ---`);
  if (!cur) {
    console.error(`  Modo ausente en el reporte nuevo (esperado por el baseline).`);
    regressed = true;
    continue;
  }
  for (const m of metrics) {
    const curVal = cur[m] ?? 0;
    const baseVal = base[m] ?? 0;
    const delta = curVal - baseVal;
    const flag = delta < -threshold ? '  <-- REGRESION' : '';
    console.log(`  ${m}: ${baseVal.toFixed(3)} -> ${curVal.toFixed(3)} (delta ${delta.toFixed(3)})${flag}`);
    if (delta < -threshold) regressed = true;
  }
}

if (regressed) {
  console.error(`\nRegresion semantica detectada (umbral -${threshold}). El PR degrada la calidad de recuperacion respecto al baseline.`);
  process.exit(1);
}

console.log(`\nSin regresion semantica (umbral -${threshold}).`);
