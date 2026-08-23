import type { CapabilitySummary } from './registry-service.js';
import type { CapabilityRisk } from './types.js';

export type RouteTier = 'atomic' | 'structured' | 'domain_complex' | 'high_impact';
export type RouteMode = 'atomic_direct' | 'capability_guided' | 'skill_guided';

export interface RouteVerification {
  required: boolean;
  suggestedTools: string[];
}

export interface RoutePlan {
  tier: RouteTier;
  mode: RouteMode;
  domain: string;
  confidence: number;
  risk: CapabilityRisk;
  recommendedCapabilities: CapabilitySummary[];
  requiredSkillLoads: Array<{ id: string; name: string }>;
  allowedTools: string[];
  verification: RouteVerification;
  reasonCodes: string[];
}
