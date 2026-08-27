import test from 'node:test';
import assert from 'node:assert/strict';
import { compareStructural } from '../../src/fidelity/structural/compare.js';
import type { SourceManifest, TargetResult } from '../../src/types/contracts.js';

const manifest = {
  formatVersion: 1, source: { filename:'x.pptx', absolutePath:'/x', bytes:1, sha256:'a' }, package:{entries:1,compressedBytes:1,expandedBytes:1}, slideCount:2,
  pageSize:{cxEmu:1,cyEmu:1,ratio:1}, fonts:[], masters:[], layouts:[], themes:[], slides:[], media:[], charts:[], notesSlides:[], embeddedObjects:[], externalRelationships:[],
  featureCounts:{tables:1,charts:1,hyperlinks:0,transitions:0,animations:0,images:2,groups:0}, warnings:[]
} satisfies SourceManifest;

test('live structural evidence receives confidence', () => {
  const target: TargetResult = { target:'google', status:'completed', native:true, verification:'live', slideCount:2, warnings:[], metadata:{ summary:{slideCount:2,images:2,tables:1,sheetsCharts:1,speakerNotesPages:0} } };
  const report = compareStructural(manifest, target);
  assert.equal(report.findings.find((x)=>x.metric==='slide_count')?.state, 'preserved');
  assert.notEqual(report.confidence, null);
});

test('mock structural evidence withholds confidence', () => {
  const target: TargetResult = { target:'google', status:'simulated', native:false, verification:'mock', slideCount:2, warnings:[], metadata:{} };
  assert.equal(compareStructural(manifest, target).confidence, null);
});
