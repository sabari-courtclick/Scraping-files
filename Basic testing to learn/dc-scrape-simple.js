import puppeteer from 'puppeteer';
import fs from 'fs';
import sharp from 'sharp';
import axios from 'axios';
import path from 'path';

const currentDir = process.cwd();

// Delay function to replace page.waitForTimeout
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

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

async function scrapeWebsite(cnrNumber) {
    const browser = await puppeteer.launch({ headless: false, defaultViewport: { width: 1366, height: 768 } });
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.4896.127 Safari/537.36');

    const maxAttempts = 10;
    let attempts = 0;

    while (attempts < maxAttempts) {
        attempts++;
        console.log(`Attempt ${attempts} of ${maxAttempts}`);

        try {
            await page.goto('https://services.ecourts.gov.in', { waitUntil: 'networkidle2', timeout: 10000 });

            await page.waitForSelector('#cino');
            await humanType(page, '#cino', cnrNumber);

            await page.waitForSelector('#captcha_image');
            const captchaPath = path.join(currentDir, 'captcha.png');
            const processedCaptchaPath = path.join(currentDir, 'captcha_processed.png');

            const captchaElement = await page.$('#captcha_image');
            await captchaElement.screenshot({ path: captchaPath });

            await sharp(captchaPath).greyscale().threshold(128).toFile(processedCaptchaPath);

            const captchaText = await extractTextFromImage('captcha_processed.png');
            console.log(`Extracted Captcha Text: ${captchaText}`);

            await humanType(page, '#captcha', captchaText);

            page.on('dialog', async dialog => {
                console.log(`Dialog message: ${dialog.message()}`);
                await dialog.accept();
                if (dialog.message().includes('Enter Captcha') || dialog.message().includes('Invalid Captcha')) {
                    console.log('Captcha was incorrect, trying again...');
                    await delay(500); // Use delay instead of page.waitForTimeout
                    await captchaElement.screenshot({ path: captchaPath });
                    await sharp(captchaPath).greyscale().threshold(128).toFile(processedCaptchaPath);
                    const newCaptchaText = await extractTextFromImage('captcha_processed.png');
                    console.log(`New Captcha Text: ${newCaptchaText}`);
                    await humanType(page, '#captcha', newCaptchaText);
                    await page.click('#searchbtn');
                }
            });

            await page.click('#searchbtn');

            try {
                await page.waitForSelector('.case_details_table', { timeout: 10000 });
                console.log('Case details loaded successfully!');

                const documentData = await page.evaluate(() => {
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

                fs.writeFileSync('case_document.json', JSON.stringify(documentData, null, 2));
                console.log('Document data saved to case_document.json');
                console.log('Scraped Document Data:', JSON.stringify(documentData, null, 2));
                break;
            } catch (timeoutError) {
                console.log('Timeout waiting for case details. The captcha might be incorrect.');
            }
        } catch (error) {
            console.log(`Error during attempt ${attempts}: ${error.message}`);
            await page.screenshot({ path: `error_screenshot_${attempts}.png` });
            await delay(1000); // Use delay instead of page.waitForTimeout
        }
    }

    await browser.close();
}

scrapeWebsite('KLKN190001222022').catch(console.error);