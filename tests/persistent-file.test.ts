import { beforeEach, describe, expect, it, vi } from 'vitest';

const { renameMock, rmMock, writeFileMock } = vi.hoisted(() => ({
  renameMock: vi.fn(),
  rmMock: vi.fn(),
  writeFileMock: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  rename: renameMock,
  rm: rmMock,
  writeFile: writeFileMock,
}));

import { persistSerializedFile } from '../src/runtime/persistent-file.js';

describe('persistSerializedFile', () => {
  beforeEach(() => {
    renameMock.mockReset(); rmMock.mockReset(); writeFileMock.mockReset();
  });

  it('falls back to in-place write when Windows blocks atomic replacement', async () => {
    renameMock.mockRejectedValue(Object.assign(new Error('locked'), { code: 'EPERM' }));
    writeFileMock.mockResolvedValue(undefined); rmMock.mockResolvedValue(undefined);

    await persistSerializedFile('temp.json', 'data.json', '{"ok":true}\n');

    expect(writeFileMock).toHaveBeenCalledWith('data.json', '{"ok":true}\n', {
      encoding: 'utf8', mode: 0o600,
    });
    expect(rmMock).toHaveBeenCalledWith('temp.json', { force: true });
  });

  it('does not hide unrelated rename failures', async () => {
    renameMock.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }));
    await expect(persistSerializedFile('temp.json', 'data.json', '{}\n')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(writeFileMock).not.toHaveBeenCalled();
  });
});


