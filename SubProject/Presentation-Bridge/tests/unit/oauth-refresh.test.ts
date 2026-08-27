import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getGoogleAccessToken } from '../../src/converters/google/oauth.js';
import type { BridgeConfig } from '../../src/config/index.js';

test('expired Google access token refreshes without exposing refresh token', async () => {
  const dir = await mkdtemp(join(tmpdir(),'pb-oauth-'));
  const secrets = join(dir,'secrets'); await mkdir(secrets,{recursive:true});
  const cred = join(secrets,'client.json'); const token = join(secrets,'token.json');
  await writeFile(cred, JSON.stringify({installed:{client_id:'client',client_secret:'secret',auth_uri:'https://accounts.test/auth',token_uri:'https://oauth.test/token'}}));
  await writeFile(token, JSON.stringify({access_token:'<TEST_OLD_ACCESS_TOKEN>',refresh_token:'<TEST_REFRESH_TOKEN>',token_type:'Bearer',expires_at:0}));
  const config: BridgeConfig = { cwd:dir,runtimeRoot:join(dir,'runtime'),googleCredentialsPath:cred,googleTokenPath:token,keynoteWorker:'local',limits:{maxSourceBytes:1,maxExpandedBytes:1,maxEntryBytes:1,maxZipEntries:1} };
  const original = globalThis.fetch;
  let body = '';
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => { body = String(init?.body ?? ''); return new Response(JSON.stringify({access_token:'<TEST_ACCESS_TOKEN>',expires_in:3600,token_type:'Bearer'}),{status:200,headers:{'content-type':'application/json'}}); }) as typeof fetch;
  try {
    assert.equal(await getGoogleAccessToken(config),'<TEST_ACCESS_TOKEN>');
    assert.match(body,/refresh_token=%3CTEST_REFRESH_TOKEN%3E/);
    const saved = JSON.parse(await readFile(token,'utf8')) as {refresh_token:string;access_token:string};
    assert.equal(saved.refresh_token,'<TEST_REFRESH_TOKEN>');
    assert.equal(saved.access_token,'<TEST_ACCESS_TOKEN>');
  } finally { globalThis.fetch = original; }
});
