// Coach OS — Auto Meal Plan Generator (Bella template)
// 1. Sonnet picks 5 breakfasts / 5 cold lunches / 5 dinners / 6 snacks / 4 drinks + grocery
//    — respecting food_love / food_avoid / health flags / macros
// 2. Renders 3-page Bella-style PDF (warm cream + dusty mauve + Inter)
// 3. Saves to ~/Downloads/<First>_<Last>_Meal_Plan.pdf

import Anthropic from '@anthropic-ai/sdk';
import PDFDocument from 'pdfkit';
import fs from 'fs';
import path from 'path';
import os from 'os';

// ─── BRAND COLORS ─────────────────────────────────────────────────
const CREAM = '#fbfaf8';
const TEXT = '#1a1612';
const TEXT_DIM = '#5f5247';
const TEXT_MUTE = '#8a7d6f';
const BORDER = '#e8e2d6';
const MAUVE = '#c18b9d';
const MAUVE_DARK = '#9a6877';
const MAUVE_SOFT = '#f5e8ed';
const TILE_BG = '#ffffff';
const DARK = '#1f1d1a';

const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN = 54;
const CONTENT_W = PAGE_W - MARGIN * 2;

// ─── SONNET MEAL SELECTION ────────────────────────────────────────
async function pickMeals(intake, macros) {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const sys = `You are Zach Faerber's coaching nutrition AI. Build a meal plan for this client.

Output ONLY JSON with this shape:
{
  "subtitle": "<one short personal line — references their actual life>",
  "rules": [
    { "title": "<short rule>", "body": "<one-line context>" },
    { "title": "<short rule>", "body": "<one-line context>" },
    { "title": "<short rule>", "body": "<one-line context>" },
    { "title": "<short rule>", "body": "<one-line context>" }
  ],
  "breakfasts": [
    { "letter": "A", "tag": "<2-word descriptor>", "title": "<dish name ≤30 char>", "body": "<recipe with real ingredients + amounts + prep. 100-140 chars. Format: '4oz chicken breast, 1/2 cup jasmine rice, 1 cup spinach, 1 tbsp olive oil. Sear chicken 4min/side, wilt spinach, plate over rice.'>", "macros": "<cal · P · C · F like '500 · 36P · 30C · 24F'>" },
    ...5 total
  ],
  "lunches": [...5 same shape...],
  "dinners": [...5 same shape...],
  "snacks": [
    { "title": "<≤25 char>", "body": "<ingredients + amounts + prep. 90-125 chars. e.g. '3/4 cup Greek yogurt + 1 tbsp honey + 1/4 cup blueberries + 1 tbsp walnuts. Layer in glass.'>", "macros": "<cal · P · C · F>" },
    ...6 total
  ],
  "drinks": [
    { "title": "<full name — do NOT abbreviate. e.g. 'Apple Cider Vinegar Tonic' not 'ACV Tonic'. Max 28 chars.>", "body": "<amounts + prep + when + why. 75-95 chars.>" },
    ...4 total
  ],
  "grocery": [
    { "title": "PROTEIN", "items": [{"name":"<real grocery name — full, no abbreviations. Max 30 chars. e.g. 'Chicken breast', 'Ground turkey 93%', 'Wild salmon fillets'>","qty":"<amount w/ units. Max 14 chars. e.g. '3 lbs', '2 dozen', '1 quart'>"}, ...] },
    { "title": "CARBS", "items": [...] },
    { "title": "VEG + PANTRY", "items": [...] }
  ],
  "supplements": {
    "headline": "<2-4 word stack name ≤25 chars e.g. 'Foundational Stack' or 'Recovery + Energy'>",
    "subtitle": "<one short line ≤70 chars total. Punchy. e.g. 'Daily fuel + recovery for long shifts'>",
    "list": ["<supplement 1 e.g. Multi Vitamin>", "<2>", "<3>", "<4>"]
  },
  "avoid_note": "<one-sentence reminder of foods to avoid based on intake>"
}

GROCERY NAME RULES:
- Grocery item names must be ≤30 characters. Use full readable names: "Boneless chicken breast" is fine. "Ground turkey 93% lean". "Marinara sauce". No cryptic abbreviations.
- Qty must be ≤14 characters. "3 lbs", "2 dozen", "1 jar", "1 small bag", "1 quart carton".
- Cover EVERY ingredient referenced in the meal recipes above. Nothing missing.

RULES:
- Total daily macros must approximate the target: ${macros.caloricGoal} cal / ${macros.proteinGrams}g P
- 4 rules tailored to THIS client's struggles + lifestyle, not generic.
- Breakfasts/lunches/dinners must each be ~${Math.round(macros.caloricGoal / 4)} cal w/ ~${Math.round(macros.proteinGrams / 4)}g protein. Snack ~250 cal / 20g protein.
- Respect every food they LOVE (include at least 3 across meals).
- Respect every food they AVOID (allergies, religious, dietary, flag-based — skip ALL of them).
- Honor health flags: pregnant/postpartum → high fiber + iron; diabetic → low GI carbs; perimenopause → protein-forward; autoimmune → anti-inflammatory.
- Voice: Zach's coaching voice. Casual specific (not generic fitness app language).

LIFESTYLE FIT (CRITICAL):
- Read their work schedule from typical_weekday + availability. If they work long hours / odd hours / travel, prioritize options that survive that reality.
- Use the meal "tag" field to mark practical use: "GRAB & GO", "MEAL PREP", "5 MIN", "PORTABLE", "POST-WORK", "FAMILY MEAL", "ON THE JOB", "QUICK RECOVERY".
- At least 2 of every 5 meals should be GRAB & GO or MEAL PREP friendly for busy clients.
- Snacks should ALL be grab-and-go (no cooking).

SUPPLEMENT STACK:
- Pick 3-5 supplements based on goals + health flags + current meds (avoid conflicts).
- Common starter stack: Multi Vitamin + Whey Protein + Omega-3 + Creatine + Vitamin D3.
- Modify for flags: pregnant → SKIP creatine + check w/ doctor; perimeno → add Magnesium Glycinate + D3K2; bloodwork-pending → minimal stack until labs come back.
- Headline should hint at why (e.g. "Recovery + Energy Foundation" or "Postpartum Repair Stack" or "Hormone Reset").`;

  const user = `# Client
Name: ${intake.full_name}
Age: ${intake.age} · Gender: ${intake.gender}
Current weight: ${intake.weight_lb}lb → Goal: ${intake.goal_weight_lb}lb
Goal type: ${intake.goal_type}
Why now: ${intake.why_now}

# Macros target
${macros.caloricGoal} cal · ${macros.proteinGrams}g P · ${macros.carbsGrams}g C · ${macros.fatGrams}g F

# Nutrition context
Food relationship: ${intake.food_relationship}
LOVES (include these): ${intake.food_love}
AVOIDS (exclude all of these): ${intake.food_avoid}
Typical day: ${intake.typical_day}

# Health flags: ${(intake.flags || []).join(', ') || 'none'}
# Other condition: ${intake.other_condition || 'none'}
# Meds + supplements: ${intake.meds || '—'}

# Lifestyle
Sleep: ${intake.sleep_hrs}h / ${intake.sleep_quality} quality
Stress: ${intake.stress}
Typical weekday: ${intake.typical_weekday}

Output the JSON now.`;

  const resp = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 6000,
    system: sys,
    messages: [{ role: 'user', content: user }],
  });
  const text = resp.content?.[0]?.text || '';
  const s = text.indexOf('{');
  const e = text.lastIndexOf('}');
  if (s < 0 || e < 0) throw new Error('No JSON in Sonnet meal plan response');
  return JSON.parse(text.slice(s, e + 1));
}

// ─── PDF PAGE PRIMITIVES ──────────────────────────────────────────
function startPage(doc, phase, location) {
  doc.save();
  doc.rect(0, 0, PAGE_W, PAGE_H).fill(CREAM);
  doc.restore();
  doc.font('Helvetica-Bold').fontSize(20).fillColor(MAUVE).text('B', MARGIN, MARGIN);
  doc.font('Helvetica').fontSize(8).fillColor(TEXT)
    .text('T H E   B A L A N C E D   B L U E P R I N T', MARGIN, MARGIN + 24, { characterSpacing: 1 });
  doc.font('Helvetica').fontSize(8).fillColor(TEXT_DIM)
    .text(phase, MARGIN, MARGIN + 4, { width: CONTENT_W, align: 'right', characterSpacing: 1.5 });
  doc.font('Helvetica').fontSize(8).fillColor(TEXT_DIM)
    .text(location, MARGIN, MARGIN + 16, { width: CONTENT_W, align: 'right', characterSpacing: 1.5 });
  doc.strokeColor(BORDER).lineWidth(0.75)
    .moveTo(MARGIN, MARGIN + 42).lineTo(PAGE_W - MARGIN, MARGIN + 42).stroke();
  return MARGIN + 56;
}
function endPage(doc, pageNum, total, footerLabel) {
  const y = PAGE_H - 68;
  doc.strokeColor(BORDER).lineWidth(0.5).moveTo(MARGIN, y - 8).lineTo(PAGE_W - MARGIN, y - 8).stroke();
  doc.font('Helvetica').fontSize(8).fillColor(MAUVE)
    .text(`THE BALANCED BLUEPRINT  ·  ${footerLabel}`, MARGIN, y, { characterSpacing: 1, lineBreak: false });
  doc.font('Helvetica').fontSize(8).fillColor(TEXT_DIM)
    .text(`${pageNum} / ${total}`, MARGIN, y, { width: CONTENT_W, align: 'right', lineBreak: false });
}
function pSectionLabel(doc, y, t) {
  const safe = String(t || '').slice(0, 60);
  doc.font('Helvetica-Bold').fontSize(9).fillColor(MAUVE)
    .text(safe, MARGIN, y, { characterSpacing: 2, lineBreak: false, width: CONTENT_W, height: 14, ellipsis: true });
  return y + 16;
}
function pBigName(doc, y, first, last) {
  const f = String(first || '').slice(0, 14);
  const l = String(last || '').slice(0, 16);
  doc.font('Helvetica-Bold').fontSize(42).fillColor(TEXT)
    .text(f + ' ', MARGIN, y, { continued: true, lineBreak: false });
  doc.font('Helvetica-BoldOblique').fontSize(42).fillColor(MAUVE)
    .text(l + '.', { lineBreak: false });
  return y + 50;
}
function pSubtitle(doc, y, text) {
  const safe = String(text || '').slice(0, 160);
  doc.font('Helvetica').fontSize(10.5).fillColor(TEXT_DIM)
    .text(safe, MARGIN, y, { width: CONTENT_W, lineGap: 2, height: 36, ellipsis: true });
  return y + 30;
}
function pMacroBar(doc, y, t) {
  const h = 60;
  doc.save();
  doc.roundedRect(MARGIN, y, CONTENT_W, h, 4).fill(DARK);
  doc.restore();
  const cols = [
    { v: String(t.caloricGoal), l: 'CALORIES' },
    { v: t.proteinGrams + 'g', l: 'PROTEIN FLOOR' },
    { v: '~' + t.carbsGrams + 'g', l: 'CARBS' },
    { v: '~' + t.fatGrams + 'g', l: 'FATS' },
  ];
  const colW = CONTENT_W / cols.length;
  cols.forEach((c, i) => {
    const x = MARGIN + i * colW;
    doc.font('Helvetica-Bold').fontSize(22).fillColor(CREAM)
      .text(c.v, x, y + 12, { width: colW, align: 'center', lineBreak: false });
    doc.font('Helvetica').fontSize(8).fillColor('#bcb3a3')
      .text(c.l, x, y + 40, { width: colW, align: 'center', characterSpacing: 1.5, lineBreak: false });
  });
  return y + h + 12;
}
function pRulesGrid(doc, y, rules) {
  const gap = 6;
  const colW = (CONTENT_W - gap) / 2;
  const cellH = 42;
  const trunc = (s, n) => { const t = String(s || ''); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
  const rows = Math.ceil(rules.length / 2);
  rules.forEach((r, i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const x = MARGIN + col * (colW + gap);
    const yy = y + row * (cellH + gap);
    doc.save();
    doc.roundedRect(x, yy, colW, cellH, 4).fill(TILE_BG);
    doc.strokeColor(BORDER).lineWidth(0.5).roundedRect(x, yy, colW, cellH, 4).stroke();
    doc.restore();
    doc.font('Helvetica-Bold').fontSize(8).fillColor(MAUVE)
      .text(String(i + 1).padStart(2, '0'), x + 12, yy + 9, { width: 20, characterSpacing: 1.5, lineBreak: false });
    doc.font('Helvetica-Bold').fontSize(10).fillColor(TEXT)
      .text(trunc(r.title, 40), x + 36, yy + 8, { width: colW - 48, height: 14, lineBreak: false, ellipsis: true });
    doc.font('Helvetica').fontSize(8).fillColor(TEXT_DIM)
      .text(String(r.body || ''), x + 36, yy + 22, { width: colW - 48, lineGap: 1.5, height: cellH - 26 });
  });
  return y + rows * (cellH + gap) + 4;
}
function pMealHeader(doc, y, label, target) {
  const lab = String(label || '').slice(0, 50);
  const tgt = String(target || '').slice(0, 50);
  doc.font('Helvetica-Bold').fontSize(11.5).fillColor(TEXT)
    .text(lab, MARGIN, y, { width: CONTENT_W * 0.65, lineBreak: false, height: 16, ellipsis: true });
  doc.font('Helvetica').fontSize(8).fillColor(MAUVE)
    .text(tgt, MARGIN, y + 3, { width: CONTENT_W, align: 'right', characterSpacing: 1, lineBreak: false, height: 14, ellipsis: true });
  return y + 22;
}
function pMealGrid5(doc, y, meals) {
  const gap = 5;
  const colW = (CONTENT_W - gap * 4) / 5;
  const cardH = 146;
  const trunc = (s, n) => { const t = String(s || ''); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
  // Width-aware title fitter — measures with current font + ellipsis if too wide for available area (2 lines)
  const fitTitle = (s, font, size, maxLines, maxW) => {
    const t = String(s || '').trim();
    doc.font(font).fontSize(size);
    if (doc.widthOfString(t) <= maxW * maxLines * 0.95) {
      // Strip trailing connectors even if it fits
      return t.replace(/\s+(and|with|w|&|\+|the|of|to|in|on|for|or)$/i, '');
    }
    // Binary-truncate to fit total chars across maxLines
    let lo = 1, hi = t.length, best = t;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      let cand = t.slice(0, mid);
      cand = cand.replace(/[\s,&+/\\-]+$/g, '');
      cand = cand.replace(/\s+(and|with|w|the|a|an|of|to|in|on|for|or)$/i, '');
      cand = cand.replace(/[\s,&+/\\-]+$/g, '');
      const candE = cand + '…';
      if (doc.widthOfString(candE) <= maxW * maxLines * 0.95) {
        best = candE; lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return best;
  };
  meals.forEach((m, i) => {
    const x = MARGIN + i * (colW + gap);
    doc.save();
    doc.roundedRect(x, y, colW, cardH, 4).fill(TILE_BG);
    doc.strokeColor(BORDER).lineWidth(0.5).roundedRect(x, y, colW, cardH, 4).stroke();
    doc.restore();
    doc.font('Helvetica-Bold').fontSize(7).fillColor(MAUVE)
      .text(trunc(`${m.letter} · ${m.tag}`, 14), x + 7, y + 8, { width: colW - 14, height: 10, characterSpacing: 0.8, lineBreak: false, ellipsis: true });
    doc.font('Helvetica-Bold').fontSize(9).fillColor(TEXT)
      .text(fitTitle(m.title, 'Helvetica-Bold', 9, 2, colW - 14), x + 7, y + 21, { width: colW - 14, height: 22, lineGap: 1, ellipsis: true });
    doc.font('Helvetica').fontSize(8).fillColor(TEXT_DIM)
      .text(String(m.body || ''), x + 7, y + 48, { width: colW - 14, height: cardH - 62, lineGap: 1.4 });
    doc.font('Helvetica-Bold').fontSize(7).fillColor(TEXT)
      .text(trunc(m.macros, 24), x + 7, y + cardH - 12, { width: colW - 14, lineBreak: false });
  });
  return y + cardH + 12;
}
function pSnackGrid6(doc, y, snacks) {
  const gap = 8;
  const colW = (CONTENT_W - gap * 2) / 3;
  const cardH = 92;
  const trunc = (s, n) => { const t = String(s || ''); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
  const fitTitle = (s, font, size, maxLines, maxW) => {
    const t = String(s || '').trim();
    doc.font(font).fontSize(size);
    if (doc.widthOfString(t) <= maxW * maxLines * 0.95) {
      return t.replace(/\s+(and|with|w|&|\+|the|of|to|in|on|for|or)$/i, '');
    }
    let lo = 1, hi = t.length, best = t;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      let cand = t.slice(0, mid);
      cand = cand.replace(/[\s,&+/\\-]+$/g, '');
      cand = cand.replace(/\s+(and|with|w|the|a|an|of|to|in|on|for|or)$/i, '');
      cand = cand.replace(/[\s,&+/\\-]+$/g, '');
      const candE = cand + '…';
      if (doc.widthOfString(candE) <= maxW * maxLines * 0.95) {
        best = candE; lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return best;
  };
  snacks.forEach((s, i) => {
    const col = i % 3;
    const row = Math.floor(i / 3);
    const x = MARGIN + col * (colW + gap);
    const yy = y + row * (cardH + gap);
    doc.save();
    doc.roundedRect(x, yy, colW, cardH, 4).fill(TILE_BG);
    doc.strokeColor(BORDER).lineWidth(0.5).roundedRect(x, yy, colW, cardH, 4).stroke();
    doc.restore();
    doc.font('Helvetica-Bold').fontSize(7).fillColor(MAUVE)
      .text(`SNACK ${i + 1}`, x + 9, yy + 7, { characterSpacing: 1, lineBreak: false });
    doc.font('Helvetica-Bold').fontSize(10).fillColor(TEXT)
      .text(fitTitle(s.title, 'Helvetica-Bold', 10, 1, colW - 18), x + 9, yy + 19, { width: colW - 18, height: 14, lineBreak: false, ellipsis: true });
    doc.font('Helvetica').fontSize(8).fillColor(TEXT_DIM)
      .text(String(s.body || ''), x + 9, yy + 33, { width: colW - 18, height: cardH - 46, lineGap: 1.3 });
    doc.font('Helvetica-Bold').fontSize(7).fillColor(TEXT)
      .text(trunc(s.macros, 28), x + 9, yy + cardH - 11, { width: colW - 18, lineBreak: false });
  });
  return y + 2 * (cardH + gap) + 4;
}
function pDrinkGrid(doc, y, drinks) {
  const gap = 6;
  const colW = (CONTENT_W - gap * 3) / 4;
  const cardH = 78;
  const trunc = (s, n) => { const t = String(s || ''); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
  drinks.forEach((d, i) => {
    const x = MARGIN + i * (colW + gap);
    doc.save();
    doc.roundedRect(x, y, colW, cardH, 4).fill(TILE_BG);
    doc.strokeColor(BORDER).lineWidth(0.5).roundedRect(x, y, colW, cardH, 4).stroke();
    doc.restore();
    doc.font('Helvetica-Bold').fontSize(9).fillColor(TEXT)
      .text(String(d.title || ''), x + 6, y + 8, { width: colW - 12, align: 'center', height: 24, lineGap: 1, ellipsis: true });
    doc.font('Helvetica').fontSize(7.5).fillColor(TEXT_DIM)
      .text(String(d.body || ''), x + 6, y + 30, { width: colW - 12, align: 'center', height: cardH - 34, lineGap: 1.3 });
  });
  return y + cardH + 10;
}
function pParagraph(doc, y, text) {
  const safe = String(text || '').slice(0, 280);
  doc.font('Helvetica').fontSize(9).fillColor(TEXT_DIM)
    .text(safe, MARGIN, y, { width: CONTENT_W, lineGap: 2.5, height: 40, ellipsis: true });
  return doc.y + 8;
}

function pSupplementCard(doc, y, supplements) {
  if (!supplements) return y;
  const h = 92;
  doc.save();
  doc.roundedRect(MARGIN, y, CONTENT_W, h, 6).fill(MAUVE_SOFT);
  doc.strokeColor(MAUVE).lineWidth(0.5).roundedRect(MARGIN, y, CONTENT_W, h, 6).stroke();
  doc.restore();
  const headline = (supplements.headline || 'Foundational Stack').slice(0, 30);
  const subtitle = (supplements.subtitle || '').slice(0, 75);
  const listStr = (supplements.list || []).join('  ·  ').slice(0, 90);
  doc.font('Helvetica-Bold').fontSize(8).fillColor(MAUVE_DARK)
    .text('YOUR STARTER SUPPLEMENT STACK', MARGIN + 18, y + 12, { characterSpacing: 1.5, lineBreak: false });
  doc.font('Helvetica-Bold').fontSize(13).fillColor(TEXT)
    .text(headline, MARGIN + 18, y + 26, { width: CONTENT_W - 180, height: 16, lineBreak: false, ellipsis: true });
  doc.font('Helvetica').fontSize(8.5).fillColor(TEXT_DIM)
    .text(subtitle, MARGIN + 18, y + 46, { width: CONTENT_W - 180, height: 12, lineBreak: false, ellipsis: true });
  doc.font('Helvetica').fontSize(8).fillColor(MAUVE_DARK)
    .text(listStr, MARGIN + 18, y + 66, { width: CONTENT_W - 180, height: 12, ellipsis: true, lineBreak: false });
  const btnW = 130;
  const btnH = 32;
  const btnX = MARGIN + CONTENT_W - btnW - 18;
  const btnY = y + (h - btnH) / 2;
  doc.save();
  doc.roundedRect(btnX, btnY, btnW, btnH, 16).fill(MAUVE);
  doc.restore();
  doc.font('Helvetica-Bold').fontSize(10).fillColor(CREAM)
    .text('Open the Stack', btnX, btnY + 10, { width: btnW, align: 'center', lineBreak: false });
  doc.link(btnX, btnY, btnW, btnH, 'https://balance-blueprint-supplements.netlify.app');
  return y + h + 14;
}
function pGroceryGrid(doc, y, columns) {
  const gap = 10;
  const colW = (CONTENT_W - gap * 2) / 3;
  const cardPad = 12;
  const rowH = 24;
  const headerH = 24;
  const qtyW = 54;
  const maxItems = Math.max(...columns.map(c => c.items.length));
  const cardH = headerH + maxItems * rowH + cardPad;
  columns.forEach((col, i) => {
    const x = MARGIN + i * (colW + gap);
    doc.save();
    doc.roundedRect(x, y, colW, cardH, 4).fill(TILE_BG);
    doc.strokeColor(BORDER).lineWidth(0.5).roundedRect(x, y, colW, cardH, 4).stroke();
    doc.restore();
    doc.font('Helvetica-Bold').fontSize(8).fillColor(MAUVE)
      .text(col.title, x + cardPad, y + 10, { characterSpacing: 1.5, lineBreak: false });
    col.items.forEach((it, j) => {
      const itemY = y + headerH + j * rowH;
      const name = String(it.name || '');
      const qty = String(it.qty || '');
      doc.font('Helvetica').fontSize(8).fillColor(TEXT)
        .text(name, x + cardPad, itemY, { width: colW - cardPad * 2 - qtyW - 4, height: rowH - 2, lineGap: 1 });
      doc.font('Helvetica').fontSize(7.5).fillColor(TEXT_MUTE)
        .text(qty, x + colW - cardPad - qtyW, itemY + 2, { width: qtyW, align: 'right', height: rowH - 2, lineGap: 1 });
    });
  });
  return y + cardH + 12;
}

// ─── BUILD PDF ────────────────────────────────────────────────────
function buildPDF({ intake, macros, plan, outputPath }) {
  const [first, ...rest] = intake.full_name.trim().split(/\s+/);
  const last = rest.join(' ') || '';
  const firstU = first.toUpperCase();
  const lastU = last.toUpperCase();
  const phase = 'CUSTOM MEAL PLAN';
  const location = (intake.city || '').toUpperCase();
  const footerLabel = `${firstU}'S MEAL PLAN`;
  const hasSuppPage = !!(plan.supplements && Array.isArray(plan.supplements.details) && plan.supplements.details.length);
  const TOTAL = hasSuppPage ? 4 : 3;

  return new Promise((resolve, reject) => {
    const stream = fs.createWriteStream(outputPath);
    const doc = new PDFDocument({
      size: 'LETTER',
      margins: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
      autoFirstPage: false,
    });
    doc.pipe(stream);

    // PAGE 1
    doc.addPage();
    let y = startPage(doc, phase, location);
    y = pSectionLabel(doc, y, 'YOUR MEAL PLAN');
    y = pBigName(doc, y, firstU, lastU);
    y = pSubtitle(doc, y, plan.subtitle || 'Pick one breakfast, lunch, dinner, one snack. Hit your protein floor every day.');
    y = pMacroBar(doc, y, macros);
    y = pRulesGrid(doc, y, plan.rules || []);
    y = pMealHeader(doc, y, 'Breakfast — pick one', `TARGET: ~${Math.round(macros.caloricGoal / 4)} CAL · ${Math.round(macros.proteinGrams / 4)}G P`);
    y = pMealGrid5(doc, y, plan.breakfasts || []);
    y = pMealHeader(doc, y, 'Lunch — pick one', `TARGET: ~${Math.round(macros.caloricGoal / 4)} CAL · ${Math.round(macros.proteinGrams / 4)}G P`);
    y = pMealGrid5(doc, y, plan.lunches || []);
    endPage(doc, 1, TOTAL, footerLabel);

    // PAGE 2
    doc.addPage();
    y = startPage(doc, phase, location);
    y = pMealHeader(doc, y, 'Dinner — pick one', `TARGET: ~${Math.round(macros.caloricGoal / 4)} CAL · ${Math.round(macros.proteinGrams / 4)}G P`);
    y = pMealGrid5(doc, y, plan.dinners || []);
    y = pMealHeader(doc, y, 'Snack — pick one', 'TARGET: ~250 CAL · 20G P');
    y = pSnackGrid6(doc, y, plan.snacks || []);
    y = pMealHeader(doc, y, 'Drinks — what to sip on', 'HYDRATION + LOW-CAL OPTIONS');
    y = pDrinkGrid(doc, y, plan.drinks || []);
    endPage(doc, 2, TOTAL, footerLabel);

    // PAGE 3
    doc.addPage();
    y = startPage(doc, phase, location);
    // Only show generic starter stack card if we are NOT shipping a bloodwork-driven protocol page
    if (plan.supplements && !hasSuppPage) y = pSupplementCard(doc, y, plan.supplements);
    y = pSectionLabel(doc, y, 'GROCERY LIST  ·  1 WEEK');
    y = pGroceryGrid(doc, y, plan.grocery || []);
    endPage(doc, 3, TOTAL, footerLabel);

    // PAGE 4 — Supplement Protocol (bloodwork-driven only)
    if (hasSuppPage) {
      doc.addPage();
      y = startPage(doc, phase, location);
      y = pSectionLabel(doc, y, 'SUPPLEMENT PROTOCOL  ·  BLOODWORK-DRIVEN');
      doc.font('Helvetica-Bold').fontSize(28).fillColor(TEXT)
        .text('Your Stack.', MARGIN, y);
      y += 38;
      doc.font('Helvetica').fontSize(10).fillColor(TEXT_DIM)
        .text(plan.supplements.subtitle || 'Each one targets a specific flag on your panel.',
          MARGIN, y, { width: CONTENT_W, lineGap: 2 });
      y += 28;

      const rows = plan.supplements.details;
      const nameW = 130;
      const whenW = 110;
      const linkW = 75;
      const whyX = MARGIN + nameW + whenW + 16;
      const whyW = CONTENT_W - (whyX - MARGIN) - linkW - 12;
      const linkX = MARGIN + CONTENT_W - linkW;
      const minRowH = 36;
      const padTop = 10;
      const padBot = 12;
      for (const it of rows) {
        // measure max height needed across columns for this row
        const whyStr = String(it.why || '');
        const nameStr = String(it.name || '');
        const whenStr = String(it.when || '');
        doc.font('Helvetica-Bold').fontSize(11);
        const nameH = doc.heightOfString(nameStr, { width: nameW, lineGap: 1 });
        doc.font('Helvetica').fontSize(9);
        const whenH = doc.heightOfString(whenStr, { width: whenW, lineGap: 1 });
        const whyH = doc.heightOfString(whyStr, { width: whyW, lineGap: 2 });
        const rowH = Math.max(minRowH, padTop + Math.max(nameH, whenH, whyH) + padBot);

        // separator at top
        doc.strokeColor(BORDER).lineWidth(0.5)
          .moveTo(MARGIN, y).lineTo(MARGIN + CONTENT_W, y).stroke();
        const ry = y + padTop;
        doc.font('Helvetica-Bold').fontSize(11).fillColor(TEXT)
          .text(nameStr, MARGIN, ry, { width: nameW, lineGap: 1 });
        doc.font('Helvetica').fontSize(9).fillColor(TEXT_DIM)
          .text(whenStr, MARGIN + nameW + 12, ry + 2, { width: whenW, lineGap: 1 });
        doc.font('Helvetica').fontSize(9).fillColor(TEXT_DIM)
          .text(whyStr, whyX, ry + 2, { width: whyW, lineGap: 2 });
        if (it.link) {
          doc.font('Helvetica-Bold').fontSize(9).fillColor(MAUVE_DARK)
            .text('Order here', linkX, ry + 2, { width: linkW, align: 'right', underline: true, link: it.link, lineBreak: false });
        }
        y += rowH;
      }

      endPage(doc, 4, TOTAL, footerLabel);
    }

    doc.end();
    stream.on('finish', () => resolve(outputPath));
    stream.on('error', reject);
  });
}

// ─── MAIN ─────────────────────────────────────────────────────────
async function generateMealPlan({ intake, macros }) {
  const slug = (intake.full_name || 'Client').replace(/\s+/g, '_').replace(/[^A-Za-z0-9_]/g, '');
  const outputPath = path.join(os.homedir(), 'Downloads', `${slug}_Meal_Plan.pdf`);
  const plan = await pickMeals(intake, macros);
  // Enforce exact array sizes — Sonnet sometimes overshoots/undershoots
  plan.rules = (plan.rules || []).slice(0, 4);
  while (plan.rules.length < 4) plan.rules.push({ title: '', body: '' });
  plan.breakfasts = (plan.breakfasts || []).slice(0, 5);
  plan.lunches = (plan.lunches || []).slice(0, 5);
  plan.dinners = (plan.dinners || []).slice(0, 5);
  plan.snacks = (plan.snacks || []).slice(0, 6);
  plan.drinks = (plan.drinks || []).slice(0, 4);
  plan.grocery = (plan.grocery || []).slice(0, 3);
  await buildPDF({ intake, macros, plan, outputPath });
  return { ok: true, path: outputPath, plan };
}

export { generateMealPlan, pickMeals, buildPDF };
