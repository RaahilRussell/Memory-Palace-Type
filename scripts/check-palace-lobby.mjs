import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';

const base = process.env.PALACE_URL || 'http://localhost:5180';
const browser = await chromium.launch({channel: 'chrome', headless: true});
const failures = [];
try {
  const page = await browser.newPage({viewport: {width: 1440, height: 1000}, reducedMotion: 'reduce'});
  page.on('pageerror', error => failures.push(error.message));
  let library = [];
  let offline = false;
  await page.route('**/api/memories', route => offline
    ? route.fulfill({status: 503, body: 'Unavailable'})
    : route.fulfill({json: {memories: library}}));
  await page.goto(`${base}/#moments`);
  await expect(page.locator('.memory-card')).toHaveCount(29);
  await page.getByRole('button', {name: 'Save Moment 01', exact: true}).click();
  await page.reload();
  await expect(page.getByRole('button', {name: 'Unsave Moment 01', exact: true})).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', {name: 'View Moment 01', exact: true}).click();
  await expect(page.locator('#enter-memory')).toBeHidden();
  await expect(page.locator('#photo-caption')).toContainText('Figma sample');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', {name: 'View Moment 01', exact: true})).toBeFocused();

  // A real string ID must not inherit a sample's numeric favorite.
  const title = '<img src=x onerror=alert(1)> Summer by the lake';
  library = [
    {id: '1', title, mediaType: 'image', url: '/images/memories/Pane%2001.png'},
    {id: 'video/with space?&', title: 'Birthday video', mediaType: 'video', thumbnailUrl: '/images/memories/Pane%2002.png'},
  ];
  await page.reload();
  await expect(page.locator('.memory-card')).toHaveCount(2);
  await expect(page.locator('#saved-count')).toHaveText('0');
  await expect(page.getByRole('button', {name: `Save ${title}`, exact: true})).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.card-bottom img')).toHaveCount(0);
  await page.getByRole('button', {name: `Save ${title}`, exact: true}).click();
  await page.reload();
  await expect(page.locator('#saved-count')).toHaveText('1');
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('mneme:lobby:favorites:v1'))), [1, '1']);
  await page.locator('#search').fill('Birthday');
  await expect(page.locator('.memory-card')).toHaveCount(1);
  await page.getByRole('button', {name: 'View Birthday video', exact: true}).click();
  await expect(page.locator('#enter-memory')).toHaveAttribute('href', '/library/?memory=video%2Fwith%20space%3F%26&from=lobby');
  await page.keyboard.press('Escape');
  await page.locator('#search').fill('missing title');
  await expect(page.locator('#empty')).toBeVisible();
  await page.locator('#reset-filter').click();
  await expect(page.locator('.memory-card')).toHaveCount(2);
  await page.locator('#saved-filter').click();
  await expect(page.locator('.memory-card')).toHaveCount(1);
  await page.getByRole('button', {name: `Unsave ${title}`, exact: true}).click();
  await expect(page.locator('#empty')).toBeVisible();
  await expect(page.locator('#reset-filter')).toBeFocused();

  for (const width of [320, 390, 768]) {
    await page.setViewportSize({width, height: 844});
    for (const hash of ['home', 'moments', 'design']) {
      await page.goto(`${base}/#${hash}`);
      await expect(page.locator('#room-status')).toHaveText('2 moments ready');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${width}px ${hash} overflow`);
    }
    await page.goto(`${base}/#moments`);
    await page.getByRole('button', {name: `View ${title}`, exact: true}).click();
    assert.equal(await page.locator('#photo-dialog').evaluate(el => el.scrollWidth > el.clientWidth), false, `${width}px modal overflow`);
    await page.keyboard.press('Escape');
  }
  await page.goto(`${base}/#home`);
  await expect(page.getByRole('link', {name: 'Add moments', exact: false})).toHaveAttribute('href', '/library/?import=1');
  await expect(page.getByRole('link', {name: 'Open library', exact: false})).toHaveAttribute('href', '/library/');
  await expect(page.locator('#home').getByRole('link', {name: 'Enter the room', exact: false})).toHaveAttribute('href', '/room/');
  assert.equal(await page.locator('.floating').first().evaluate(el => getComputedStyle(el).animationName), 'none');
  await page.goto(`${base}/#design`);
  await expect(page.getByRole('link', {name: 'Preview the template', exact: false})).toHaveAttribute('href', '/room/?template=1');

  offline = true;
  await page.goto(`${base}/lobby/#moments`);
  await expect(page.locator('#room-status')).toContainText('Library unavailable');
  await expect(page.locator('.memory-card')).toHaveCount(29);
  await expect(page.getByRole('button', {name: 'Unsave Moment 01', exact: true})).toHaveAttribute('aria-pressed', 'true');
  assert.deepEqual(failures, [], 'Unexpected browser errors');
  console.log('Lobby checks passed: samples, populated/offline library, numeric/string favorites, safe titles, memory links, search, focus, reduced motion, and 320/390/768 layouts.');
} finally {
  await browser.close();
}
