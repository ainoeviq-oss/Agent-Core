import { cp, mkdir } from 'node:fs/promises';
const from = new URL('../src/workers/keynote/assets/', import.meta.url);
const to = new URL('../dist/src/workers/keynote/assets/', import.meta.url);
await mkdir(to, { recursive: true });
await cp(from, to, { recursive: true });
