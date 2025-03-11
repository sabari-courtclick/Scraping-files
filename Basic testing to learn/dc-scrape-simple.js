import puppeteer from 'puppeteer';
import fs from 'fs';
import sharp from 'sharp';
import axios from 'axios';

// Function to call the Python OCR backend
async function extractTextFromImage(imagePath) {
    try {
        const response = await axios.post('http://localhost:5000/ocr', {
            image_path: imagePath,
        });
        return response.data.text; // Return the extracted text
    } catch (error) {
        console.error('Error calling OCR backend:', error.message);
        throw error;
    }
}

async function scrapeWebsite(cnrNumber) {
    const browser = await puppeteer.launch({ headless: false });
    const page = await browser.newPage();

    try {
        await page.goto('https://services.ecourts.gov.in/ecourtindia_v6/?p=home/index');
        await page.waitForSelector('#cino');
        await page.type('#cino', cnrNumber);
        await page.waitForSelector('#captcha_image');

        // Take a screenshot of the captcha
        const captchaElement = await page.$('#captcha_image');
        await captchaElement.screenshot({ path: 'captcha.png' });

        // Preprocess the captcha image using sharp
        await sharp('captcha.png')
            .greyscale() // Convert to grayscale
            .threshold(128) // Apply thresholding
            .toFile('captcha_processed.png');

        // Use EasyOCR (Python backend) to extract text
        const captchaText = await extractTextFromImage('captcha_processed.png');
        console.log(`Extracted Captcha Text: ${captchaText}`);

        // Input the captcha text into the captcha input field
        await page.type('#fcaptcha_code', captchaText);

        // Submit the form
        await page.click('#searchbtn');

        // Wait for the case document to load
        await page.waitForSelector('.case_details_table', { timeout: 10000 });

        // Scrape the document content
        const documentData = await page.evaluate(() => {
            const data = {};

            // Extract case details
            const caseDetails = document.querySelector('.case_details_table');
            const rows = caseDetails.querySelectorAll('tr');
            rows.forEach(row => {
                const columns = row.querySelectorAll('td');
                if (columns.length === 2) {
                    const key = columns[0].innerText.trim();
                    const value = columns[1].innerText.trim();
                    data[key] = value;
                }
            });

            // Extract case status
            const caseStatus = document.querySelector('.case_status_table');
            const statusRows = caseStatus.querySelectorAll('tr');
            statusRows.forEach(row => {
                const columns = row.querySelectorAll('td');
                if (columns.length === 2) {
                    const key = columns[0].innerText.trim();
                    const value = columns[1].innerText.trim();
                    data[key] = value;
                }
            });

            // Extract petitioner and respondent details
            const petitionerTable = document.querySelector('.Petitioner_Advocate_table');
            const petitionerRows = petitionerTable.querySelectorAll('tr');
            data['Petitioner'] = petitionerRows[0].innerText.trim();

            const respondentTable = document.querySelector('.Respondent_Advocate_table');
            const respondentRows = respondentTable.querySelectorAll('tr');
            data['Respondent'] = respondentRows[0].innerText.trim();

            // Extract acts
            const actsTable = document.querySelector('.acts_table');
            const actsRows = actsTable.querySelectorAll('tr');
            data['Acts'] = [];
            actsRows.forEach(row => {
                const columns = row.querySelectorAll('td');
                if (columns.length === 2) {
                    const act = columns[0].innerText.trim();
                    const section = columns[1].innerText.trim();
                    data['Acts'].push({ act, section });
                }
            });

            // Extract case history
            const historyTable = document.querySelector('.history_table');
            const historyRows = historyTable.querySelectorAll('tr');
            data['Case History'] = [];
            historyRows.forEach(row => {
                const columns = row.querySelectorAll('td');
                if (columns.length === 4) {
                    const judge = columns[0].innerText.trim();
                    const businessDate = columns[1].innerText.trim();
                    const hearingDate = columns[2].innerText.trim();
                    const purpose = columns[3].innerText.trim();
                    data['Case History'].push({ judge, businessDate, hearingDate, purpose });
                }
            });

            // Extract IA status
            const iaTable = document.querySelector('.IAheading');
            const iaRows = iaTable.querySelectorAll('tr');
            data['IA Status'] = [];
            iaRows.forEach(row => {
                const columns = row.querySelectorAll('td');
                if (columns.length === 5) {
                    const iaNumber = columns[0].innerText.trim();
                    const partyName = columns[1].innerText.trim();
                    const filingDate = columns[2].innerText.trim();
                    const nextDate = columns[3].innerText.trim();
                    const status = columns[4].innerText.trim();
                    data['IA Status'].push({ iaNumber, partyName, filingDate, nextDate, status });
                }
            });

            return data;
        });

        // Save the scraped data to a JSON file
        fs.writeFileSync('case_document.json', JSON.stringify(documentData, null, 2));
        console.log('Document data saved to case_document.json');

        // Print the JSON data to the terminal
        console.log('Scraped Document Data:', JSON.stringify(documentData, null, 2));

    } catch (error) {
        console.log(`Error: ${error.message}. Restarting the process...`);

        // Close the browser and restart the process
        await browser.close();
        await scrapeWebsite(cnrNumber); // Re-execute the function
        return; // Exit the current execution
    }

    // Wait for a while to see the result (you can remove this in production)
    await page.waitForTimeout(5000);

    // Close the browser
    await browser.close();
}

// Replace 'KLKN190001222022' with the actual CNR number you want to input
scrapeWebsite('KLKN190001222022').catch(console.error);

