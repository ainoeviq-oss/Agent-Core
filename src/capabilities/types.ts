export type CapabilityType =
  | 'skill'
  | 'agent'
  | 'command'
  | 'hook'
  | 'framework'
  | 'collection'
  | 'guide'
  | 'utility';

export type CapabilityState =
  | 'cataloged'
  | 'source_resolved'
  | 'license_verified'
  | 'function_analyzed'
  | 'safety_reviewed'
  | 'normalized'
  | 'native_ready'
  | 'reference_only'
  | 'quarantined'
  | 'unresolved'
  | 'license_unknown'
  | 'source_removed';

export type CapabilityRisk = 'low' | 'medium' | 'high' | 'unknown';

export interface CapabilitySource {
  url: string;
  repo: string | null;
  path: string | null;
  sha: string | null;
}

export interface CapabilityLicense {
  status: 'unknown' | 'verified' | 'incompatible';
  id: string | null;
}

export interface CapabilityRecord {
  id: string;
  name: string;
  displayName: string;
  aliases: string[];
  type: CapabilityType;
  category: string;
  categoryTitle: string;
  declaredPurpose: string;
  functionalSummary: string;
  source: CapabilitySource;
  compatibility: string[];
  language: string[];
  triggers: string[];
  invocation: 'auto_candidate' | 'router_or_explicit' | 'manual_only' | 'disabled' | 'reference_only';
  inputsContext: string[];
  outputsArtifacts: string[];
  requiredTools: string[];
  dependencies: string[];
  sideEffects: string[];
  risk: CapabilityRisk;
  license: CapabilityLicense;
  state: CapabilityState;
  nativeEligible: boolean;
  normalizedPath: string | null;
  equivalenceGroup: string | null;
  catalogSha: string;
  catalogFile: string;
  catalogRow: number;
}

export interface CoverageReport {
  catalogSha: string;
  generatedAt: string;
  total: number;
  byType: Record<string, number>;
  byState: Record<string, number>;
  nativeReady: number;
  referenceOnly: number;
  quarantined: number;
  unresolved: number;
}
