import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';
import type { RuntimeServices } from '../runtime/services.js';

export const HEALTH_METRICS_TOOL_NAMES = ['agent_core_health_metrics'] as const;

export function registerHealthMetricsTools(server: McpServer, runtime: RuntimeServices): void {
  server.registerTool('agent_core_health_metrics', {
    title: 'Agent Core Health Metrics',
    description: 'Return bounded runtime observability for memory, execution, GitHub, and routing without exposing credentials or raw execution logs.',
    outputSchema: {
      timestamp: z.number(),
      memory: z.record(z.string(), z.unknown()),
      execution: z.record(z.string(), z.unknown()),
      github: z.record(z.string(), z.unknown()),
      routing: z.record(z.string(), z.unknown()),
      overallHealth: z.enum(['healthy', 'degraded', 'critical']),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => {
    const structuredContent = await runtime.healthMetrics.getMetrics();
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(structuredContent, null, 2) }],
      structuredContent,
    };
  });
}
