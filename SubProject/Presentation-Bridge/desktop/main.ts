import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell, type OpenDialogOptions } from 'electron';
import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '#core/config/index.js';
import { PresentationBridgeService } from '#core/application/service.js';
import { DesktopSettingsStore, type KeynoteWorkerSettingsInput, type SettingsSecretCodec } from '#core/application/settings-store.js';
import type { StartConversionRequest } from '#core/application/contracts.js';

const VERSION = '0.2.0';
let mainWindow: BrowserWindow | null = null;
let service: PresentationBridgeService;
let settingsStore: DesktopSettingsStore;
let unsubscribeProgress: (() => void) | null = null;
const allowedSources = new Set<string>();
const allowedOutputRoots = new Set<string>();

function inside(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function createDesktopConfig() {
  const appRoot = app.getAppPath();
  const base = loadConfig(appRoot);
  const stateRoot = app.getPath('userData');
  const bundledClient = join(appRoot, 'dist', 'config', 'google-oauth-client.json');
  const legacyPackagedClient = join(process.resourcesPath, 'google', 'oauth-client.json');
  const googleCredentialsPath = existsSync(bundledClient)
    ? bundledClient
    : existsSync(legacyPackagedClient)
      ? legacyPackagedClient
      : base.googleCredentialsPath;
  return {
    ...base,
    cwd: appRoot,
    runtimeRoot: join(stateRoot, 'runtime', 'jobs'),
    googleCredentialsPath,
    googleTokenPath: join(stateRoot, 'secrets', 'google', 'token.json')
  };
}

function desktopSecretCodec(): SettingsSecretCodec {
  const requireEncryption = (): void => {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('Secure desktop credential storage is unavailable on this system.');
    }
  };
  return {
    encrypt: (plainText) => {
      requireEncryption();
      return safeStorage.encryptString(plainText).toString('base64');
    },
    decrypt: (cipherText) => {
      requireEncryption();
      return safeStorage.decryptString(Buffer.from(cipherText, 'base64'));
    }
  };
}

function installService(config: ReturnType<typeof createDesktopConfig>): void {
  unsubscribeProgress?.();
  service = new PresentationBridgeService(config);
  unsubscribeProgress = service.onProgress((event) => mainWindow?.webContents.send('pb:progress', event));
}

async function selectPresentation(): Promise<{ path: string; name: string; bytes: number } | null> {
  const options: OpenDialogOptions = {
    title: 'Select PowerPoint presentation',
    properties: ['openFile'],
    filters: [{ name: 'PowerPoint Presentation', extensions: ['pptx'] }]
  };
  const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
  const selected = result.filePaths[0];
  if (result.canceled || !selected) return null;
  const info = await stat(selected);
  if (!info.isFile() || extname(selected).toLowerCase() !== '.pptx') throw new Error('Selected file is not a .pptx presentation.');
  const resolved = resolve(selected);
  allowedSources.add(resolved);
  return { path: resolved, name: basename(resolved), bytes: info.size };
}

async function selectOutputDirectory(): Promise<string | null> {
  const options: OpenDialogOptions = {
    title: 'Choose output folder',
    properties: ['openDirectory', 'createDirectory']
  };
  const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
  const selected = result.filePaths[0];
  if (result.canceled || !selected) return null;
  const resolved = resolve(selected);
  allowedOutputRoots.add(resolved);
  return resolved;
}

function requireAllowedRuntimePath(path: string): string {
  const resolved = resolve(path);
  const inDefaultRuntime = inside(service.config.runtimeRoot, resolved);
  const inUserOutput = [...allowedOutputRoots].some((root) => inside(root, resolved));
  if (!inDefaultRuntime && !inUserOutput) throw new Error('Path is outside Presentation Bridge runtime artifacts.');
  return resolved;
}

function registerIpc(): void {
  ipcMain.handle('pb:environment', async () => ({
    surface: 'desktop', version: VERSION, platform: process.platform, packaged: app.isPackaged
  }));
  ipcMain.handle('pb:select-presentation', async () => await selectPresentation());
  ipcMain.handle('pb:select-output-directory', async () => await selectOutputDirectory());
  ipcMain.handle('pb:start-conversion', async (_event, request: StartConversionRequest) => {
    const sourcePath = resolve(request.sourcePath);
    if (!allowedSources.has(sourcePath)) throw new Error('Presentation path was not selected through the application file picker.');
    if (request.outputRoot) {
      const outputRoot = resolve(request.outputRoot);
      if (!allowedOutputRoots.has(outputRoot)) throw new Error('Output path was not selected through the application folder picker.');
    }
    if (!['google', 'keynote', 'all'].includes(request.target)) throw new Error('Invalid conversion target.');
    return service.startConversion({ ...request, sourcePath });
  });
  ipcMain.handle('pb:cancel', async (_event, jobId: string) => service.cancel(jobId));
  ipcMain.handle('pb:get-job', async (_event, jobId: string) => service.getJob(jobId) ?? null);
  ipcMain.handle('pb:list-history', async () => await service.listHistory());
  ipcMain.handle('pb:doctor', async () => await service.doctor());
  ipcMain.handle('pb:keynote-settings:get', async () => await settingsStore.view(service.config));
  ipcMain.handle('pb:keynote-settings:save', async (_event, input: KeynoteWorkerSettingsInput) => {
    if (service.hasActiveJobs()) throw new Error('Keynote worker settings cannot change while a conversion is running.');
    const view = await settingsStore.saveKeynoteWorker(input);
    installService(await settingsStore.applyToConfig(createDesktopConfig()));
    return view;
  });
  ipcMain.handle('pb:google-authorize', async () => {
    await service.authorizeGoogle();
    return { authorized: true as const };
  });
  ipcMain.handle('pb:open-path', async (_event, path: string) => {
    const safe = requireAllowedRuntimePath(path);
    const error = await shell.openPath(safe);
    if (error) throw new Error(error);
    return { opened: true as const };
  });
  ipcMain.handle('pb:reveal-path', async (_event, path: string) => {
    const safe = requireAllowedRuntimePath(path);
    shell.showItemInFolder(safe);
    return { revealed: true as const };
  });
  ipcMain.handle('pb:open-external', async (_event, rawUrl: string) => {
    const url = new URL(rawUrl);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Only HTTP(S) links can be opened.');
    await shell.openExternal(url.toString());
    return { opened: true as const };
  });
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 940,
    minHeight: 660,
    show: false,
    backgroundColor: '#0b0d12',
    title: 'Presentation Bridge',
    webPreferences: {
      preload: join(dirname(fileURLToPath(import.meta.url)), 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  mainWindow.removeMenu();
  mainWindow.once('ready-to-show', () => mainWindow?.show());

  const devServer = process.env.PB_VITE_DEV_SERVER_URL;
  if (devServer) await mainWindow.loadURL(devServer);
  else await mainWindow.loadFile(join(app.getAppPath(), 'dist', 'ui', 'index.html'));

  if (process.env.PB_ELECTRON_SMOKE === '1') {
    const result = await mainWindow.webContents.executeJavaScript(`window.presentationBridge.doctor().then(v => ({project:v.project, version:v.version})).catch(e => ({error:String(e)}))`);
    console.log(`PB_ELECTRON_SMOKE_READY ${JSON.stringify(result)}`);
    app.exit(result?.project === 'Presentation-Bridge' ? 0 : 2);
  }
}

app.whenReady().then(async () => {
  const stateRoot = app.getPath('userData');
  settingsStore = new DesktopSettingsStore(join(stateRoot, 'settings.json'), desktopSecretCodec());
  installService(await settingsStore.applyToConfig(createDesktopConfig()));
  registerIpc();
  await createWindow();
  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) await createWindow();
  });
}).catch((error) => {
  console.error(error);
  app.exit(1);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
