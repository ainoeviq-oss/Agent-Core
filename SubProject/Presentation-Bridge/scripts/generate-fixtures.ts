import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import PptxGenJSFactory from 'pptxgenjs';
const PptxGenJS = PptxGenJSFactory as unknown as new () => any;
import { SafeZipArchive } from '../src/pptx/opc/zip.js';
import { loadConfig } from '../src/config/index.js';
import { writeStoredZip } from './zip-store.js';

const root = resolve('corpus/generated');
await rm(root, { recursive: true, force: true });
await mkdir(root, { recursive: true });

function svgData(svg: string): string { return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`; }

async function makeDeck(name: string, build: (pptx: any, slide: any) => void): Promise<string> {
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';
  pptx.author = 'Presentation Bridge Test Corpus';
  pptx.company = 'Standalone';
  pptx.subject = `Controlled fixture: ${name}`;
  pptx.title = name;
  pptx.lang = 'en-US';
  const slide = pptx.addSlide();
  slide.background = { color: 'F7F5EF' };
  slide.addText(name, { x: 0.7, y: 0.45, w: 11.8, h: 0.5, fontFace: 'Arial', fontSize: 24, bold: true, color: '1C1C1C' });
  build(pptx, slide);
  const path = join(root, `${name}.pptx`);
  await pptx.writeFile({ fileName: path, compression: true });
  return path;
}

async function mutatePptx(path: string, mutate: (entries: Map<string, Buffer>) => void): Promise<void> {
  const config = loadConfig();
  const zip = await SafeZipArchive.open(path, config.limits);
  const entries = new Map<string, Buffer>();
  for (const name of zip.names()) {
    if (name.endsWith('/')) continue;
    entries.set(name, zip.read(name)!);
  }
  mutate(entries);
  await writeStoredZip(path, [...entries].map(([name, data]) => ({ name, data })));
}

const files: string[] = [];
files.push(await makeDeck('01-basic-text-shapes', (pptx, slide) => {
  slide.addText('Editable text and vector geometry', { x: 0.8, y: 1.5, w: 5, h: 0.5, fontFace: 'Arial', fontSize: 20, color: '333333' });
  slide.addShape(pptx.ShapeType.roundRect, { x: 7.2, y: 1.4, w: 4.6, h: 2.1, rectRadius: 0.08, fill: { color: 'D9E7FF' }, line: { color: '5577AA', width: 1.5 } });
}));
files.push(await makeDeck('02-images-and-crop', (_pptx, slide) => {
  slide.addImage({ data: svgData('<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800"><rect width="1200" height="800" fill="#d8b56a"/><circle cx="600" cy="400" r="240" fill="#26313f"/></svg>'), x: 1, y: 1.3, w: 5.5, h: 3.8, altText: 'Controlled geometric image' });
  slide.addImage({ data: svgData('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="800"><rect width="800" height="800" fill="#7bb5a3"/><path d="M0 800L800 0V800Z" fill="#fff"/></svg>'), x: 7, y: 1.3, w: 4.3, h: 4.3, transparency: 8 });
}));
files.push(await makeDeck('03-master-layout-theme', (_pptx, slide) => {
  slide.addText('Theme-aware text uses common fonts and a wide 16:9 canvas.', { x: 0.9, y: 1.7, w: 10.5, h: 0.6, fontFace: 'Arial', fontSize: 22, color: '24527A' });
}));
files.push(await makeDeck('04-tables', (_pptx, slide) => {
  slide.addTable([['Metric','Q1','Q2'],['Revenue','$12K','$18K'],['Growth','14%','22%']], { x: 1, y: 1.5, w: 8, h: 2.5, border: { type: 'solid', color: '777777', pt: 1 }, fontFace: 'Arial', fontSize: 15 });
}));
files.push(await makeDeck('05-charts', (pptx, slide) => {
  slide.addChart(pptx.ChartType.bar, [{ name: 'Revenue', labels: ['A','B','C'], values: [12,18,25] }], { x: 1, y: 1.4, w: 8.5, h: 4.6, showLegend: false, showTitle: true, title: 'Controlled Bar Chart' });
}));
files.push(await makeDeck('06-svg', (_pptx, slide) => {
  slide.addImage({ data: svgData('<svg xmlns="http://www.w3.org/2000/svg" width="900" height="500"><rect width="900" height="500" rx="80" fill="#101820"/><text x="450" y="290" text-anchor="middle" font-size="120" fill="#f2aa4c">SVG</text></svg>'), x: 1.2, y: 1.4, w: 8, h: 4 });
}));
files.push(await makeDeck('07-gradients-transparency', (pptx, slide) => {
  slide.addShape(pptx.ShapeType.rect, { x: 1, y: 1.5, w: 4.3, h: 3.4, fill: { color: '315B7D', transparency: 25 }, line: { transparency: 100 } });
  slide.addShape(pptx.ShapeType.ellipse, { x: 4.2, y: 2, w: 3.5, h: 3.5, fill: { color: 'E2A76F', transparency: 42 }, line: { color: 'AA7744', transparency: 50 } });
}));
files.push(await makeDeck('08-groups-rotation', (pptx, slide) => {
  slide.addShape(pptx.ShapeType.rect, { x: 1.2, y: 1.8, w: 3.2, h: 1.4, rotate: 12, fill: { color: 'DDE5FF' }, line: { color: '556AA6' } });
  slide.addText('Rotation evidence', { x: 5.2, y: 2.1, w: 4, h: 0.6, rotate: -8, fontFace: 'Arial', fontSize: 22 });
}));
files.push(await makeDeck('09-links-notes', (_pptx, slide) => {
  slide.addText([{ text: 'Open example.com', options: { hyperlink: { url: 'https://example.com' }, color: '1155CC', underline: { color: '1155CC' } } }], { x: 1, y: 1.7, w: 5, h: 0.6, fontFace: 'Arial', fontSize: 20 });
  slide.addNotes('Controlled speaker note for Presentation Bridge compatibility testing.');
}));
const transition = await makeDeck('10-animation-transition', (_pptx, slide) => {
  slide.addText('Transition/timing is injected after generation for deterministic OOXML inventory.', { x: 1, y: 1.8, w: 9.5, h: 1, fontFace: 'Arial', fontSize: 20 });
});
await mutatePptx(transition, (entries) => {
  const key = 'ppt/slides/slide1.xml';
  const xml = entries.get(key)!.toString('utf8');
  entries.set(key, Buffer.from(xml.replace('</p:sld>', '<p:transition spd="med"><p:fade/></p:transition><p:timing><p:tnLst><p:par><p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot"/></p:par></p:tnLst></p:timing></p:sld>')));
});
files.push(transition);
const media = await makeDeck('11-media', (_pptx, slide) => {
  slide.addText('The package includes a controlled embedded media payload for inventory validation.', { x: 1, y: 1.8, w: 9, h: 1, fontFace: 'Arial', fontSize: 20 });
});
await mutatePptx(media, (entries) => {
  entries.set('ppt/media/controlled-media.bin', Buffer.from('PRESENTATION_BRIDGE_CONTROLLED_MEDIA_PAYLOAD'));
});
files.push(media);
files.push(await makeDeck('12-complex-real-world', (pptx, slide) => {
  slide.addText('Executive Overview', { x: 0.9, y: 1.35, w: 4.6, h: 0.6, fontFace: 'Arial', fontSize: 28, bold: true, color: '1D3146' });
  slide.addText('A mixed-content fixture combining editable text, imagery, a table, a chart, notes, and links.', { x: 0.9, y: 2.05, w: 4.7, h: 1.2, fontFace: 'Arial', fontSize: 17, color: '465A6E' });
  slide.addImage({ data: svgData('<svg xmlns="http://www.w3.org/2000/svg" width="900" height="600"><rect width="900" height="600" fill="#dce8e4"/><path d="M0 500 Q300 200 900 420V600H0Z" fill="#628c7c"/></svg>'), x: 6, y: 1.2, w: 5.7, h: 2.8 });
  slide.addTable([['KPI','Value'],['Retention','94%'],['NPS','68']], { x: 0.9, y: 4.15, w: 3.5, h: 1.5, border: { type: 'solid', color: '9DA8B2', pt: 0.8 }, fontFace: 'Arial', fontSize: 12 });
  slide.addChart(pptx.ChartType.line, [{ name: 'Signal', labels: ['Jan','Feb','Mar','Apr'], values: [10,14,13,21] }], { x: 4.8, y: 4, w: 6.8, h: 2.3, showLegend: false, showTitle: false });
  slide.addNotes('Complex fixture note.');
}));

await writeFile(join(root, 'manifest.json'), `${JSON.stringify({ generatedAt: new Date().toISOString(), files: files.map((path) => path.split(/[\\/]/).pop()), note: 'Controlled local corpus. Feature support claims are determined by preflight/target evidence, not fixture filenames alone.' }, null, 2)}\n`);
console.log(JSON.stringify({ generated: files.length, root }, null, 2));
