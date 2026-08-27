import type { StructuralReport, VisualDiffReport } from '../../types/contracts.js';

export interface OverallFidelity {
  structural: number | null;
  visual: number | null;
  overall: number | null;
  evidence: string[];
}

export function scoreFidelity(structural: StructuralReport, visual?: VisualDiffReport): OverallFidelity {
  const structuralScore = structural.confidence;
  const visualScore = visual?.similarity ?? null;
  const known = [structuralScore, visualScore].filter((v): v is number => v !== null);
  return {
    structural: structuralScore,
    visual: visualScore,
    overall: known.length ? Number((known.reduce((a, b) => a + b, 0) / known.length).toFixed(4)) : null,
    evidence: [
      structuralScore !== null ? 'structural' : '',
      visualScore !== null ? 'visual' : ''
    ].filter(Boolean)
  };
}
