import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createBackend } from '../server/app.js';

// Run after npm run build. Isolate storage and prevent native inference jobs.
const directory = await mkdtemp(path.join(os.tmpdir(), 'palace-route-check-'));
const backend = await createBackend({dataDir:directory, seed:[], env:{}, reconstruction:{reconstruct:async () => {throw new Error('Unexpected reconstruction');}}});
try {
  await new Promise<void>(resolve => backend.server.listen(0, '127.0.0.1', resolve));
  const address = backend.server.address() as {port:number};
  const base = `http://127.0.0.1:${address.port}`;
  for (const [route, marker] of [['/','id="home"'], ['/lobby/','id="home"'], ['/room/','id="scene"'], ['/library/','id="root"'], ['/preview/','Memory Palace']]) {
    const response = await fetch(base+route);
    assert.equal(response.status,200,route);
    const html = await response.text();
    assert.ok(html.includes(marker),`${route} serves the correct page`);
    for (const match of html.matchAll(/(?:src|href)="(\/assets\/[^" ]+)"/g)) {
      const asset = await fetch(base+match[1]);
      assert.equal(asset.status,200,match[1]);
      assert.ok(!asset.headers.get('content-type')?.includes('text/html'),`${match[1]} must not serve SPA fallback`);
      await asset.arrayBuffer();
    }
  }
  assert.equal((await fetch(base+'/api/unknown')).status,404);
  assert.deepEqual(await (await fetch(base+'/api/memories')).json(),{memories:[]});
  console.log('Production routes passed: lobby, room, library, preview, bundled assets and isolated API.');
} finally {
  await new Promise<void>(resolve => backend.server.close(() => resolve()));
  await rm(directory,{recursive:true,force:true});
}
