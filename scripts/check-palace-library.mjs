import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';

// Exercise the real React adapter with isolated APIs. The expensive world renderer
// is replaced at its module boundary; this test never runs inference or edits data.
const base = process.env.PALACE_URL || 'http://localhost:5180';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const photo = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="#dfbd85"/></svg>');
const memory = {
  id: 'memory/test ?#&', title: 'Sunny afternoon', date: '2026-06-01',
  location: 'Garden', description: 'A sample memory', tags: ['family'],
  source: 'upload', mediaType: 'image', url: photo, thumbnailUrl: photo,
};
const scene = {
  memoryId: memory.id, title: memory.title, description: memory.description,
  environment: 'garden', skyColor: '#ffeedd', floorColor: '#ccbbaa',
  accentColor: '#ddaabb', ambientLight: 1, generatedBy: 'fallback',
  depthLayers: [], objects: [],
};
const checks = [];

async function scenario(name, run) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  const errors = [];
  const unexpected = [];
  const state = { posts: 0, failScene: false, memoryReads: 0, gate: null };
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/src/components/MemoryWorld.tsx*', route => route.fulfill({
    contentType: 'application/javascript',
    body: `export default function MemoryWorld({memory,onReady}) {
      window.__renderedMemory = memory.id;
      if (!window.__worldReady) { window.__worldReady = true; setTimeout(onReady, 0); }
      return null;
    }`,
  }));
  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    let body;
    if (path === '/api/memories') {
      state.memoryReads++;
      if (state.gate) await state.gate;
      body = [memory];
    } else if (path === '/api/health') body = {};
    else if (path === '/api/chapters') body = [];
    else if (path === '/api/albums') body = { albums: [] };
    else if (path === '/api/folders') body = { folders: [] };
    else if (path === '/api/import-jobs') body = { jobs: [] };
    else if (path === `/api/memories/${encodeURIComponent(memory.id)}/scene`) {
      assert.equal(request.method(), 'POST');
      state.posts++;
      if (state.failScene) return route.fulfill({ status: 503, json: { error: 'Scene generation unavailable' } });
      body = { scene };
    } else {
      unexpected.push(`${request.method()} ${path}`);
      return route.fulfill({ status: 404, json: { error: 'Unexpected test request' } });
    }
    await route.fulfill({ json: body });
  });
  try {
    await run(page, state);
    assert.deepEqual(errors, [], 'No browser exceptions');
    assert.deepEqual(unexpected, [], 'No unexpected or live API calls');
    checks.push(name);
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(JSON.stringify({ name, errors, unexpected, posts: state.posts, alerts: await page.getByRole('alert').allTextContents() }, null, 2));
    throw error;
  } finally {
    await context.close();
  }
}

async function expectWorld(page, state, count = 1) {
  await expect.poll(() => page.evaluate(() => window.__renderedMemory)).toBe(memory.id);
  await expect(page.locator('.memory-portal')).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: 'Set up your memory library' })).toHaveCount(0);
  assert.equal(state.posts, count, 'Exactly one scene POST per explicit entry');
}

async function retryFromLibrary(page) {
  await page.locator('.memory-card').first().click();
  const enter = page.getByRole('dialog', { name: memory.title, exact: true }).getByRole('button', { name: 'Step inside this memory', exact: true });
  await expect(enter).toBeEnabled();
  await enter.click();
}

try {
  for (const from of ['room', 'lobby']) {
    await scenario(`deep link waits for refresh, enters once, returns to ${from}`, async (page, state) => {
      let release;
      state.gate = new Promise(resolve => { release = resolve; });
      await page.goto(`${base}/library/?memory=${encodeURIComponent(memory.id)}&from=${from}`);
      await expect.poll(() => state.memoryReads).toBeGreaterThan(0);
      assert.equal(state.posts, 0, 'No scene request before library refresh');
      release();
      await expectWorld(page, state);
      // A further UI render must not repeat the deep-link request.
      await page.getByRole('button', { name: 'Remember together', exact: true }).last().click();
      await expect(page.getByRole('dialog', { name: 'Remember together' })).toBeVisible();
      await page.getByRole('button', { name: 'Close dialog' }).click();
      assert.equal(state.posts, 1);
      // Assert browser destination without initializing a second WebGL room.
      await page.route(from === 'room' ? '**/room/' : '**/', route => {
        if (route.request().isNavigationRequest()) return route.fulfill({ contentType: 'text/html', body: '<h1>Return destination</h1>' });
        return route.continue();
      });
      await page.getByRole('button', { name: from === 'room' ? 'Back to floating room' : 'Back to moments', exact: true }).click();
      await expect(page).toHaveURL(`${base}${from === 'room' ? '/room/' : '/#moments'}`);
    });
  }

  await scenario('invalid memory stays recoverable without generation', async (page, state) => {
    await page.goto(`${base}/library/?memory=missing&from=room`);
    await expect(page.getByRole('alert')).toContainText('This memory is no longer in your library');
    assert.equal(state.posts, 0);
    await expect(page.getByRole('dialog', { name: 'Set up your memory library' })).toHaveCount(0);
    await expect(page.getByRole('navigation', { name: 'Memory Palace spaces' }).getByRole('link', { name: 'Floating room' })).toHaveAttribute('href', '/room/');
    await retryFromLibrary(page);
    await expectWorld(page, state);
  });

  await scenario('failed scene cancels transition and permits one manual retry', async (page, state) => {
    state.failScene = true;
    await page.goto(`${base}/library/?memory=${encodeURIComponent(memory.id)}&from=room`);
    await expect(page.getByRole('alert')).toContainText('Scene generation unavailable');
    await expect(page.locator('.memory-portal')).toHaveCount(0);
    assert.equal(state.posts, 1, 'Failure does not loop automatic retries');
    state.failScene = false;
    await retryFromLibrary(page);
    await expectWorld(page, state, 2);
    await expect(page.getByRole('alert')).toHaveCount(0);
  });

  await scenario('import link opens uploader without onboarding or generation', async (page, state) => {
    await page.goto(`${base}/library/?import=1`);
    await expect(page.getByRole('dialog', { name: 'Add memories' })).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'Set up your memory library' })).toHaveCount(0);
    assert.equal(state.posts, 0);
  });

  for (const path of ['/', '/library/']) {
    await scenario(`fresh-user invitation at ${path} reveals the join form without onboarding`, async (page, state) => {
      await page.goto(`${base}${path}?room=SUNNY123`);
      await expect(page).toHaveURL(`${base}/library/?room=SUNNY123`);
      assert.equal(await page.evaluate(() => localStorage.getItem('again-onboarding-complete')), null);
      await expect(page.getByRole('dialog', { name: 'Set up your memory library' })).toHaveCount(0);
      const dialog = page.getByRole('dialog', { name: 'Remember together' });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByLabel('Invitation code')).toHaveValue('SUNNY123');
      await expect(dialog.getByRole('button', { name: 'Join their memory' })).toBeEnabled();
      // A trial click checks that onboarding does not intercept the invitation.
      // It does not connect to a live room or perform a sharing action.
      await dialog.getByRole('button', { name: 'Join their memory' }).click({ trial: true });
      assert.equal(state.posts, 0);
    });
  }

  await scenario('root OAuth callback forwards query and onboarding to library', async (page, state) => {
    const query = '?google=connected&onboarding=google';
    await page.goto(`${base}/${query}`);
    await expect(page).toHaveURL(`${base}/library/${query}`);
    await expect(page.getByRole('dialog', { name: 'Set up your memory library' })).toBeVisible();
    assert.equal(state.posts, 0);
  });
  console.log(JSON.stringify({ passed: checks.length, checks }, null, 2));
} finally {
  await browser.close();
}
