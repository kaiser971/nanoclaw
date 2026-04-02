/**
 * LeHibou scraper — uses Playwright with a visible browser.
 *
 * Usage:
 *   npx tsx scripts/lehibou-scrape.ts            # Opens browser, scrape after challenge
 *   npx tsx scripts/lehibou-scrape.ts --reuse     # Reuse saved cookies (skip challenge)
 *
 * Flow:
 *   1. Opens Chromium with the LeHibou missions page
 *   2. YOU solve the Cloudflare challenge manually (~5s)
 *   3. Script detects the page loaded, scrapes offers
 *   4. Saves cookies to store/lehibou-cookies.json for reuse
 *   5. Outputs offers as JSON
 */

import fs from 'fs';
import path from 'path';
import { chromium, type Page, type BrowserContext } from 'playwright';

const BASE_URL = 'https://www.lehibou.com';
const MISSIONS_URL = `${BASE_URL}/missions`;
const COOKIE_PATH = path.resolve('store/lehibou-cookies.json');
const OUTPUT_PATH = path.resolve('store/lehibou-offers.json');

interface LeHibouOffer {
  platform: string;
  platformId: string;
  title: string;
  description?: string;
  buyer?: string;
  location?: string;
  tjmMin?: number;
  tjmMax?: number;
  skills: string[];
  offerType: 'freelance';
  url: string;
  datePublished?: string;
  duration?: string;
  remote?: string;
}

async function saveCookies(context: BrowserContext): Promise<void> {
  const cookies = await context.cookies();
  fs.mkdirSync(path.dirname(COOKIE_PATH), { recursive: true });
  fs.writeFileSync(COOKIE_PATH, JSON.stringify(cookies, null, 2));
  console.log(`✅ ${cookies.length} cookies sauvegardés → ${COOKIE_PATH}`);
}

async function loadCookies(context: BrowserContext): Promise<boolean> {
  if (!fs.existsSync(COOKIE_PATH)) return false;
  try {
    const cookies = JSON.parse(fs.readFileSync(COOKIE_PATH, 'utf-8'));
    await context.addCookies(cookies);
    console.log(`🔄 ${cookies.length} cookies chargés depuis ${COOKIE_PATH}`);
    return true;
  } catch {
    return false;
  }
}

function waitForEnter(message: string): Promise<void> {
  return new Promise((resolve) => {
    process.stdout.write(`\n👉 ${message}\n   Appuie sur ENTRÉE quand c'est fait... `);
    process.stdin.once('data', () => {
      resolve();
    });
  });
}

async function waitForMissionsPage(page: Page): Promise<void> {
  console.log('⏳ Le navigateur est ouvert.');
  console.log('   1. Passe le challenge Cloudflare si nécessaire');
  console.log('   2. Connecte-toi si besoin');
  console.log('   3. Navigue vers la page des missions');

  await waitForEnter('La page des missions est chargée ?');

  // Give the SPA a moment to settle after user confirmation
  await page.waitForTimeout(2000);
  console.log(`✅ Page chargée : "${await page.title()}"`);
}

async function scrapeOffers(page: Page): Promise<LeHibouOffer[]> {
  // First, let's understand the page structure
  const pageUrl = page.url();
  console.log(`📄 URL actuelle : ${pageUrl}`);

  // Try to navigate to missions if not already there
  if (!pageUrl.includes('/missions')) {
    console.log('🔗 Navigation vers /missions...');
    await page.goto(MISSIONS_URL, { waitUntil: 'networkidle' });
    await page.waitForTimeout(3000);
  }

  // Debug: dump the page structure to understand what we're working with
  const html = await page.content();
  fs.writeFileSync('store/lehibou-debug.html', html);
  console.log(`📝 HTML sauvegardé → store/lehibou-debug.html (${html.length} chars)`);

  // Try multiple selector strategies to find offer cards
  const offers = await page.evaluate(() => {
    const results: Array<{
      title: string;
      url: string;
      description?: string;
      location?: string;
      tjm?: string;
      skills: string[];
      duration?: string;
      remote?: string;
      company?: string;
      date?: string;
    }> = [];

    // Strategy 1: Look for common card patterns
    const selectors = [
      '[class*="mission"]',
      '[class*="offer"]',
      '[class*="card"]',
      '[class*="job"]',
      'article',
      '[data-testid*="mission"]',
    ];

    let cards: Element[] = [];
    for (const sel of selectors) {
      const found = document.querySelectorAll(sel);
      if (found.length > 2) {
        cards = Array.from(found);
        console.log(`Found ${found.length} elements with selector: ${sel}`);
        break;
      }
    }

    // Strategy 2: Find links that look like mission detail pages
    if (cards.length === 0) {
      const links = document.querySelectorAll('a[href*="/mission"]');
      cards = Array.from(links).map((a) => a.closest('div, article, li, section') || a);
    }

    for (const card of cards) {
      const titleEl =
        card.querySelector('h2, h3, h4, [class*="title"]') ||
        card.querySelector('a');
      const title = titleEl?.textContent?.trim();
      if (!title || title.length < 5) continue;

      const linkEl = card.querySelector('a[href*="/mission"]') || card.closest('a');
      const url = linkEl?.getAttribute('href') || '';

      const getText = (...sels: string[]) => {
        for (const s of sels) {
          const el = card.querySelector(s);
          if (el?.textContent?.trim()) return el.textContent.trim();
        }
        return undefined;
      };

      const skillEls = card.querySelectorAll(
        '[class*="tag"], [class*="skill"], [class*="tech"], [class*="badge"]',
      );
      const skills = Array.from(skillEls)
        .map((el) => el.textContent?.trim())
        .filter((s): s is string => !!s && s.length < 30);

      results.push({
        title,
        url: url.startsWith('http') ? url : `https://www.lehibou.com${url}`,
        description: getText('[class*="desc"]', '[class*="summary"]', 'p'),
        location: getText('[class*="location"], [class*="lieu"]'),
        tjm: getText('[class*="tjm"], [class*="rate"], [class*="price"], [class*="tarif"]'),
        skills,
        duration: getText('[class*="duration"], [class*="duree"]'),
        remote: getText('[class*="remote"], [class*="teletravail"]'),
        company: getText('[class*="company"], [class*="client"], [class*="entreprise"]'),
        date: getText('[class*="date"], time'),
      });
    }

    return results;
  });

  console.log(`🔍 ${offers.length} offres extraites du DOM`);

  // Parse TJM values
  const parsed: LeHibouOffer[] = offers
    .filter((o) => o.title && o.url)
    .map((o, i) => {
      let tjmMin: number | undefined;
      let tjmMax: number | undefined;
      if (o.tjm) {
        const match = o.tjm.match(/(\d+)\s*[-–àa]\s*(\d+)/);
        if (match) {
          tjmMin = parseInt(match[1], 10);
          tjmMax = parseInt(match[2], 10);
        } else {
          const single = o.tjm.match(/(\d+)/);
          if (single) tjmMin = parseInt(single[1], 10);
        }
      }

      // Extract ID from URL or use index
      const idMatch = o.url.match(/\/missions?\/([^/?#]+)/);
      const platformId = idMatch ? idMatch[1] : `lehibou-${i}`;

      return {
        platform: 'lehibou',
        platformId,
        title: o.title,
        description: o.description,
        buyer: o.company,
        location: o.location,
        tjmMin,
        tjmMax,
        skills: o.skills,
        offerType: 'freelance' as const,
        url: o.url,
        datePublished: o.date,
        duration: o.duration,
        remote: o.remote,
      };
    });

  return parsed;
}

async function scrollToLoadAll(page: Page): Promise<void> {
  console.log('📜 Scroll pour charger toutes les offres...');

  let previousHeight = 0;
  let stableCount = 0;

  while (stableCount < 3) {
    const currentHeight = await page.evaluate(() => document.body.scrollHeight);
    if (currentHeight === previousHeight) {
      stableCount++;
    } else {
      stableCount = 0;
    }
    previousHeight = currentHeight;

    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1500);
  }
}

async function main() {
  const reuse = process.argv.includes('--reuse');

  console.log('🦉 LeHibou Scraper — Playwright');
  console.log('================================\n');

  const browser = await chromium.launch({
    headless: false, // Navigateur visible !
    args: [
      '--disable-blink-features=AutomationControlled', // Masque le flag automation
    ],
  });

  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
    locale: 'fr-FR',
  });

  // Load saved cookies if --reuse
  if (reuse) {
    const loaded = await loadCookies(context);
    if (!loaded) {
      console.log('⚠️  Pas de cookies sauvegardés, challenge nécessaire');
    }
  }

  const page = await context.newPage();

  try {
    console.log(`🌐 Ouverture de ${MISSIONS_URL}...\n`);
    await page.goto(MISSIONS_URL, { waitUntil: 'domcontentloaded' });

    // Wait for Cloudflare challenge to be resolved
    await waitForMissionsPage(page);

    // Save cookies for future reuse
    await saveCookies(context);

    // Scroll to load all offers (lazy loading / infinite scroll)
    await scrollToLoadAll(page);

    // Scrape
    const offers = await scrapeOffers(page);

    // Deduplicate
    const unique = new Map<string, LeHibouOffer>();
    for (const o of offers) {
      if (!unique.has(o.platformId)) {
        unique.set(o.platformId, o);
      }
    }
    const finalOffers = Array.from(unique.values());

    // Save results
    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(finalOffers, null, 2));
    console.log(`\n✅ ${finalOffers.length} offres sauvegardées → ${OUTPUT_PATH}`);

    // Print summary
    console.log('\n📋 Aperçu :');
    for (const o of finalOffers.slice(0, 5)) {
      console.log(`  • ${o.title}`);
      console.log(`    ${o.location || '?'} | ${o.tjmMin ? o.tjmMin + '€/j' : '?'} | ${o.skills.join(', ') || 'pas de skills'}`);
      console.log(`    ${o.url}`);
    }
    if (finalOffers.length > 5) {
      console.log(`  ... et ${finalOffers.length - 5} autres`);
    }
  } finally {
    console.log('\n🔚 Fermeture du navigateur dans 5s...');
    await page.waitForTimeout(5000);
    await browser.close();
  }
}

main().catch((err) => {
  console.error('❌ Erreur:', err);
  process.exit(1);
});
