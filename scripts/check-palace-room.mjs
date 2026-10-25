import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';

const base = process.env.PALACE_URL || 'http://localhost:5180';
const browser = await chromium.launch({channel:'chrome', headless:true, args:['--enable-webgl', '--ignore-gpu-blocklist']});
const errors = [];
async function selectWindow(page) {
  let hit = false;
  for (let y=250; y<550 && !hit; y+=65) {
    for (let x=400; x<1150 && !hit; x+=85) {
      await page.mouse.move(x,y);
      await page.waitForTimeout(60);
      if (await page.locator('#portal-hint').evaluate(el => el.classList.contains('visible'))) {
        await page.mouse.click(x,y); hit=true;
      }
    }
  }
  assert.ok(hit, 'A window should be selectable using the real pointer hit test');
  await page.waitForFunction(() => window.memoryRoom.selected !== null);
}
try {
  const page = await browser.newPage({viewport:{width:1440,height:1000}});
  page.on('pageerror', error => errors.push(error.message));
  let memories = [];
  await page.route('**/api/memories', route => route.fulfill({json:{memories}}));
  await page.goto(`${base}/room/`);
  await page.waitForFunction(() => window.memoryRoom?.count === 29);
  await page.waitForTimeout(1300);
  const moving = await page.evaluate(() => window.memoryRoom.poses);
  await page.waitForTimeout(400);
  assert.notDeepEqual(await page.evaluate(() => window.memoryRoom.poses), moving);
  await page.locator('#motion').click();
  assert.equal(await page.evaluate(() => window.memoryRoom.drifting), false);
  const paused = await page.evaluate(() => window.memoryRoom.poses);
  await page.waitForTimeout(250);
  assert.deepEqual(await page.evaluate(() => window.memoryRoom.poses), paused);
  await selectWindow(page);
  await expect(page.locator('#memory-caption')).toBeVisible();
  await expect(page.locator('#step-inside')).toBeHidden();
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => window.memoryRoom.selected), null);
  await page.locator('#enter-vr').click();
  await expect(page.locator('#toast')).toContainText(/headset|Quest/);
  await page.locator('#sound').click();
  await expect(page.locator('#sound')).toHaveAttribute('aria-pressed','true');
  await page.locator('#sound').click();
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.route('**/library/**', route => route.fulfill({body:'Library route reached',contentType:'text/html'}));
  await page.locator('#upload').click();
  await expect(page).toHaveURL(`${base}/library/?import=1`);

  memories = Array.from({length:29}, (_,i) => ({id:`real/${i}?&`,title:`Saved memory ${i}`,mediaType:'image',url:`/images/memories/Pane%20${String(i+1).padStart(2,'0')}.png`}));
  await page.setViewportSize({width:1440,height:1000});
  await page.goto(`${base}/room/`);
  await page.waitForFunction(() => window.memoryRoom?.count === 29);
  await page.waitForTimeout(1300);
  await selectWindow(page);
  const title = await page.evaluate(() => window.memoryRoom.selected);
  const selected = memories.find(memory => memory.title === title);
  assert.ok(selected);
  await page.locator('#step-inside').click();
  await expect(page).toHaveURL(`${base}/library/?memory=${encodeURIComponent(selected.id)}&from=room`);
  const reduced = await browser.newPage({reducedMotion:'reduce',viewport:{width:390,height:844}});
  reduced.on('pageerror', error => errors.push(error.message));
  await reduced.goto(`${base}/room/?template=1`);
  await reduced.waitForFunction(() => window.memoryRoom?.count === 29);
  assert.equal(await reduced.evaluate(() => window.memoryRoom.drifting), false);
  assert.deepEqual(errors, []);
  console.log('Room checks passed: 29 samples, drift/pause, pointer selection, return, sound, desktop VR fallback, mobile, reduced motion, durable import and encoded real-memory navigation.');
} finally { await browser.close(); }
