import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import path from "node:path";

const base = process.env.README_CAPTURE_URL || "http://localhost:5173";
const output = path.resolve("docs/readme/ui");
await mkdir(output, { recursive: true });

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  deviceScaleFactor: 1,
});
await context.addInitScript(() => {
  localStorage.setItem("again-onboarding-complete", "true");
  const style = document.createElement("style");
  style.textContent =
    "*,*::before,*::after{animation-duration:0s!important;transition-duration:0s!important;scroll-behavior:auto!important}";
  document.documentElement.append(style);
});

const page = await context.newPage();
page.setDefaultTimeout(15_000);
await page.routeWebSocket(/spacetimedb/, (socket) => socket.close());

async function shot(name) {
  await page.screenshot({ path: path.join(output, name), animations: "disabled" });
  console.log(`captured ${name}`);
}

try {
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(900);
  await shot("01-lobby.png");

  await page.goto(`${base}/room/?template=1`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3500);
  await shot("02-floating-room.png");

  await page.goto(`${base}/library/?import=1`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(800);
  await shot("03-add-moments.png");

  await page.getByText("Connect your sources", { exact: true }).last().click();
  await page.waitForTimeout(350);
  await page.getByLabel("Album link").fill("https://photos.app.goo.gl/example");
  await page.getByLabel("Profile URL").fill("https://www.instagram.com/your-account/");
  await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
  await shot("04-google-photos-picker.png");

  const albumHeading = page.getByText("Shared Google Photos album", { exact: true });
  await albumHeading.scrollIntoViewIfNeeded();
  await page.getByLabel("Album link").fill("https://photos.app.goo.gl/example");
  await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
  await page.waitForTimeout(150);
  await shot("05-shared-album-consent.png");

  const socialHeading = page.getByText("Social memories", { exact: true });
  await socialHeading.scrollIntoViewIfNeeded();
  await page.mouse.move(730, 750);
  await page.mouse.wheel(0, 600);
  await page.getByLabel("Profile URL").fill("https://www.instagram.com/your-account/");
  await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
  await page.waitForTimeout(150);
  await shot("06-apify-authorization.png");

  // Upload only the repository's bundled Figma sample to this isolated local demo.
  const currentLibrary = await fetch(`${base}/api/memories`).then((response) =>
    response.json(),
  );
  const alreadyCapturedUpload = currentLibrary.memories?.some(
    (memory) => memory.source === "upload" && memory.title === "Pane 15",
  );
  if (!alreadyCapturedUpload) {
    await page.goto(`${base}/library/?import=1`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(450);
    const uploadRoute = "**/api/upload";
    await page.route(uploadRoute, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 900));
      await route.continue();
    });
    const uploadResponse = page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/api/upload",
      { timeout: 120_000 },
    );
    await page.locator('input[type="file"]').setInputFiles(
      path.resolve("public/images/memories/Pane 15.png"),
    );
    await page.getByText("Saving and understanding your memories…").waitFor();
    await shot("07-upload-processing.png");
    await uploadResponse;
    await page.unroute(uploadRoute);
    await page.getByText("Saving and understanding your memories…").waitFor({
      state: "detached",
      timeout: 120_000,
    });
  } else {
    await page.goto(`${base}/library/`, { waitUntil: "domcontentloaded" });
  }
  await page.waitForTimeout(500);
  await shot("08-memory-library.png");

  const uploaded = page.getByText("Pane 15", { exact: true }).last();
  await uploaded.click();
  await page.waitForTimeout(250);
  await shot("09-memory-detail.png");

  // Let the actual server build the requested scene; capture both the UI state
  // and the resulting renderer when local model inference finishes.
  await page.getByRole("button", { name: /Step inside this memory/ }).last().click();
  await page.getByText("Finding the space inside your photo.").waitFor();
  await shot("10-scene-request.png");
  await page.locator(".memory-world").waitFor({ timeout: 360_000 });
  await page.waitForTimeout(1800);
  await shot("11-reconstructed-memory.png");

  await page.goto(`${base}/library/`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(500);
  await page.getByText("Invite someone", { exact: true }).click();
  await page.waitForTimeout(300);
  await shot("12-multiplayer-invite.png");
} finally {
  await browser.close();
}
