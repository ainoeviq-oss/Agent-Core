import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('uses local-only network, project-local storage, and development-safe execution defaults', () => {
    const baseDir = path.resolve('F:\\Projects\\Agent-Core');
    const config = loadConfig({}, baseDir);

    expect(config.host).toBe('127.0.0.1');
    expect(config.port).toBe(8765);
    expect(config.dataDir).toBe(path.resolve(baseDir, 'data'));
    expect(config.logDir).toBe(path.resolve(baseDir, 'logs'));
    expect(config.capabilityDir).toBe(path.resolve(baseDir, 'capabilities'));
    expect(config.allowedRoots).toEqual([baseDir]);
    expect(config.execution).toEqual({
      enabled: false,
      dbPath: path.join(baseDir, 'runtime', 'execution', 'agent-core-execution.sqlite'),
      logRoot: path.join(baseDir, 'runtime', 'execution', 'runs'),
      maxConcurrency: 4,
      maxNodes: 128,
      waitMaxMs: 60_000,
      busyTimeoutMs: 5_000,
    });
  });

  it('accepts explicit environment overrides including execution storage and concurrency bounds', () => {
    const config = loadConfig({
      AGENT_CORE_HOST: '0.0.0.0',
      AGENT_CORE_PORT: '9999',
      AGENT_CORE_DATA_DIR: 'F:\\CustomData',
      AGENT_CORE_LOG_DIR: 'F:\\CustomLogs',
      AGENT_CORE_CAPABILITY_DIR: 'F:\\AgentCoreCapabilities',
      AGENT_CORE_ALLOWED_ROOTS: 'F:\\Projects;F:\\Design',
      AGENT_CORE_EXECUTION_ENABLED: 'true',
      AGENT_CORE_EXECUTION_DB_PATH: 'F:\\Exec\\execution.sqlite',
      AGENT_CORE_EXECUTION_LOG_ROOT: 'F:\\Exec\\runs',
      AGENT_CORE_EXECUTION_MAX_CONCURRENCY: '8',
      AGENT_CORE_EXECUTION_MAX_NODES: '64',
      AGENT_CORE_EXECUTION_WAIT_MAX_MS: '45000',
      AGENT_CORE_EXECUTION_BUSY_TIMEOUT_MS: '7000',
    }, 'F:\\Ignored');

    expect(config.host).toBe('0.0.0.0');
    expect(config.port).toBe(9999);
    expect(config.dataDir).toBe(path.resolve('F:\\CustomData'));
    expect(config.logDir).toBe(path.resolve('F:\\CustomLogs'));
    expect(config.capabilityDir).toBe(path.resolve('F:\\AgentCoreCapabilities'));
    expect(config.allowedRoots).toEqual([
      path.resolve('F:\\Projects'),
      path.resolve('F:\\Design'),
    ]);
    expect(config.execution).toEqual({
      enabled: true,
      dbPath: path.resolve('F:\\Exec\\execution.sqlite'),
      logRoot: path.resolve('F:\\Exec\\runs'),
      maxConcurrency: 8,
      maxNodes: 64,
      waitMaxMs: 45_000,
      busyTimeoutMs: 7_000,
    });
  });
});
