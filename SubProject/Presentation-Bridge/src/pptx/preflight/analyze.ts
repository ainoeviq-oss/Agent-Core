import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';
import type {
  ExternalRelationship,
  MediaManifest,
  SlideElementSummary,
  SlideManifest,
  SourceManifest
} from '../../types/contracts.js';
import type { BridgeConfig } from '../../config/index.js';
import { BridgeError, ErrorCode } from '../../security/errors.js';
import { SafeZipArchive } from '../opc/zip.js';
import { attribute, countTag, tags, textRuns, typefaces } from '../ooxml/xml.js';

const PPTX_EXTENSION = '.pptx';
const REQUIRED_PARTS = ['[Content_Types].xml', 'ppt/presentation.xml'];

function sha256(data: Buffer | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function zipText(zip: SafeZipArchive, path: string): string | null {
  return zip.text(path);
}

function slideNumber(path: string): number {
  return Number.parseInt(path.match(/slide(\d+)\.xml$/)?.[1] ?? '0', 10);
}

function normalizeRelTarget(ownerPath: string, target: string): string {
  const clean = target.replaceAll('\\', '/');
  if (clean.startsWith('/')) return clean.replace(/^\/+/, '');
  const ownerDir = ownerPath.slice(0, ownerPath.lastIndexOf('/') + 1);
  const parts = `${ownerDir}${clean}`.split('/');
  const stack: string[] = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') stack.pop();
    else stack.push(part);
  }
  return stack.join('/');
}

function relsPathFor(partPath: string): string {
  const slash = partPath.lastIndexOf('/');
  const dir = slash >= 0 ? partPath.slice(0, slash + 1) : '';
  const file = slash >= 0 ? partPath.slice(slash + 1) : partPath;
  return `${dir}_rels/${file}.rels`;
}

function parseRelationships(ownerPath: string, xml: string): Array<{
  id: string;
  target: string;
  type: string;
  external: boolean;
}> {
  return tags(xml, 'Relationship').map((tag) => ({
    id: attribute(tag, 'Id') ?? '',
    target: attribute(tag, 'Target') ?? '',
    type: attribute(tag, 'Type') ?? '',
    external: (attribute(tag, 'TargetMode') ?? '').toLowerCase() === 'external'
  })).filter((rel) => rel.id && rel.target).map((rel) => ({
    ...rel,
    target: rel.external ? rel.target : normalizeRelTarget(ownerPath, rel.target)
  }));
}

function parsePageSize(xml: string): SourceManifest['pageSize'] {
  const tag = tags(xml, 'p:sldSz')[0];
  if (!tag) return { cxEmu: null, cyEmu: null, ratio: null };
  const cx = Number.parseInt(attribute(tag, 'cx') ?? '', 10);
  const cy = Number.parseInt(attribute(tag, 'cy') ?? '', 10);
  const valid = Number.isFinite(cx) && Number.isFinite(cy) && cy > 0;
  return {
    cxEmu: valid ? cx : null,
    cyEmu: valid ? cy : null,
    ratio: valid ? Number((cx / cy).toFixed(6)) : null
  };
}

function elementSummary(xml: string): SlideElementSummary {
  const objectIds = tags(xml, 'p:cNvPr').map((tag) => ({
    id: attribute(tag, 'id') ?? '',
    name: attribute(tag, 'name') ?? ''
  })).filter((item) => item.id || item.name);

  return {
    shapes: countTag(xml, 'p:sp'),
    pictures: countTag(xml, 'p:pic'),
    graphicFrames: countTag(xml, 'p:graphicFrame'),
    groups: countTag(xml, 'p:grpSp'),
    connectors: countTag(xml, 'p:cxnSp'),
    tables: countTag(xml, 'a:tbl'),
    charts: countTag(xml, 'c:chart'),
    hyperlinks: countTag(xml, 'a:hlinkClick') + countTag(xml, 'a:hlinkMouseOver'),
    texts: textRuns(xml),
    objectIds
  };
}

async function orderedSlides(zip: SafeZipArchive, presentationXml: string): Promise<Array<{ path: string; relationshipId?: string }>> {
  const relsXml = zipText(zip, 'ppt/_rels/presentation.xml.rels');
  if (!relsXml) {
    return zip.names()
      .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
      .sort((a, b) => slideNumber(a) - slideNumber(b))
      .map((path) => ({ path }));
  }

  const rels = parseRelationships('ppt/presentation.xml', relsXml);
  const relById = new Map(rels.filter((rel) => /\/slide$/i.test(rel.type)).map((rel) => [rel.id, rel.target]));
  const ids = tags(presentationXml, 'p:sldId')
    .map((tag) => attribute(tag, 'r:id'))
    .filter((value): value is string => Boolean(value));

  const result = ids.flatMap((relationshipId) => {
    const path = relById.get(relationshipId);
    return path ? [{ path, relationshipId }] : [];
  });

  if (result.length > 0) return result;
  return zip.names()
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
    .sort((a, b) => slideNumber(a) - slideNumber(b))
    .map((path) => ({ path }));
}

async function collectExternalRelationships(zip: SafeZipArchive): Promise<ExternalRelationship[]> {
  const owners = zip.names().filter((name) => name.endsWith('.rels'));
  const output: ExternalRelationship[] = [];
  for (const relsPath of owners) {
    const xml = zipText(zip, relsPath);
    if (!xml) continue;
    const owner = relsPath
      .replace('/_rels/', '/')
      .replace(/\.rels$/, '');
    for (const rel of parseRelationships(owner, xml)) {
      if (rel.external) output.push({ owner, id: rel.id, target: rel.target, type: rel.type });
    }
  }
  return output;
}

export async function analyzePptx(inputPath: string, config: BridgeConfig): Promise<SourceManifest> {
  const absolutePath = resolve(inputPath);
  const extension = extname(absolutePath).toLowerCase();
  if (extension !== PPTX_EXTENSION) {
    throw new BridgeError(
      extension === '.pptm' ? ErrorCode.SOURCE_UNSUPPORTED_EXTENSION : ErrorCode.SOURCE_INVALID_PPTX,
      `Only .pptx input is accepted; received ${extension || '(no extension)'}`
    );
  }

  const zip = await SafeZipArchive.open(absolutePath, config.limits);
  const inspection = { sourceBytes: zip.sourceBytes, entries: zip.entries, compressedBytes: zip.compressedBytes, expandedBytes: zip.expandedBytes };
  const entryNames = new Set(zip.names());
  for (const required of REQUIRED_PARTS) {
    if (!entryNames.has(required)) {
      throw new BridgeError(ErrorCode.SOURCE_INVALID_PPTX, `Required OOXML part is missing: ${required}`);
    }
  }

  const sourceBuffer = await readFile(absolutePath);

  const presentationXml = zipText(zip, 'ppt/presentation.xml');
  if (!presentationXml) throw new BridgeError(ErrorCode.SOURCE_INVALID_PPTX, 'ppt/presentation.xml is unreadable');

  const ordered = await orderedSlides(zip, presentationXml);
  const slides: SlideManifest[] = [];
  const allXmlForFonts: string[] = [presentationXml];

  for (let i = 0; i < ordered.length; i += 1) {
    const item = ordered[i]!;
    const xml = zipText(zip, item.path);
    if (!xml) continue;
    allXmlForFonts.push(xml);
    const relPath = relsPathFor(item.path);
    const relXml = zipText(zip, relPath);
    const hasNotes = relXml ? parseRelationships(item.path, relXml).some((rel) => /\/notesSlide$/i.test(rel.type)) : false;
    slides.push({
      index: i + 1,
      path: item.path,
      ...(item.relationshipId ? { relationshipId: item.relationshipId } : {}),
      elements: elementSummary(xml),
      hasTransition: /<p:transition\b/i.test(xml),
      hasAnimationTiming: /<p:timing\b/i.test(xml),
      hasNotes
    });
  }

  const fontXmlPaths = zip.names().filter((name) =>
    /^(ppt\/(theme|slideMasters|slideLayouts)\/.*\.xml|ppt\/notesMasters\/.*\.xml)$/i.test(name)
  );
  for (const path of fontXmlPaths) {
    const xml = zipText(zip, path);
    if (xml) allXmlForFonts.push(xml);
  }

  const mediaPaths = zip.names().filter((name) => /^ppt\/media\/[^/]+$/i.test(name));
  const media: MediaManifest[] = [];
  for (const path of mediaPaths) {
    const bytes = zip.read(path)!;
    media.push({
      path,
      extension: extname(path).toLowerCase().replace(/^\./, ''),
      bytes: bytes.byteLength,
      sha256: sha256(bytes)
    });
  }

  const masters = zip.names().filter((name) => /^ppt\/slideMasters\/slideMaster\d+\.xml$/i.test(name)).sort();
  const layouts = zip.names().filter((name) => /^ppt\/slideLayouts\/slideLayout\d+\.xml$/i.test(name)).sort();
  const themes = zip.names().filter((name) => /^ppt\/theme\/theme\d+\.xml$/i.test(name)).sort();
  const charts = zip.names().filter((name) => /^ppt\/charts\/chart\d+\.xml$/i.test(name)).sort();
  const notesSlides = zip.names().filter((name) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/i.test(name)).sort();
  const embeddedObjects = zip.names().filter((name) => /^ppt\/embeddings\/[^/]+$/i.test(name)).sort();
  const externalRelationships = await collectExternalRelationships(zip);

  const warnings: string[] = [];
  if (embeddedObjects.length > 0) warnings.push(`${embeddedObjects.length} embedded/OLE object(s) require target compatibility review.`);
  if (externalRelationships.length > 0) warnings.push(`${externalRelationships.length} external relationship(s) detected; no external content will be downloaded automatically.`);
  if (slides.length !== ordered.length) warnings.push('One or more ordered slide parts could not be read.');

  const featureCounts = slides.reduce((sum, slide) => ({
    tables: sum.tables + slide.elements.tables,
    charts: sum.charts + slide.elements.charts,
    hyperlinks: sum.hyperlinks + slide.elements.hyperlinks,
    transitions: sum.transitions + Number(slide.hasTransition),
    animations: sum.animations + Number(slide.hasAnimationTiming),
    images: sum.images + slide.elements.pictures,
    groups: sum.groups + slide.elements.groups
  }), { tables: 0, charts: 0, hyperlinks: 0, transitions: 0, animations: 0, images: 0, groups: 0 });

  return {
    formatVersion: 1,
    source: {
      filename: basename(absolutePath),
      absolutePath,
      bytes: inspection.sourceBytes,
      sha256: sha256(sourceBuffer)
    },
    package: {
      entries: inspection.entries.length,
      compressedBytes: inspection.compressedBytes,
      expandedBytes: inspection.expandedBytes
    },
    slideCount: slides.length,
    pageSize: parsePageSize(presentationXml),
    fonts: [...new Set(allXmlForFonts.flatMap(typefaces))].sort((a, b) => a.localeCompare(b)),
    masters,
    layouts,
    themes,
    slides,
    media,
    charts,
    notesSlides,
    embeddedObjects,
    externalRelationships,
    featureCounts,
    warnings
  };
}
