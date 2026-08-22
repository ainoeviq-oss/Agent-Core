import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('uses local-only network, project-local storage, capability storage, and current directory as safe defaults', () => {
    const baseDir = path.resolve('F:\\Projects\\Commander-MCP');
    const config = loadConfig({}, baseDir);

    expect(config.host).toBe('127.0.0.1');
    expect(config.port).toBe(8765);
    expect(config.dataDir).toBe(path.resolve(baseDir, 'data'));
    expect(config.logDir).toBe(path.resolve(baseDir, 'logs'));
    expect(config.capabilityDir).toBe(path.resolve(baseDir, 'capabilities'));
    expect(config.allowedRoots).toEqual([baseDir]);
  });

  it('accepts explicit environment overrides including capability storage and semicolon-separated roots', () => {
    const config = loadConfig({
      COMMANDER_HOST: '0.0.0.0',
      COMMANDER_PORT: '9999',
      COMMANDER_DATA_DIR: 'F:\\CustomData',
      COMMANDER_LOG_DIR: 'F:\\CustomLogs',
      COMMANDER_CAPABILITY_DIR: 'F:\\CommanderCapabilities',
      COMMANDER_ALLOWED_ROOTS: 'F:\\Projects;F:\\Design',
    }, 'F:\\Ignored');

    expect(config.host).toBe('0.0.0.0');
    expect(config.port).toBe(9999);
    expect(config.dataDir).toBe(path.resolve('F:\\CustomData'));
    expect(config.logDir).toBe(path.resolve('F:\\CustomLogs'));
    expect(config.capabilityDir).toBe(path.resolve('F:\\CommanderCapabilities'));
    expect(config.allowedRoots).toEqual([
      path.resolve('F:\\Projects'),
      path.resolve('F:\\Design'),
    ]);
  });
});
