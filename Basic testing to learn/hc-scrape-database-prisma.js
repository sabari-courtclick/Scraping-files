import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { PuppeteerBlocker } from '@cliqz/adblocker-puppeteer';
import fetch from 'cross-fetch';
import fs from 'fs';
import jimp from 'jimp';
import axios from 'axios';
import path from 'path';
import { PrismaClient } from '@prisma/client';
import os from 'os';

// Apply stealth plugin to avoid detection
puppeteer.use(StealthPlugin());

const prisma = new PrismaClient();
const currentDir = process.cwd();

// In-memory cache for captcha solutions
const captchaCache = new Map();

// Delay function with minimal waiting time
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Function to process captcha image with jimp instead of sharp
async function processCaptchaImage(imagePath, processedPath) {
  const image = await jimp.read(imagePath);
  image
    .greyscale()
    .contrast(0.7)
    .brightness(0.1)
    .threshold({ max: 150 })
    .write(processedPath);
  return processedPath;
}

// Function to extract text from captcha image using OCR
async function extractTextFromImage(imagePath) {
  try {
    // Generate hash of the image to use as cache key
    const imageBuffer = fs.readFileSync(imagePath);
    const imageHash = Buffer.from(imageBuffer).toString('base64').substring(0, 20);
    
    // Check if we have a cached solution
    if (captchaCache.has(imageHash)) {
      console.log('Using cached captcha solution');
      return captchaCache.get(imageHash);
    }
    
    const absolutePath = path.resolve(currentDir, imagePath);
    const response = await axios.post('http://127.0.0.1:5000/ocr', { image_path: absolutePath });
    const result = response.data.text;
    
    // Cache the result
    captchaCache.set(imageHash, result);
    
    // Limit cache size to prevent memory issues
    if (captchaCache.size > 1000) {
      const oldestKey = captchaCache.keys().next().value;
      captchaCache.delete(oldestKey);
    }
    
    return result;
  } catch (error) {
    console.error('Error calling OCR backend:', error.message);
    throw error;
  }
}

// Optimized typing function with minimal delays
async function humanType(page, selector, text) {
  await page.focus(selector);
  await page.click(selector, { clickCount: 3 });
  await page.keyboard.press('Backspace');
  await page.keyboard.type(text, { delay: 10 }); // Minimal typing delay
}

// Batch save operation for failed CNRs
const failedCNRBatch = [];
async function saveFailedCNR(cnrNumber, errorMessage) {
  failedCNRBatch.push({
    cnr_number: cnrNumber,
    error_message: errorMessage,
  });
  
  // Save in batches of 50
  if (failedCNRBatch.length >= 50) {
    try {
      await prisma.failedCNR.createMany({
        data: failedCNRBatch,
        skipDuplicates: true,
      });
      console.log(`Batch saved ${failedCNRBatch.length} failed CNRs to database.`);
      failedCNRBatch.length = 0; // Clear the array
    } catch (error) {
      console.error('Error batch saving failed CNRs:', error.message);
    }
  }
}

// Function to initialize adblocker
async function setupBlocker() {
  const blocker = await PuppeteerBlocker.fromPrebuiltAdsAndTracking(fetch);
  return blocker;
}

// Function to scrape a single CNR number
async function scrapeCNR(browser, cnrNumber, blocker) {
  const maxAttempts = 10; // Reduced from 15
  let attempts = 0;
  const page = await browser.newPage();
  
  try {
    // Apply ad blocker to the page
    await blocker.enableBlockingInPage(page);
    
    // Optimize page performance
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const resourceType = req.resourceType();
      if (resourceType === 'image' && !req.url().includes('captcha_image')) {
        req.abort();
      } else if (['stylesheet', 'font', 'media'].includes(resourceType)) {
        req.abort();
      } else {
        req.continue();
      }
    });
    
    // Minimal viewport for the form
    await page.setViewport({ width: 1024, height: 768 });
    
    while (attempts < maxAttempts) {
      attempts++;
      console.log(`Attempt ${attempts} of ${maxAttempts} for CNR: ${cnrNumber}`);

      try {
        await page.goto('https://hcservices.ecourts.gov.in/hcservices/main.php', { 
          waitUntil: 'domcontentloaded',  // Using domcontentloaded instead of networkidle2
          timeout: 8000 
        });

        await page.waitForSelector('#cino', { timeout: 5000 });
        await humanType(page, '#cino', cnrNumber);

        await page.waitForSelector('#captcha_image', { timeout: 5000 });
        const captchaPath = path.join(currentDir, `captcha_${cnrNumber}.png`);
        const processedCaptchaPath = path.join(currentDir, `captcha_processed_${cnrNumber}.png`);

        const captchaElement = await page.$('#captcha_image');
        await captchaElement.screenshot({ path: captchaPath });

        await processCaptchaImage(captchaPath, processedCaptchaPath);

        const captchaText = await extractTextFromImage(processedCaptchaPath);
        console.log(`Extracted Captcha Text: ${captchaText}`);

        await humanType(page, '#captcha', captchaText);

        // Setup dialog handler only once
        if (attempts === 1) {
          page.on('dialog', async dialog => {
            console.log(`Dialog message: ${dialog.message()}`);
            await dialog.accept();
          });
        }

        await Promise.all([
          page.click('#searchbtn'),
          page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 8000 }).catch(() => {})
        ]);

        // Check for error messages or captcha errors
        const errorText = await page.evaluate(() => {
          const errorElem = document.querySelector('.error_message');
          return errorElem ? errorElem.innerText : null;
        });

        if (errorText && (errorText.includes('Captcha') || errorText.includes('captcha'))) {
          console.log('Captcha error detected, trying again...');
          continue;
        }

        try {
          await page.waitForSelector('.case_details_table', { timeout: 8000 });
          console.log('Case details loaded successfully!');

          // Extract all data from the page
          const caseData = await page.evaluate(() => {
            const data = {};

            // Case Details
            const caseDetails = document.querySelector('.case_details_table');
            if (caseDetails) {
              const rows = caseDetails.querySelectorAll('tr');
              rows.forEach(row => {
                const columns = row.querySelectorAll('td');
                if (columns.length === 2) {
                  const key = columns[0].innerText.trim();
                  const value = columns[1].innerText.trim();
                  data[key] = value;
                }
              });
            }

            // Rest of the data extraction code (unchanged from original)
            // Case Status
            const caseStatus = document.querySelector('.table_r');
            if (caseStatus) {
              const rows = caseStatus.querySelectorAll('tr');
              rows.forEach(row => {
                const columns = row.querySelectorAll('td');
                if (columns.length === 2) {
                  const key = columns[0].innerText.trim();
                  const value = columns[1].innerText.trim();
                  data[key] = value;
                }
              });
            }

            // Petitioner and Advocate
            const petitionerAdvocate = document.querySelector('.Petitioner_Advocate_table');
            if (petitionerAdvocate) {
              data['Petitioner and Advocate'] = petitionerAdvocate.innerText.trim();
            }

            // Respondent and Advocate
            const respondentAdvocate = document.querySelector('.Respondent_Advocate_table');
            if (respondentAdvocate) {
              data['Respondent and Advocate'] = respondentAdvocate.innerText.trim();
            }

            // Acts
            const actsTable = document.querySelector('.Acts_table');
            if (actsTable) {
              const acts = [];
              const rows = actsTable.querySelectorAll('tr');
              rows.forEach(row => {
                const columns = row.querySelectorAll('td');
                if (columns.length === 2) {
                  acts.push({
                    underAct: columns[0].innerText.trim(),
                    underSection: columns[1].innerText.trim(),
                  });
                }
              });
              data['Acts'] = acts;
            }

            // Category Details
            const categoryTable = document.querySelector('#subject_table');
            if (categoryTable) {
              const rows = categoryTable.querySelectorAll('tr');
              rows.forEach(row => {
                const columns = row.querySelectorAll('td');
                if (columns.length === 2) {
                  const key = columns[0].innerText.trim();
                  const value = columns[1].innerText.trim();
                  data[key] = value;
                }
              });
            }

            // IA Details
            const iaTable = document.querySelector('.IAheading');
            if (iaTable) {
              const iaDetails = [];
              const rows = iaTable.querySelectorAll('tr');
              rows.forEach(row => {
                const columns = row.querySelectorAll('td');
                if (columns.length === 5) {
                  iaDetails.push({
                    iaNumber: columns[0].innerText.trim(),
                    party: columns[1].innerText.trim(),
                    dateOfFiling: columns[2].innerText.trim(),
                    nextDate: columns[3].innerText.trim(),
                    iaStatus: columns[4].innerText.trim(),
                  });
                }
              });
              data['IA Details'] = iaDetails;
            }

            // Linked Cases
            const linkedCasesTable = document.querySelector('.linkedCase');
            if (linkedCasesTable) {
              const linkedCases = [];
              const rows = linkedCasesTable.querySelectorAll('tr');
              rows.forEach(row => {
                const columns = row.querySelectorAll('td');
                if (columns.length === 2) {
                  linkedCases.push({
                    filingNumber: columns[0].innerText.trim(),
                    caseNumber: columns[1].innerText.trim(),
                  });
                }
              });
              data['Linked Cases'] = linkedCases;
            }

            // History of Case Hearings
            const historyTable = document.querySelector('.history_table');
            if (historyTable) {
              const history = [];
              const rows = historyTable.querySelectorAll('tr');
              rows.forEach(row => {
                const columns = row.querySelectorAll('td');
                if (columns.length === 5) {
                  history.push({
                    causeListType: columns[0].innerText.trim(),
                    judge: columns[1].innerText.trim(),
                    businessOnDate: columns[2].innerText.trim(),
                    hearingDate: columns[3].innerText.trim(),
                    purposeOfHearing: columns[4].innerText.trim(),
                  });
                }
              });
              data['History of Case Hearings'] = history;
            }

            // Document Details
            const documentTable = document.querySelector('.transfer_table');
            if (documentTable) {
              const documents = [];
              const rows = documentTable.querySelectorAll('tr');
              rows.forEach(row => {
                const columns = row.querySelectorAll('td');
                if (columns.length === 6) {
                  documents.push({
                    srNo: columns[0].innerText.trim(),
                    documentNo: columns[1].innerText.trim(),
                    dateOfReceiving: columns[2].innerText.trim(),
                    filedBy: columns[3].innerText.trim(),
                    nameOfAdvocate: columns[4].innerText.trim(),
                    documentFiled: columns[5].innerText.trim(),
                  });
                }
              });
              data['Document Details'] = documents;
            }

            // Objection
            const objectionTable = document.querySelector('.obj_table');
            if (objectionTable) {
              const objections = [];
              const rows = objectionTable.querySelectorAll('tr');
              rows.forEach(row => {
                const columns = row.querySelectorAll('td');
                if (columns.length === 5) {
                  objections.push({
                    srNo: columns[0].innerText.trim(),
                    scrutinyDate: columns[1].innerText.trim(),
                    objection: columns[2].innerText.trim(),
                    objectionComplianceDate: columns[3].innerText.trim(),
                    receiptDate: columns[4].innerText.trim(),
                  });
                }
              });
              data['Objection'] = objections;
            }

            return data;
          });

          // Save the scraped data to a JSON file
          const jsonFilePath = path.join(currentDir, `case_${cnrNumber}.json`);
          fs.writeFileSync(jsonFilePath, JSON.stringify(caseData, null, 2));

          // Clean up captcha images to save disk space
          fs.unlinkSync(captchaPath);
          fs.unlinkSync(processedCaptchaPath);
          
          await page.close();
          return { success: true, data: caseData };
          
        } catch (timeoutError) {
          console.log('Timeout waiting for case details. The captcha might be incorrect.');
        }
      } catch (error) {
        console.log(`Error during attempt ${attempts}: ${error.message}`);
        await page.screenshot({ path: `error_${cnrNumber}_${attempts}.png` });
        await delay(500);
      }
    }

    // If all attempts fail, save the failed CNR number
    await saveFailedCNR(cnrNumber, `Failed after ${maxAttempts} attempts`);
    await page.close();
    return { success: false };
    
  } catch (finalError) {
    console.error(`Fatal error for CNR ${cnrNumber}:`, finalError);
    await page.close();
    return { success: false };
  }
}

// Process a batch of results and save them to the database
async function processBatchResults(results) {
  const successfulCases = results
    .filter(result => result.success)
    .map(result => {
      const { cnrNumber, data } = result;
      return {
        cnr_number: cnrNumber,
        case_details: JSON.stringify(data['Case Details'] || {}),
        case_status: JSON.stringify(data['Case Status'] || {}),
        petitioner_advocate: data['Petitioner and Advocate'] || '',
        respondent_advocate: data['Respondent and Advocate'] || '',
        acts: JSON.stringify(data['Acts'] || []),
        category_details: JSON.stringify(data['Category Details'] || {}),
        ia_details: JSON.stringify(data['IA Details'] || []),
        linked_cases: JSON.stringify(data['Linked Cases'] || []),
        history_of_hearings: JSON.stringify(data['History of Case Hearings'] || []),
        document_details: JSON.stringify(data['Document Details'] || []),
        objection: JSON.stringify(data['Objection'] || []),
      };
    });

  if (successfulCases.length > 0) {
    try {
      await prisma.case.createMany({
        data: successfulCases,
        skipDuplicates: true,
      });
      console.log(`Batch saved ${successfulCases.length} cases to database.`);
    } catch (error) {
      console.error('Error batch saving cases:', error);
      // Fallback to individual saves if batch save fails
      for (const caseData of successfulCases) {
        try {
          await prisma.case.create({
            data: caseData
          });
        } catch (innerError) {
          console.error(`Failed to save case ${caseData.cnr_number}:`, innerError.message);
        }
      }
    }
  }
}

// Main function to parallelize scraping
async function main() {
  // Calculate optimal number of concurrent browser instances based on system resources
  const cpuCount = os.cpus().length;
  const totalMemGB = Math.floor(os.totalmem() / 1024 / 1024 / 1024);
  
  // Allocate browsers based on resources, with a reasonable maximum
  let concurrentBrowsers = Math.min(
    Math.floor(cpuCount / 2),     // Use half of available CPU cores
    Math.floor(totalMemGB / 2),   // Allocate 1 browser per 2GB of RAM
    8                            // Hard maximum of 8 concurrent browsers
  );
  
  // Ensure at least 1 browser
  concurrentBrowsers = Math.max(1, concurrentBrowsers);
  
  console.log(`System has ${cpuCount} CPU cores and ${totalMemGB}GB RAM`);
  console.log(`Running with ${concurrentBrowsers} concurrent browser instances`);

  // Setup the ad blocker
  const blocker = await setupBlocker();
  
  // Create browser instances
  const browsers = await Promise.all(
    Array(concurrentBrowsers).fill().map(() => 
      puppeteer.launch({ 
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--disable-gpu',
          '--disable-extensions',
          '--disable-background-networking',
          '--disable-background-timer-throttling',
          '--disable-backgrounding-occluded-windows',
          '--disable-breakpad',
          '--disable-component-extensions-with-background-pages',
          '--disable-features=TranslateUI,BlinkGenPropertyTrees',
          '--disable-ipc-flooding-protection',
          '--disable-renderer-backgrounding',
          '--enable-features=NetworkService',
          '--force-color-profile=srgb',
          '--hide-scrollbars',
          '--mute-audio'
        ],
        defaultViewport: { width: 1024, height: 768 }
      })
    )
  );

  try {
    const startCNR = 125960;
    const endCNR = 125970; // Extended for example
    const year = '2025';
    const prefix = 'KLHC01';

    const allCNRs = Array.from(
      { length: endCNR - startCNR + 1 }, 
      (_, i) => `${prefix}${(startCNR + i).toString().padStart(6, '0')}${year}`
    );

    // Process CNRs in batches
    const batchSize = concurrentBrowsers * 3; // Each browser handles 3 cases per batch
    const batchCount = Math.ceil(allCNRs.length / batchSize);
    
    for (let i = 0; i < batchCount; i++) {
      console.log(`Processing batch ${i + 1} of ${batchCount}`);
      
      const batchCNRs = allCNRs.slice(i * batchSize, (i + 1) * batchSize);
      
      // Distribute CNRs among available browsers
      const tasks = [];
      for (let j = 0; j < batchCNRs.length; j++) {
        const browserIndex = j % browsers.length;
        const cnrNumber = batchCNRs[j];
        
        tasks.push(scrapeCNR(browsers[browserIndex], cnrNumber, blocker)
          .then(result => ({...result, cnrNumber})));
      }
      
      // Run all tasks in parallel and wait for completion
      const results = await Promise.all(tasks);
      
      // Process results in batch
      await processBatchResults(results);
      
      // Give the system a small break between batches
      await delay(1000);
    }

    // Save any remaining failed CNRs
    if (failedCNRBatch.length > 0) {
      await prisma.failedCNR.createMany({
        data: failedCNRBatch,
        skipDuplicates: true,
      });
      console.log(`Saved remaining ${failedCNRBatch.length} failed CNRs to database.`);
    }
    
  } finally {
    // Close all browser instances
    for (const browser of browsers) {
      await browser.close();
    }
    
    // Disconnect Prisma
    await prisma.$disconnect();
  }
}

main().catch(console.error);