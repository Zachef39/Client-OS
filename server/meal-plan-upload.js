// Coach OS — Playwright Trainerize meal-plan uploader
// Headless Chromium logs in, finds client, deletes existing meal plan if present,
// uploads the new PDF, confirms. Returns { ok, error? }

import { chromium } from 'playwright';
import fs from 'fs';

async function uploadMealPlan({ clientEmail, pdfPath }) {
  if (!process.env.TRAINERIZE_WEB_EMAIL || !process.env.TRAINERIZE_WEB_PASSWORD) {
    return { ok: false, error: 'TRAINERIZE_WEB_EMAIL or TRAINERIZE_WEB_PASSWORD missing in env' };
  }
  if (!fs.existsSync(pdfPath)) {
    return { ok: false, error: `PDF not found: ${pdfPath}` };
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    acceptDownloads: false,
  });
  const page = await context.newPage();

  try {
    // 1. Login
    await page.goto('https://faerberfitness.trainerize.com/app/login', { waitUntil: 'domcontentloaded' });
    await page.getByTestId('email-input').fill(process.env.TRAINERIZE_WEB_EMAIL);
    await page.getByTestId('password-input').fill(process.env.TRAINERIZE_WEB_PASSWORD);
    await page.getByTestId('signIn-button').click();

    const navOk = await page.getByTestId('leftNavMenu-item-clients').waitFor({ timeout: 30000 }).then(() => true).catch(() => false);
    if (!navOk) {
      throw new Error('Login failed — nav menu did not appear. Check TRAINERIZE_WEB_PASSWORD in env.');
    }

    // 2. Open Clients
    await page.getByTestId('leftNavMenu-item-clients').click();
    await page.waitForTimeout(2500);

    // 3. Search by email — try multiple selectors since Trainerize labels shift
    const searchInput = page.locator('input[placeholder*="Find a client" i], input[placeholder*="Search" i]').first();
    await searchInput.waitFor({ timeout: 15000 });
    await searchInput.fill(clientEmail);
    await searchInput.press('Enter');
    await page.waitForTimeout(2500);

    // 4. Click "OPEN" (switch into client) — opens a popup
    const popupPromise = page.waitForEvent('popup', { timeout: 15000 });
    await page.getByTestId('leftNavMenu-menu').getByRole('button', { name: 'OPEN' }).click();
    const clientPage = await popupPromise;
    await clientPage.getByTestId('leftNavMenu-item-mealPlan').waitFor({ timeout: 30000 });

    // 5. Navigate to Meal Plan section
    await clientPage.getByTestId('leftNavMenu-item-mealPlan').click();
    await clientPage.waitForTimeout(2500);

    // 6. Delete existing plan if present (best effort — may not exist)
    const deleteBtn = clientPage.getByTestId('mealPlanToolbar-delete-button');
    if (await deleteBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await deleteBtn.click();
      await clientPage.getByTestId('dialog-defaultFooter-confirm-button').click();
      await clientPage.waitForTimeout(1500);
    }

    // 7. Trigger file chooser via upload button (filechooser event pattern)
    const [fileChooser] = await Promise.all([
      clientPage.waitForEvent('filechooser', { timeout: 15000 }),
      clientPage.getByText('Attach a meal plan PDF', { exact: false }).first().click().catch(async () => {
        await clientPage.getByRole('button', { name: /select|attach/i }).first().click();
      }),
    ]);
    await fileChooser.setFiles(pdfPath);
    await clientPage.waitForTimeout(2500);

    // 9. Confirm
    await clientPage.getByTestId('dialog-defaultFooter-confirm-button').click();
    await clientPage.waitForTimeout(4000);

    await browser.close();
    return { ok: true, pdfPath };
  } catch (e) {
    // Screenshot for diagnosis
    let shotPath = null;
    try {
      shotPath = `/tmp/meal-plan-upload-error-${Date.now()}.png`;
      await page.screenshot({ path: shotPath, fullPage: true });
    } catch {}
    await browser.close().catch(() => {});
    return { ok: false, error: e.message, screenshot: shotPath };
  }
}

export { uploadMealPlan };
