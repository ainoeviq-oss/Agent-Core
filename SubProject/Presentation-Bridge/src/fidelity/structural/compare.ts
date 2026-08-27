import type {
  CompatibilityState,
  SourceManifest,
  StructuralFinding,
  StructuralReport,
  TargetResult
} from '../../types/contracts.js';

function finding(metric: string, source: StructuralFinding['source'], target: StructuralFinding['target'], known: boolean, exact = true, detail?: string): StructuralFinding {
  let state: CompatibilityState = 'unknown';
  if (known) state = source === target ? 'preserved' : exact ? 'approximated' : 'preserved_with_substitution';
  return { metric, source, target, state, ...(detail ? { detail } : {}) };
}

export function compareStructural(manifest: SourceManifest, target: TargetResult): StructuralReport {
  const findings: StructuralFinding[] = [];
  findings.push(finding('native_target', true, target.native, target.verification === 'live'));
  findings.push(finding('slide_count', manifest.slideCount, target.slideCount ?? null, target.slideCount !== undefined));

  if (target.target === 'google') {
    const summary = target.metadata.summary as Record<string, unknown> | undefined;
    if (summary) {
      findings.push(finding('images', manifest.featureCounts.images, Number(summary.images ?? 0), true));
      findings.push(finding('tables', manifest.featureCounts.tables, Number(summary.tables ?? 0), true));
      findings.push(finding('charts', manifest.featureCounts.charts, Number(summary.sheetsCharts ?? 0), true, false,
        'Google Slides represents native chart objects as Sheets charts; imported chart representation can differ.'));
      findings.push(finding('speaker_notes_pages', manifest.notesSlides.length, Number(summary.speakerNotesPages ?? 0), true, false,
        'Counts notes-page structures, not semantic equality of note text.'));
    } else {
      findings.push(finding('images', manifest.featureCounts.images, null, false));
      findings.push(finding('tables', manifest.featureCounts.tables, null, false));
      findings.push(finding('charts', manifest.featureCounts.charts, null, false));
    }
  } else {
    findings.push(finding('fonts', manifest.fonts.length, null, false, true, 'Keynote worker V1 does not introspect font objects after native import.'));
    findings.push(finding('images', manifest.featureCounts.images, null, false));
    findings.push(finding('tables', manifest.featureCounts.tables, null, false));
    findings.push(finding('charts', manifest.featureCounts.charts, null, false));
  }

  if (manifest.featureCounts.transitions > 0) {
    findings.push(finding('transitions', manifest.featureCounts.transitions, null, false, true, 'Transition equivalence requires empirical target inspection.'));
  }
  if (manifest.featureCounts.animations > 0) {
    findings.push(finding('animations', manifest.featureCounts.animations, null, false, true, 'Animation equivalence requires empirical target inspection.'));
  }

  const knownFindings = findings.filter((item) => item.state !== 'unknown');
  const preserved = knownFindings.filter((item) => item.state === 'preserved' || item.state === 'preserved_with_substitution').length;
  const confidence = target.verification === 'live' && knownFindings.length > 0
    ? Number((preserved / knownFindings.length).toFixed(4))
    : null;

  return {
    target: target.target,
    verification: target.verification,
    findings,
    known: knownFindings.length,
    preserved,
    confidence,
    warnings: target.verification !== 'live'
      ? ['Structural confidence withheld because target verification was not live.']
      : []
  };
}
