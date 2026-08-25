import type { CapabilityRegistry, CapabilitySummary } from './registry-service.js';
import type { RouteMode, RoutePlan, RouteTier, RouteVerification } from './route-types.js';
import type { CapabilityRisk } from './types.js';

const STRUCTURED_SIGNAL = /\b(and|then|after|before|review|refactor|debug|test|design|build|implement|analy[sz]e|optimi[sz]e)\b/i;
const HIGH_IMPACT_SIGNAL = /\b(production|deploy|credential|secret|system|admin|registry|delete|remove|shutdown|format)\b/i;
const READ_ONLY_SIGNAL = /\b(read|show|inspect|list|search|find|get|check|view)\b/i;
const MUTATION_SIGNAL = /\b(create|write|edit|change|update|move|rename|append|replace|delete|remove|refactor|fix|build|implement|deploy)\b/i;

const ROUTE_REQUIRED_TOOLS = [
  'list_directory',
  'read_file',
  'read_multiple_files',
  'write_file',
  'edit_file',
  'create_directory',
  'move_file',
  'get_file_info',
  'search_files',
  'execute_command',
  'start_process',
  'execution_create',
  'execution_start',
  'execution_add_nodes',
  'execution_retry',
  'execution_cancel',
] as const;

const ATOMIC_READ_TOOLS = [
  'list_directory', 'read_file', 'read_multiple_files', 'get_file_info', 'search_files',
];
const ATOMIC_MUTATION_TOOLS = [
  'list_directory',
  'read_file',
  'write_file',
  'edit_file',
  'create_directory',
  'move_file',
  'get_file_info',
  'execution_create',
  'execution_start',
  'execution_add_nodes',
  'execution_retry',
  'execution_cancel',
];

const riskRank: Record<CapabilityRisk, number> = {
  low: 0,
  unknown: 1,
  medium: 2,
  high: 3,
};

function strongestRisk(capabilities: CapabilitySummary[], highImpact: boolean): CapabilityRisk {
  if (highImpact) return 'high';
  let risk: CapabilityRisk = 'low';
  for (const capability of capabilities.slice(0, 5)) {
    if (riskRank[capability.risk] > riskRank[risk]) risk = capability.risk;
  }
  return risk;
}

function confidence(topScore: number): number {
  if (topScore <= 0) return 0.35;
  return Math.round(Math.min(1, 0.4 + topScore / 100) * 1000) / 1000;
}
function classifyTier(task: string, topScore: number): RouteTier {
  const highImpact = HIGH_IMPACT_SIGNAL.test(task);
  if (highImpact) return 'high_impact';
  const structured = STRUCTURED_SIGNAL.test(task);
  if (structured && topScore >= 8) return 'domain_complex';
  if (structured) return 'structured';
  return 'atomic';
}

function requiredSkills(
  recommendations: CapabilitySummary[],
): Array<{ id: string; name: string }> {
  const topScore = recommendations[0]?.score ?? 0;
  if (topScore <= 0) return [];
  const threshold = Math.max(8, topScore * 0.65);
  return recommendations
    .filter((capability) => capability.type === 'skill')
    .filter((capability) => capability.state === 'native_ready' && capability.nativeEligible)
    .filter((capability) => (
      capability.invocation === 'auto_candidate' || capability.invocation === 'router_or_explicit'
    ))
    .filter((capability) => (capability.score ?? 0) >= threshold)
    .slice(0, 2)
    .map(({ id, name }) => ({ id, name }));
}
function modeFor(tier: RouteTier, skillLoads: Array<{ id: string; name: string }>): RouteMode {
  if (tier === 'atomic') return 'atomic_direct';
  return skillLoads.length ? 'skill_guided' : 'capability_guided';
}

function allowedTools(task: string, tier: RouteTier): string[] {
  if (tier !== 'atomic') return [...ROUTE_REQUIRED_TOOLS];
  const isReadOnly = READ_ONLY_SIGNAL.test(task) && !MUTATION_SIGNAL.test(task);
  if (isReadOnly) return [...ATOMIC_READ_TOOLS];
  if (MUTATION_SIGNAL.test(task)) return [...ATOMIC_MUTATION_TOOLS];
  return [...ROUTE_REQUIRED_TOOLS];
}

function verificationFor(task: string, tier: RouteTier): RouteVerification {
  if (tier === 'atomic') {
    const isReadOnly = READ_ONLY_SIGNAL.test(task) && !MUTATION_SIGNAL.test(task);
    if (isReadOnly) return { required: false, suggestedTools: [] };
    return { required: true, suggestedTools: ['read_file', 'get_file_info'] };
  }
  return {
    required: true,
    suggestedTools: ['read_file', 'get_file_info', 'search_files', 'read_process_output'],
  };
}
function reasonCodes(
  task: string,
  tier: RouteTier,
  topScore: number,
  skillLoads: Array<{ id: string; name: string }>,
): string[] {
  const reasons: string[] = [];
  if (HIGH_IMPACT_SIGNAL.test(task)) reasons.push('high_impact_signal');
  if (STRUCTURED_SIGNAL.test(task)) reasons.push('structured_task_signal');
  if (topScore >= 8) reasons.push('strong_capability_match');
  if (skillLoads.length) reasons.push('native_skill_required');
  if (tier === 'atomic') reasons.push('atomic_direct');
  return reasons;
}

export class CapabilityRouter {
  constructor(private readonly registry: CapabilityRegistry) {}

  route(task: string, context = ''): RoutePlan {
    const recommendations = this.registry.recommend(task, context, 8);
    const topScore = recommendations[0]?.score ?? 0;
    const tier = classifyTier(task, topScore);
    const requiredSkillLoads = tier === 'atomic' ? [] : requiredSkills(recommendations);
    const highImpact = tier === 'high_impact';

    return {
      tier,
      mode: modeFor(tier, requiredSkillLoads),
      domain: recommendations[0]?.category ?? 'general',
      confidence: confidence(topScore),
      risk: strongestRisk(recommendations, highImpact),
      recommendedCapabilities: recommendations,
      requiredSkillLoads,
      allowedTools: allowedTools(task, tier),
      verification: verificationFor(task, tier),
      reasonCodes: reasonCodes(task, tier, topScore, requiredSkillLoads),
    };
  }
}
