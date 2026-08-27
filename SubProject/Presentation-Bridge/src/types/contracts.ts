export type TargetName = 'google' | 'keynote';
export type JobTarget = TargetName | 'all';
export type VerificationKind = 'live' | 'mock' | 'unavailable';
export type CompatibilityState =
  | 'preserved'
  | 'preserved_with_substitution'
  | 'approximated'
  | 'flattened'
  | 'unsupported'
  | 'unknown';

export interface SecurityLimits {
  maxSourceBytes: number;
  maxExpandedBytes: number;
  maxEntryBytes: number;
  maxZipEntries: number;
}

export interface ZipEntryEvidence {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
}

export interface SlideElementSummary {
  shapes: number;
  pictures: number;
  graphicFrames: number;
  groups: number;
  connectors: number;
  tables: number;
  charts: number;
  hyperlinks: number;
  texts: string[];
  objectIds: Array<{ id: string; name: string }>;
}

export interface SlideManifest {
  index: number;
  path: string;
  relationshipId?: string;
  elements: SlideElementSummary;
  hasTransition: boolean;
  hasAnimationTiming: boolean;
  hasNotes: boolean;
}

export interface MediaManifest {
  path: string;
  extension: string;
  bytes: number;
  sha256: string;
}

export interface ExternalRelationship {
  owner: string;
  id: string;
  target: string;
  type: string;
}

export interface SourceManifest {
  formatVersion: 1;
  source: {
    filename: string;
    absolutePath: string;
    bytes: number;
    sha256: string;
  };
  package: {
    entries: number;
    compressedBytes: number;
    expandedBytes: number;
  };
  slideCount: number;
  pageSize: { cxEmu: number | null; cyEmu: number | null; ratio: number | null };
  fonts: string[];
  masters: string[];
  layouts: string[];
  themes: string[];
  slides: SlideManifest[];
  media: MediaManifest[];
  charts: string[];
  notesSlides: string[];
  embeddedObjects: string[];
  externalRelationships: ExternalRelationship[];
  featureCounts: {
    tables: number;
    charts: number;
    hyperlinks: number;
    transitions: number;
    animations: number;
    images: number;
    groups: number;
  };
  warnings: string[];
}

export interface PresentationIR {
  schemaVersion: 1;
  sourceSha256: string;
  pageSize: SourceManifest['pageSize'];
  fonts: string[];
  masters: string[];
  layouts: string[];
  slides: Array<{
    index: number;
    sourcePath: string;
    elements: SlideElementSummary;
    transition: CompatibilityState;
    animation: CompatibilityState;
    notes: boolean;
  }>;
  unknowns: string[];
}

export interface TargetResult {
  target: TargetName;
  status: 'completed' | 'completed_with_warnings' | 'failed' | 'unavailable' | 'simulated';
  native: boolean;
  verification: VerificationKind;
  slideCount?: number;
  artifact?: string;
  fileId?: string;
  webViewLink?: string;
  warnings: string[];
  error?: { code: string; message: string; details?: Record<string, unknown> };
  metadata: Record<string, unknown>;
}

export interface StructuralFinding {
  metric: string;
  source: number | string | boolean | null;
  target: number | string | boolean | null;
  state: CompatibilityState;
  detail?: string;
}

export interface StructuralReport {
  target: TargetName;
  verification: VerificationKind;
  findings: StructuralFinding[];
  known: number;
  preserved: number;
  confidence: number | null;
  warnings: string[];
}

export interface VisualDiffReport {
  sourceImage: string;
  targetImage: string;
  width: number;
  height: number;
  mismatchedPixels: number;
  mismatchRatio: number;
  similarity: number;
  diffImage?: string;
}

export interface TargetVisualSummary {
  target: TargetName;
  verification: 'live' | 'unavailable';
  sourceSlides: number;
  targetSlides: number;
  comparedSlides: number;
  averageSimilarity: number | null;
  slides: VisualDiffReport[];
  warnings: string[];
}

export interface ConversionReport {
  schemaVersion: 1;
  jobId: string;
  createdAt: string;
  finishedAt: string;
  status: 'completed' | 'completed_with_warnings' | 'failed';
  source: SourceManifest['source'] & { slideCount: number };
  targets: Partial<Record<TargetName, TargetResult>>;
  structural: Partial<Record<TargetName, StructuralReport>>;
  visual: Partial<Record<TargetName, TargetVisualSummary>>;
  warnings: string[];
  artifacts: string[];
}
