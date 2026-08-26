import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('uses local-only network, project-local storage, and production-ready execution defaults', () => {
    const baseDir = path.resolve('F:\\Projects\\Agent-Core');
    const config = loadConfig({}, baseDir);

    expect(config.host).toBe('127.0.0.1');
    expect(config.port).toBe(8765);
    expect(config.dataDir).toBe(path.resolve(baseDir, 'data'));
    expect(config.logDir).toBe(path.resolve(baseDir, 'logs'));
    expect(config.capabilityDir).toBe(path.resolve(baseDir, 'capabilities'));
    expect(config.allowedRoots).toEqual([baseDir]);
    expect(config.execution).toEqual({
      enabled: true,
      dbPath: path.join(baseDir, 'runtime', 'execution', 'agent-core-execution.sqlite'),
      logRoot: path.join(baseDir, 'runtime', 'execution', 'runs'),
      maxConcurrency: 4,
      maxNodes: 128,
      waitMaxMs: 60_000,
      busyTimeoutMs: 5_000,
    });
    expect(config.github).toEqual({
      enabled: true,
      apiBaseUrl: 'https://api.github.com',
      apiVersion: '2026-03-10',
      tokenFile: path.join(baseDir, 'secrets', 'github', 'gh-token.txt'),
      packagesTokenFile: path.join(baseDir, 'secrets', 'github', 'packages-token.txt'),
      requestTimeoutMs: 30_000,
      gitTimeoutMs: 120_000,
    });
  });

  it('accepts explicit environment overrides including execution and github settings', () => {
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
      AGENT_CORE_GITHUB_ENABLED: 'false',
      AGENT_CORE_GITHUB_API_BASE_URL: 'https://github.example.test/api/v3/',
      AGENT_CORE_GITHUB_API_VERSION: '2026-03-10',
      AGENT_CORE_GITHUB_TOKEN_FILE: 'F:\\Secrets\\github.txt',
      AGENT_CORE_GITHUB_PACKAGES_TOKEN_FILE: 'F:\\Secrets\\packages.txt',
      AGENT_CORE_GITHUB_REQUEST_TIMEOUT_MS: '11111',
      AGENT_CORE_GITHUB_GIT_TIMEOUT_MS: '22222',
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
    expect(config.github).toEqual({
      enabled: false,
      apiBaseUrl: 'https://github.example.test/api/v3',
      apiVersion: '2026-03-10',
      tokenFile: path.resolve('F:\\Secrets\\github.txt'),
      packagesTokenFile: path.resolve('F:\\Secrets\\packages.txt'),
      requestTimeoutMs: 11_111,
      gitTimeoutMs: 22_222,
    });
  });

  it('rejects non-http github api base urls', () => {
    expect(() => loadConfig({ AGENT_CORE_GITHUB_API_BASE_URL: 'file:///tmp/api' }, 'F:\\Ignored'))
      .toThrow('AGENT_CORE_GITHUB_API_BASE_URL must use http or https');
  });
});
