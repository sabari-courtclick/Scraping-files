import puppeteer from 'puppeteer';
import axios from 'axios';
import fs from 'fs';
import dotenv from 'dotenv';

dotenv.config();

const API_KEY = process.env.API_KEY;

async function solveCaptcha(imagePath) {
  const captchaImage = fs.readFileSync(imagePath, 'base64');
  console.log('Sending captcha to 2Captcha...');

  const response = await axios.post(`https://2captcha.com/in.php`, {
    key: API_KEY,
    method: 'base64',
    body: captchaImage,
    json: 1,
  });

  console.log('2Captcha API Response:', response.data);

  if (response.data.status !== 1) {
    throw new Error(`Failed to send captcha to 2Captcha: ${response.data.request}`);
  }

  const captchaId = response.data.request;
  console.log('Captcha sent to 2Captcha. Waiting for solution...');

  let solution;
  for (let i = 0; i < 30; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    const result = await axios.get(`https://2captcha.com/res.php`, {
      params: {
        key: API_KEY,
        action: 'get',
        id: captchaId,
        json: 1,
      },
    });

    console.log('2Captcha Polling Response:', result.data);

    if (result.data.status === 1) {
      solution = result.data.request;
      break;
    }
  }

  if (!solution) {
    throw new Error('Failed to solve captcha');
  }

  console.log(`Captcha solved: ${solution}`);
  return solution;
}

async function handleInvalidRequest(page) {
  const hasError = await page.evaluate(() => {
    return document.body.innerText.includes('Oops') && document.body.innerText.includes('Invalid Request');
  });

  if (hasError) {
    console.log("[WARN] 'Oops! Invalid Request' page detected. Clicking the refresh link...");
    const refreshLink = await page.$('div#msg-danger a');

    if (refreshLink) {
      await refreshLink.click();
      await page.waitForNavigation({ waitUntil: 'networkidle2' });
    } else {
      console.log('[ERROR] Refresh link not found! Reloading manually...');
      await page.reload({ waitUntil: 'networkidle2' });
    }
  }
}

async function scrapeTableData(page) {
  const data = {};

  data.courtName = await page.$eval('#chHeading', (el) => el.textContent.trim());

  data.caseDetails = await page.$$eval('.case_details_table tbody tr', (rows) => {
    return rows.map((row) => {
      const columns = row.querySelectorAll('td');
      return {
        label: columns[0]?.textContent.trim(),
        value: columns[1]?.textContent.trim(),
      };
    });
  });

  data.caseStatus = await page.$$eval('.case_status_table tbody tr', (rows) => {
    return rows.map((row) => {
      const columns = row.querySelectorAll('td');
      return {
        label: columns[0]?.textContent.trim(),
        value: columns[1]?.textContent.trim(),
      };
    });
  });

  data.petitionerAdvocate = await page.$$eval('.Petitioner_Advocate_table tbody tr', (rows) => {
    return rows.map((row) => {
      const columns = row.querySelectorAll('td');
      return columns[0]?.textContent.trim();
    });
  });

  data.respondentAdvocate = await page.$$eval('.Respondent_Advocate_table tbody tr', (rows) => {
    return rows.map((row) => {
      const columns = row.querySelectorAll('td');
      return columns[0]?.textContent.trim();
    });
  });

  data.acts = await page.$$eval('.acts_table tbody tr', (rows) => {
    return rows.slice(1).map((row) => {
      const columns = row.querySelectorAll('td');
      return {
        underAct: columns[0]?.textContent.trim(),
        underSection: columns[1]?.textContent.trim(),
      };
    });
  });

  data.caseHistory = await page.$$eval('.history_table tbody tr', (rows) => {
    return rows.map((row) => {
      const columns = row.querySelectorAll('td');
      return {
        judge: columns[0]?.textContent.trim(),
        businessOnDate: columns[1]?.textContent.trim(),
        hearingDate: columns[2]?.textContent.trim(),
        purposeOfHearing: columns[3]?.textContent.trim(),
      };
    });
  });

  return data;
}

async function processCNR(cnrNumber, page) {
  const maxAttempts = 3;
  let attempt = 0;
  let success = false;
  let caseData = null;

  while (attempt < maxAttempts && !success) {
    try {
      await page.type('#cino', cnrNumber);

      await page.waitForSelector('#captcha_image', { visible: true, timeout: 30000 });

      const captchaElement = await page.$('#captcha_image');
      if (!captchaElement) {
        throw new Error('Captcha element not found');
      }

      await captchaElement.screenshot({ path: 'captcha.png' });

      const stats = fs.statSync('captcha.png');
      console.log(`Captcha image size: ${stats.size} bytes`);

      if (stats.size === 0) {
        throw new Error('Captcha image is empty');
      }

      console.log('Captcha screenshot saved as captcha.png');

      let captchaText;
      try {
        captchaText = await solveCaptcha('captcha.png');
      } catch (error) {
        console.error('Error solving captcha:', error.message);
        console.error('Retrying...');
        attempt++;
        continue;
      }

      await page.type('#fcaptcha_code', captchaText);

      await page.click('#searchbtn');

      // Check if case details table exists after submitting CAPTCHA
      let caseDetailsExists = await page.waitForSelector('.case_details_table', { timeout: 3000 }).catch(() => null);

      if (!caseDetailsExists) {
        console.log("[WARN] Case details not found, retrying...");
        await page.reload({ waitUntil: 'networkidle2' });
        await handleInvalidRequest(page);
      } else {
        console.log("[INFO] Case details loaded successfully. Scraping table data...");
        const tableData = await scrapeTableData(page);
        console.log('Scraped Data:', JSON.stringify(tableData, null, 2));

        fs.writeFileSync('scraped_data.json', JSON.stringify(tableData, null, 2));
        console.log('Scraped data saved to scraped_data.json');

        // Click back button and wait for navigation
        await page.waitForSelector('#main_back_cnr', { visible: true, timeout: 30000 });
        await page.click('#main_back_cnr');
        await page.waitForNavigation({ waitUntil: 'networkidle2' });

        success = true;
        caseData = tableData;
      }
    } catch (error) {
      console.error('Error during retry:', error.message);
      attempt++;

      await handleInvalidRequest(page);

      await page.reload({ waitUntil: 'networkidle2' });
      console.log('Page reloaded. Retrying...');
    }
  }

  if (!success) {
    console.log(`[ERROR] Failed to process CNR ${cnrNumber} after ${maxAttempts} attempts.`);
    return null;
  }

  return caseData;
}

async function main() {
  let browser = null;
  const results = [];

  try {
    console.log('[INFO] Starting browser...');
    browser = await puppeteer.launch({
      headless: false,
      ignoreHTTPSErrors: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-features=VizDisplayCompositor',
        '--disable-extensions',
        '--disable-component-extensions-with-background-pages',
        '--disable-default-apps',
        '--mute-audio',
        '--no-zygote',
        '--no-first-run',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-breakpad',
        '--disable-site-isolation-trials',
        '--disable-translate',
        '--disable-blink-features=AutomationControlled',
      ],
      defaultViewport: { width: 800, height: 600 },
    });

    const page = await browser.newPage();
    await page.goto('https://services.ecourts.gov.in/ecourtindia_v6/', {
      waitUntil: 'networkidle2',
    });

    const cnrNumbers = ['KLWD030000802019'];

    for (const cnrNumber of cnrNumbers) {
      const result = await processCNR(cnrNumber, page);
      if (result) {
        results.push(result);
        const fileName = `case_data_${cnrNumber}.json`;
        fs.writeFileSync(fileName, JSON.stringify(result, null, 2));
        console.log(`[INFO] Case data saved to ${fileName}`);
      }
    }

    if (results.length > 0) {
      const combinedFileName = 'all_case_data.json';
      fs.writeFileSync(combinedFileName, JSON.stringify(results, null, 2));
      console.log(`[INFO] All case data saved to ${combinedFileName}`);
    }
  } catch (error) {
    console.error('[ERROR] Main process error:', error);
  } finally {
    if (browser) {
      try {
        await browser.close();
        console.log('[INFO] Browser closed');
      } catch (error) {
        console.error('[ERROR] Error closing browser:', error);
      }
    }
  }
}

main();