#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadConfig } from '../config/index.js';
import { analyzePptx } from '../pptx/preflight/analyze.js';
import { buildPresentationIR } from '../pptx/ir/build.js';
import { writeJson } from '../reports/io.js';
import { runConversionJob } from '../jobs/orchestrator.js';
import { authorizeGoogle, getGoogleAccessToken } from '../converters/google/oauth.js';
import { GoogleRestClient } from '../converters/google/rest.js';
import { googleDoctor } from '../converters/google/doctor.js';
import { keynoteTargetDoctor } from '../converters/keynote/adapter.js';
import { startRemoteKeynoteWorkerServer } from '../workers/keynote/remote-server.js';
import { compareImages } from '../fidelity/visual/diff.js';
import { applyBoundedGoogleRepairs, parseGoogleRepairOperation } from '../repairs/google.js';
import { serializeError } from '../security/errors.js';
import type { JobTarget } from '../types/contracts.js';
import { PresentationBridgeService } from '../application/service.js';
import { startHostedServer } from '../hosted/server.js';

function option(args: string[], ...names: string[]): string | undefined {
  for (const name of names) {
    const index = args.indexOf(name);
    if (index >= 0) return args[index + 1];
    const prefix = `${name}=`;
    const hit = args.find((arg) => arg.startsWith(prefix));
    if (hit) return hit.slice(prefix.length);
  }
  return undefined;
}
function flag(args: string[], ...names: string[]): boolean { return names.some((name) => args.includes(name)); }
function positional(args: string[]): string[] {
  const takesValue = new Set(['-t','--target','-o','--output','--ir','--diff']);
  const output: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (takesValue.has(arg)) { i += 1; continue; }
    if (arg.startsWith('--') || arg.startsWith('-')) continue;
    output.push(arg);
  }
  return output;
}
function print(value: unknown): void { console.log(JSON.stringify(value, null, 2)); }
function help(): void {
  console.log(`Presentation Bridge 0.2.0

Commands:
  preflight <deck.pptx> [--output manifest.json] [--ir ir.json]
  convert <deck.pptx> [--target google|keynote|all] [--output dir] [--mock-google] [--mock-keynote]
  host [--host 127.0.0.1] [--port 4173]
  google auth
  google doctor
  google repair <presentationId> <plan.json>
  keynote doctor
  keynote worker [--host 127.0.0.1] [--port 4815]
  fidelity visual <source.png> <target.png> [--diff diff.png]
  doctor
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args.shift();
  if (!command || command === 'help' || command === '--help' || command === '-h') { help(); return; }
  if (command === '--version' || command === '-V') { console.log('0.2.0'); return; }
  const config = loadConfig();

  if (command === 'preflight') {
    const [pptx] = positional(args);
    if (!pptx) throw new Error('preflight requires <pptx>');
    const output = option(args, '-o', '--output');
    const irPath = option(args, '--ir');
    const manifest = await analyzePptx(pptx, config);
    if (output) await writeJson(resolve(output), manifest);
    if (irPath) await writeJson(resolve(irPath), buildPresentationIR(manifest));
    print({ source: manifest.source.filename, sha256: manifest.source.sha256, slides: manifest.slideCount, pageSize: manifest.pageSize, fonts: manifest.fonts.length, media: manifest.media.length, features: manifest.featureCounts, warnings: manifest.warnings, ...(output ? { manifest: resolve(output) } : {}), ...(irPath ? { ir: resolve(irPath) } : {}) });
    return;
  }

  if (command === 'convert') {
    const [pptx] = positional(args);
    if (!pptx) throw new Error('convert requires <pptx>');
    const target = (option(args, '-t', '--target') ?? 'all') as JobTarget;
    if (!['google','keynote','all'].includes(target)) throw new Error('--target must be google, keynote, or all');
    const output = option(args, '-o', '--output');
    const result = await runConversionJob(pptx, config, {
      target,
      ...(output ? { outputRoot: resolve(output) } : {}),
      googleMode: flag(args, '--mock-google') ? 'mock' : 'live',
      keynoteMode: flag(args, '--mock-keynote') ? 'mock' : 'live',
      ...(flag(args, '--keynote-pdf-preview') ? { exportKeynotePdfPreview: true } : {})
    });
    print({ jobRoot: result.jobRoot, report: result.report });
    if (result.report.status === 'failed') process.exitCode = 2;
    return;
  }

  if (command === 'host') {
    const host = option(args, '--host') ?? process.env.PB_HOSTED_HOST ?? '127.0.0.1';
    const portRaw = option(args, '--port') ?? process.env.PB_HOSTED_PORT ?? '4173';
    const port = Number.parseInt(portRaw, 10);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('--port must be an integer between 0 and 65535');
    const service = new PresentationBridgeService(config);
    const hosted = await startHostedServer({
      service,
      host,
      port,
      ...(process.env.PB_HOSTED_TOKEN ? { authToken: process.env.PB_HOSTED_TOKEN } : {})
    });
    print({ hosted: true, baseUrl: hosted.baseUrl, authRequired: Boolean(process.env.PB_HOSTED_TOKEN) });
    await new Promise<void>((resolveStop) => {
      const stop = () => { void hosted.close().finally(resolveStop); };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    });
    return;
  }

  if (command === 'google') {
    const sub = args.shift();
    if (sub === 'auth') { await authorizeGoogle(config); print({ authorized: true, tokenPath: config.googleTokenPath, scope: 'drive.file' }); return; }
    if (sub === 'doctor') { print(await googleDoctor(config)); return; }
    if (sub === 'repair') {
      const [presentationId, planJson] = positional(args);
      if (!presentationId || !planJson) throw new Error('google repair requires <presentationId> <plan.json>');
      await getGoogleAccessToken(config);
      const raw = JSON.parse(await readFile(resolve(planJson), 'utf8')) as unknown;
      if (!Array.isArray(raw)) throw new Error('repair plan must be a JSON array');
      const operations = raw.map(parseGoogleRepairOperation);
      print(await applyBoundedGoogleRepairs(new GoogleRestClient(config), presentationId, operations));
      return;
    }
    throw new Error('google requires auth, doctor, or repair');
  }

  if (command === 'keynote') {
    const sub = args.shift();
    if (sub === 'doctor') { print(await keynoteTargetDoctor(config)); return; }
    if (sub === 'worker') {
      const authToken = process.env.PB_KEYNOTE_WORKER_TOKEN?.trim();
      if (!authToken) throw new Error('Keynote worker authentication token is missing. Set PB_KEYNOTE_WORKER_TOKEN before starting the worker.');
      const host = option(args, '--host') ?? process.env.PB_KEYNOTE_WORKER_HOST ?? '127.0.0.1';
      const portRaw = option(args, '--port') ?? process.env.PB_KEYNOTE_WORKER_PORT ?? '4815';
      const port = Number.parseInt(portRaw, 10);
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('--port must be an integer between 0 and 65535');
      const tlsCert = process.env.PB_KEYNOTE_WORKER_TLS_CERT?.trim();
      const tlsKey = process.env.PB_KEYNOTE_WORKER_TLS_KEY?.trim();
      if (Boolean(tlsCert) !== Boolean(tlsKey)) throw new Error('PB_KEYNOTE_WORKER_TLS_CERT and PB_KEYNOTE_WORKER_TLS_KEY must be configured together.');
      const worker = await startRemoteKeynoteWorkerServer({
        host,
        port,
        authToken,
        artifactRoot: resolve(process.env.PB_KEYNOTE_WORKER_ARTIFACT_ROOT ?? './runtime/keynote-worker'),
        maxSourceBytes: config.limits.maxSourceBytes,
        ...(process.env.PB_KEYNOTE_WORKER_PUBLIC_URL ? { publicBaseUrl: process.env.PB_KEYNOTE_WORKER_PUBLIC_URL } : {}),
        ...(tlsCert && tlsKey ? { tls: { certPath: resolve(tlsCert), keyPath: resolve(tlsKey) } } : {}),
        config
      });
      print({ worker: 'keynote', ready: true, baseUrl: worker.baseUrl, tls: Boolean(tlsCert && tlsKey) });
      await new Promise<void>((resolveStop) => {
        const stop = () => { void worker.close().finally(resolveStop); };
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
      });
      return;
    }
    throw new Error('keynote requires doctor or worker');
  }

  if (command === 'fidelity') {
    const sub = args.shift();
    if (sub !== 'visual') throw new Error('fidelity supports visual');
    const [source, target] = positional(args);
    if (!source || !target) throw new Error('fidelity visual requires <sourceImage> <targetImage>');
    const diff = option(args, '--diff');
    print(await compareImages(resolve(source), resolve(target), diff ? resolve(diff) : undefined)); return;
  }

  if (command === 'doctor') {
    const doctor = await new PresentationBridgeService(config).doctor();
    print({
      ...doctor,
      externalAcceptanceGates: {
        googleLivePending: !(doctor.google.liveAuth === true && doctor.google.importCapability === true),
        keynoteLivePending: doctor.keynote.available !== true
      }
    });
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

main().catch((error: unknown) => { console.error(JSON.stringify(serializeError(error), null, 2)); process.exitCode = 1; });
