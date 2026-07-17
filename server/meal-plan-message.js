// Coach OS — Send meal plan PDF as Trainerize message attachment via Playwright
// Replaces the file.io URL approach. Attaches PDF directly to the client's message thread.

import { chromium } from 'playwright';
import fs from 'fs';

async function sendMealPlanViaMessage({ clientEmail, clientFullName, clientFirstName, pdfPath }) {
  if (!process.env.TRAINERIZE_WEB_EMAIL || !process.env.TRAINERIZE_WEB_PASSWORD) {
    return { ok: false, error: 'TRAINERIZE_WEB_EMAIL or TRAINERIZE_WEB_PASSWORD missing in env' };
  }
  if (!fs.existsSync(pdfPath)) {
    return { ok: false, error: `PDF not found: ${pdfPath}` };
  }
  if (!clientEmail && !clientFullName) {
    return { ok: false, error: 'clientEmail or clientFullName required to find the message thread' };
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    // 1. Login
    await page.goto('https://faerberfitness.trainerize.com/app/login', { waitUntil: 'domcontentloaded' });
    await page.getByTestId('email-input').fill(process.env.TRAINERIZE_WEB_EMAIL);
    await page.getByTestId('password-input').fill(process.env.TRAINERIZE_WEB_PASSWORD);
    await page.getByTestId('signIn-button').click();

    // Verify login succeeded by waiting for the nav menu to appear (max 30s)
    // Trainerize's messenger keeps websockets open so networkidle never resolves — wait for the nav element instead.
    const navOk = await page.getByTestId('leftNavMenu-item-messages').waitFor({ timeout: 30000 }).then(() => true).catch(() => false);
    if (!navOk) {
      throw new Error('Login failed — nav menu did not appear. Check TRAINERIZE_WEB_PASSWORD in env.');
    }

    // 2. Open Messages
    await page.getByTestId('leftNavMenu-item-messages').click();
    await page.waitForTimeout(2500);

    // 3. Click search icon to reveal search box
    await page.locator('.ant-input-prefix > .icon').click({ timeout: 8000 });
    await page.waitForTimeout(500);

    // 4. Search by client email (more reliable — handles name discrepancies)
    const searchTerm = clientEmail || clientFullName;
    const search = page.getByRole('textbox', { name: 'Search' });
    await search.fill(searchTerm);
    await search.press('Enter');
    await page.waitForTimeout(1800);

    // 5. Click the matching client — by name if known, else by email match
    const matchText = clientFullName || clientEmail;
    await page.getByText(matchText, { exact: false }).first().click({ timeout: 10000 });
    await page.waitForTimeout(2500);

    // 6. Trigger file chooser via paperclip icon + directly set the file (Playwright pattern)
    const [fileChooser] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: 15000 }),
      page.locator('span:nth-child(4) > .reactToolTip > .icon').click({ timeout: 8000 }),
    ]);
    await fileChooser.setFiles(pdfPath);
    await page.waitForTimeout(2000);

    // 7. Confirm the attach dialog → this sends the file
    await page.getByTestId('dialog-defaultFooter-confirm-button').click({ timeout: 8000 });
    await page.waitForTimeout(4000);

    await browser.close();
    return { ok: true };
  } catch (e) {
    let shotPath = null;
    try {
      shotPath = `/tmp/meal-plan-msg-error-${Date.now()}.png`;
      await page.screenshot({ path: shotPath, fullPage: true });
    } catch {}
    await browser.close().catch(() => {});
    return { ok: false, error: e.message, screenshot: shotPath };
  }
}

export { sendMealPlanViaMessage };
