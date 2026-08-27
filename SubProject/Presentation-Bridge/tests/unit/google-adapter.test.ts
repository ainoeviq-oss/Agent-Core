import test from 'node:test';
import assert from 'node:assert/strict';
import { convertToGoogleSlides } from '../../src/converters/google/adapter.js';
import { GoogleRestClient } from '../../src/converters/google/rest.js';
import { GOOGLE_SLIDES_MIME, PPTX_MIME } from '../../src/converters/google/constants.js';
import { loadConfig } from '../../src/config/index.js';
import type { SourceManifest } from '../../src/types/contracts.js';

const manifest = {
  formatVersion: 1, source:{filename:'deck.pptx',absolutePath:'/deck.pptx',bytes:1,sha256:'x'}, package:{entries:1,compressedBytes:1,expandedBytes:1},
  slideCount:2,pageSize:{cxEmu:1,cyEmu:1,ratio:1},fonts:[],masters:[],layouts:[],themes:[],slides:[],media:[],charts:[],notesSlides:[],embeddedObjects:[],externalRelationships:[],
  featureCounts:{tables:0,charts:0,hyperlinks:0,transitions:0,animations:0,images:0,groups:0},warnings:[]
} satisfies SourceManifest;

function fakeClient(mimeType = GOOGLE_SLIDES_MIME): GoogleRestClient {
  return {
    aboutImportFormats: async () => ({ importFormats:{ [PPTX_MIME]:[GOOGLE_SLIDES_MIME] } }),
    createNativeSlidesFromPptx: async () => ({ id:'g123', name:'deck', mimeType, webViewLink:'https://docs.google.com/presentation/d/g123/edit' }),
    getPresentation: async () => ({ presentationId:'g123', slides:[{objectId:'s1'},{objectId:'s2'}] }),
    batchUpdate: async () => ({}),
    getThumbnail: async () => ({})
  } as unknown as GoogleRestClient;
}

test('Google live adapter sets native=true only after native MIME + Slides read', async () => {
  const result = await convertToGoogleSlides('/not-read-by-fake.pptx', manifest, fakeClient(), loadConfig('.'));
  assert.equal(result.status,'completed');
  assert.equal(result.native,true);
  assert.equal(result.verification,'live');
  assert.equal(result.fileId,'g123');
  assert.equal(result.slideCount,2);
});

test('Google live adapter rejects a non-native Drive target', async () => {
  const result = await convertToGoogleSlides('/not-read-by-fake.pptx', manifest, fakeClient(PPTX_MIME), loadConfig('.'));
  assert.equal(result.native,false);
  assert.equal(result.status,'failed');
  assert.equal(result.error?.code,'GOOGLE_TARGET_NOT_NATIVE');
});
