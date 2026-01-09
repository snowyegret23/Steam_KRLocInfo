import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import * as cheerio from 'cheerio';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch'; // Use node-fetch for API calls

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const OUTPUT_FILE = path.join(DATA_DIR, 'quasarplay.json');

const BASE_URL = 'https://quasarplay.com/bbs/qp_korean';
const MAX_PAGES = 100;

puppeteer.use(StealthPlugin());

const delay = ms => new Promise(r => setTimeout(r, ms));

// --- CaptchaService Implementation (Ported from dcrmrf) ---

class CaptchaService {
    constructor(apiKey) {
        this.apiKey = apiKey;
        this.endpoint = 'https://api.2captcha.com';
    }

    async request(path, body = {}) {
        if (!body.clientKey) {
            body.clientKey = this.apiKey;
        }

        const response = await fetch(`${this.endpoint}${path}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });

        const result = await response.json();
        if (result.errorId && result.errorId > 0) {
            throw new Error(`${result.errorId}: ${result.errorDescription}`);
        }
        return result;
    }

    async createTask(type, websiteURL, websiteKey) {
        return await this.request('/createTask', {
            task: { type, websiteURL, websiteKey }
        });
    }

    async getTaskResult(taskId) {
        return await this.request('/getTaskResult', { taskId });
    }

    async getBalance() {
        return await this.request('/getBalance');
    }

    async solve(type, websiteURL, websiteKey, retries = 30, timeout = 5000) {
        try {
            const { taskId } = await this.createTask(type, websiteURL, websiteKey);
            console.log(`Captcha task created: ${taskId}`);

            let response = null;
            while (!response && retries-- > 0) {
                await delay(timeout);
                const result = await this.getTaskResult(taskId);
                console.log(`Checking task ${taskId}: ${result.status}`);

                if (result.status === 'ready') {
                    response = result.solution.token || result.solution.gRecaptchaResponse;
                    // 2Captcha Turnstile returns 'token', Recaptcha returns 'gRecaptchaResponse'
                } else if (result.errorId > 0) {
                    throw new Error(`Captcha error: ${result.errorDescription}`);
                }
            }

            if (!response) {
                throw new Error('Captcha solve timed out');
            }

            return response;
        } catch (error) {
            console.error('Captcha solve failed:', error.message);
            return null;
        }
    }
}

// ---------------------------------------------------------

async function loadExistingData() {
    try {
        const content = await fs.readFile(OUTPUT_FILE, 'utf-8');
        return JSON.parse(content);
    } catch {
        return [];
    }
}

function extractSteamAppId(onclickAttr) {
    if (!onclickAttr) return null;
    const match = onclickAttr.match(/store\.steampowered\.com\/app\/(\d+)/);
    return match ? match[1] : null;
}

async function handleCaptcha(page, service) {
    if (!service) return false;

    // Detect Cloudflare Turnstile
    try {
        const turnstileFrame = await page.$('iframe[src*="challenges.cloudflare.com"]');
        if (turnstileFrame) {
            console.log('Detailed Cloudflare Turnstile detected.');
            // Attempt to extract sitekey from the iframe src or surrounding elements?
            // Usually simpler to find the .cf-turnstile element or similar in the main frame.

            // Evaluated strategy: Look for the Turnstile container
            const siteKey = await page.evaluate(() => {
                const el = document.querySelector('.cf-turnstile') || document.querySelector('[data-sitekey]');
                return el ? el.getAttribute('data-sitekey') : null;
            });

            // If sitekey found, solve it
            if (siteKey) {
                console.log(`Found SiteKey: ${siteKey}`);
                const token = await service.solve('TurnstileTaskProxyless', page.url(), siteKey);
                if (token) {
                    console.log('Injecting Turnstile token...');
                    await page.evaluate((token) => {
                        // Common Cloudflare Turnstile injection
                        const inputs = document.querySelectorAll('input[name="cf-turnstile-response"]');
                        inputs.forEach(input => { input.value = token; });

                        // Sometimes need to trigger callback?
                        // For now, let's try submitting the form if it exists
                        // Or cloudflare might auto-detect the value change? rarely.
                    }, token);

                    // Click the verify button/checkbox frame?
                    // Often just clicking the checkbox is enough if we are not truly blocked, 
                    // but if we are blocked we need the token.
                }
            } else {
                // Fallback: finding key inside iframe src URL
                const frameSrc = await page.evaluate(el => el.src, turnstileFrame);
                const urlParams = new URLSearchParams(new URL(frameSrc).search);
                const key = urlParams.get('sitekey');
                if (key) {
                    console.log(`Found SiteKey from iframe: ${key}`);
                    const token = await service.solve('TurnstileTaskProxyless', page.url(), key);
                    if (token) {
                        // Inject? Cloudflare turnstile is tricky to inject purely.
                        // Usually 2captcha docs suggest navigating/clicking. 
                        // But let's assume standard injection for now.
                    }
                }
            }
        }
    } catch (e) {
        console.log('Error detecting/solving captcha', e);
    }

    // Naive fallback: if 2captcha api key acts up or we prefer simple stealth
    // We just wait? No, the user explicitly asked for 2captcha.
    return false;

}

async function scrapePage(page, pageNum, captchaService) {
    const url = `${BASE_URL}?page=${pageNum}`;
    console.log(`Fetching: ${url}`);

    try {
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

        const title = await page.title();
        console.log(`Page Title: ${title}`);

        // Check for Cloudflare Block / Challenge
        // Titles like "Attention Required! | Cloudflare" or "Just a moment..."
        if (title.includes('Cloudflare') || title.includes('Attention Required')) {
            console.log('Cloudflare challenge detected!');

            if (captchaService) {
                // Try to solve Turnstile
                // Note: Cloudflare often rotates keys or uses concealed challenges.
                // We'll try to find a sitekey.
                const siteKey = await page.evaluate(() => {
                    // Try generic selectors
                    const e = document.querySelector('[data-sitekey]');
                    if (e) return e.getAttribute('data-sitekey');
                    // Check logic for finding sitekey in scripts? Too complex for this snippet.
                    return '0x4AAAAAAADnPIDROrmt1Wwj'; // Sample/Common? No, site specific.
                });

                // If we can't find a sitekey easily, we might be stuck.
                // But let's look for the standard turnstile container specifically.
                const cloudflareSiteKey = await page.evaluate(() => {
                    return window.turnstile?.render?.arguments?.[1]?.sitekey;
                }).catch(() => null);

                // Taking a screenshot to debug what kind of captcha it is
                await page.screenshot({ path: path.join(DATA_DIR, 'challenge_screenshot.png') });
            }
        }

        try {
            await page.waitForSelector('table tbody tr.item', { timeout: 10000 });
        } catch (e) {
            console.log(`No games found on page ${pageNum} (selector timeout).`);
            console.log('Taking debug screenshot...');
            await page.screenshot({ path: path.join(DATA_DIR, 'debug_screenshot.png') });
            await fs.writeFile(path.join(DATA_DIR, 'debug_page.html'), await page.content());
            return [];
        }

        const html = await page.content();
        const $ = cheerio.load(html);
        const games = [];

        $('table tbody tr.item').each((_, el) => {
            const $row = $(el);

            const typeText = $row.find('td.type_area span.type').text().trim();
            const patchType = typeText.includes('유저') ? 'user' : 'official';

            const $details = $row.find('td.details-control');

            const $thumbnail = $details.find('.thumbnail_wrapper');
            const onclickAttr = $thumbnail.attr('onclick') || '';
            const steamAppId = extractSteamAppId(onclickAttr);

            const gameTitle = $details.find('p.title').text().trim() || '';

            const $downloadLink = $details.find('p.download_link a.forward');
            const patchLink = $downloadLink.attr('href') || '';

            const producerSpans = $details.find('p.producer span').not('.colorGray3');
            const producer = producerSpans.text().trim() || '';

            const steamLink = steamAppId ? `https://store.steampowered.com/app/${steamAppId}` : '';

            if (gameTitle) {
                games.push({
                    source: 'quasarplay',
                    app_id: steamAppId,
                    game_title: gameTitle,
                    steam_link: steamLink,
                    patch_type: patchType,
                    patch_links: patchLink ? [patchLink] : [],
                    description: producer ? `제작자: ${producer}` : '',
                    updated_at: new Date().toISOString()
                });
            }
        });

        return games;
    } catch (err) {
        console.error(`Error scraping page ${pageNum}:`, err.message);
        return [];
    }
}

async function scrapeAll(existingMap) {
    const allGames = new Map();
    let consecutiveDuplicates = 0;
    const DUPLICATE_THRESHOLD = 3;

    const launchArgs = ['--no-sandbox', '--disable-setuid-sandbox'];

    // Proxy support
    let proxyUrl = null;
    if (process.env.QUASARPLAY_PROXY) {
        try {
            proxyUrl = new URL(process.env.QUASARPLAY_PROXY);
            launchArgs.push(`--proxy-server=${proxyUrl.protocol}//${proxyUrl.host}`);
            console.log(`Using Proxy: ${proxyUrl.protocol}//${proxyUrl.host}`);
        } catch (e) {
            console.error('Invalid QUASARPLAY_PROXY URL:', e.message);
        }
    }

    // 2Captcha Service
    let captchaService = null;
    if (process.env.TWO_CAPTCHA_API_KEY) {
        captchaService = new CaptchaService(process.env.TWO_CAPTCHA_API_KEY);
        console.log('2Captcha Manual Service Configured');
        try {
            const balance = await captchaService.getBalance();
            console.log(`2Captcha Balance: ${balance.balance}`);
        } catch (e) {
            console.error('Failed to check 2Captcha balance:', e.message);
        }
    }

    const browser = await puppeteer.launch({
        headless: "new",
        args: launchArgs
    });
    const page = await browser.newPage();

    // Authenticate proxy
    if (proxyUrl && proxyUrl.username && proxyUrl.password) {
        await page.authenticate({
            username: decodeURIComponent(proxyUrl.username),
            password: decodeURIComponent(proxyUrl.password)
        });
    }

    // Load Cookies
    if (process.env.QUASARPLAY_COOKIE) {
        const cookieStr = process.env.QUASARPLAY_COOKIE;
        const cookies = cookieStr.split(';')
            .map(part => part.trim())
            .filter(part => part.includes('='))
            .map(part => {
                const [name, ...valueParts] = part.split('=');
                return {
                    name: name.trim(),
                    value: valueParts.join('=').trim(),
                    domain: '.quasarplay.com'
                };
            });

        if (cookies.length > 0) {
            await page.setCookie(...cookies);
            console.log(`Loaded ${cookies.length} cookies from env.`);
        }
    }

    await page.setViewport({ width: 1920, height: 1080 });

    try {
        for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
            const games = await scrapePage(page, pageNum, captchaService);

            if (games.length === 0) {
                console.log(`No games found on page ${pageNum}, stopping.`);
                break;
            }

            let newGamesOnPage = 0;
            for (const game of games) {
                const key = game.app_id || game.game_title;
                if (!allGames.has(key) && !existingMap.has(key)) {
                    allGames.set(key, game);
                    newGamesOnPage++;
                } else if (!allGames.has(key)) {
                    allGames.set(key, game);
                }
            }

            console.log(`Page ${pageNum}: ${games.length} games (${newGamesOnPage} new)`);

            if (newGamesOnPage === 0) {
                consecutiveDuplicates++;
                if (consecutiveDuplicates >= DUPLICATE_THRESHOLD) {
                    console.log(`${DUPLICATE_THRESHOLD} consecutive pages with no new games, stopping.`);
                    break;
                }
            } else {
                consecutiveDuplicates = 0;
            }

            await delay(1000 + Math.random() * 2000);
        }
    } finally {
        await browser.close();
    }

    return Array.from(allGames.values());
}

async function main() {
    console.log('Starting quasarplay.com scraper (Puppeteer + Manual 2Captcha)...');

    await fs.mkdir(DATA_DIR, { recursive: true });

    const existingData = await loadExistingData();
    const existingMap = new Map(existingData.map(g => [g.app_id || g.game_title, g]));

    const newData = await scrapeAll(existingMap);

    for (const game of newData) {
        const key = game.app_id || game.game_title;
        existingMap.set(key, game);
    }

    const merged = Array.from(existingMap.values());

    await fs.writeFile(OUTPUT_FILE, JSON.stringify(merged, null, 2), 'utf-8');
    console.log(`Saved ${merged.length} games to ${OUTPUT_FILE}`);
}

main().catch(console.error);
