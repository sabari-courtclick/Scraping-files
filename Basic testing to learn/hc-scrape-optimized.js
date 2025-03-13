import puppeteer from 'puppeteer';
import fs from 'fs';
import sharp from 'sharp';
import axios from 'axios';
import path from 'path';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const currentDir = process.cwd();

// Delay function to replace page.waitForTimeout
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Function to extract text from captcha image using OCR
async function extractTextFromImage(imagePath) {
    try {
        const absolutePath = path.resolve(currentDir, imagePath);
        const response = await axios.post('http://127.0.0.1:5000/ocr', { image_path: absolutePath });
        return response.data.text;
    } catch (error) {
        console.error('Error calling OCR backend:', error.message);
        throw error;
    }
}

// Function to simulate human typing
async function humanType(page, selector, text) {
    await page.focus(selector);
    await page.click(selector, { clickCount: 3 });
    await page.keyboard.press('Backspace');
    for (const char of text) {
        await delay(50); // Use delay instead of page.waitForTimeout
        await page.keyboard.type(char);
    }
    await delay(100); // Use delay instead of page.waitForTimeout
}

// Function to scrape a single CNR number
async function scrapeCNR(page, cnrNumber) {
    const maxAttempts = 5; // Reduced retries
    let attempts = 0;

    while (attempts < maxAttempts) {
        attempts++;
        console.log(`Attempt ${attempts} of ${maxAttempts} for CNR: ${cnrNumber}`);

        try {
            await page.goto('https://hcservices.ecourts.gov.in/hcservices/main.php', { waitUntil: 'networkidle2', timeout: 5000 });

            await page.waitForSelector('#cino');
            await humanType(page, '#cino', cnrNumber);

            await page.waitForSelector('#captcha_image');
            const captchaPath = path.join(currentDir, 'captcha.png');
            const captchaElement = await page.$('#captcha_image');
            await captchaElement.screenshot({ path: captchaPath });

            const captchaText = await extractTextFromImage('captcha_processed.png');
            console.log(`Extracted Captcha Text: ${captchaText}`);

            await humanType(page, '#captcha', captchaText);
            await page.click('#searchbtn');

            try {
                await page.waitForSelector('.case_details_table', { timeout: 5000 });
                console.log('Case details loaded successfully!');

                // Extract all data from the caseHistoryDiv
                const caseData = await page.evaluate(() => {
                    const data = {};
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
                    return data;
                });

                // Save the scraped data to a JSON file
                const jsonFilePath = path.join(currentDir, `case_${cnrNumber}.json`);
                fs.writeFileSync(jsonFilePath, JSON.stringify(caseData, null, 2));
                console.log(`Case data saved to ${jsonFilePath}`);

                // Save the data to MySQL database using Prisma
                await prisma.case.create({
                    data: {
                        cnr_number: cnrNumber,
                        case_details: caseData,
                    },
                });
                console.log('Data saved to MySQL database using Prisma.');

                return true; // Successfully scraped
            } catch (timeoutError) {
                console.log('Timeout waiting for case details. The captcha might be incorrect.');
            }
        } catch (error) {
            console.log(`Error during attempt ${attempts}: ${error.message}`);
            await page.screenshot({ path: `error_screenshot_${cnrNumber}_${attempts}.png` });
            await delay(500); // Reduced delay
        }
    }

    // If all attempts fail, save the failed CNR number to the database
    await prisma.failedCNR.create({
        data: {
            cnr_number: cnrNumber,
            error_message: `Failed after ${maxAttempts} attempts`,
        },
    });
    return false; // Failed to scrape after max attempts
}

// Main function to loop through CNR numbers
async function main() {
    const browser = await puppeteer.launch({
        headless: true, // Run in headless mode
        args: [
            '--disable-gpu',
            '--disable-dev-shm-usage',
            '--disable-setuid-sandbox',
            '--no-sandbox',
            '--disable-extensions',
            '--disable-software-rasterizer',
            '--disable-images', // Disable images
            '--disable-stylesheets', // Disable CSS
        ],
    });
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on('request', (request) => {
        if (['image', 'stylesheet', 'font'].includes(request.resourceType())) {
            request.abort();
        } else {
            request.continue();
        }
    });

    const startCNR = 125960; // Starting 6-digit number
    const endCNR = 125965; // Ending 6-digit number (adjust as needed)
    const year = '2025'; // Year part of the CNR number
    const prefix = 'KLHC01'; // Prefix part of the CNR number

    for (let i = startCNR; i <= endCNR; i++) {
        const cnrNumber = `${prefix}${i.toString().padStart(6, '0')}${year}`;
        console.log(`Scraping CNR: ${cnrNumber}`);
        await scrapeCNR(page, cnrNumber);
    }

    await browser.close();
    await prisma.$disconnect(); // Disconnect Prisma Client
}

main().catch(console.error);