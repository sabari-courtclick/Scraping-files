import puppeteer from 'puppeteer';
import fs from 'fs';
import sharp from 'sharp';
import axios from 'axios';
import path from 'path';
import mysql from 'mysql2/promise'; // MySQL library

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

// Function to download linked files (PDFs, Word documents, etc.)
async function downloadFile(page, url, filePath) {
    const response = await axios({
        url,
        responseType: 'stream',
    });
    const writer = fs.createWriteStream(filePath);
    response.data.pipe(writer);
    return new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
    });
}

// Function to scrape a single CNR number
async function scrapeCNR(page, cnrNumber) {
    const maxAttempts = 15;
    let attempts = 0;

    while (attempts < maxAttempts) {
        attempts++;
        console.log(`Attempt ${attempts} of ${maxAttempts} for CNR: ${cnrNumber}`);

        try {
            await page.goto('https://hcservices.ecourts.gov.in/hcservices/main.php', { waitUntil: 'networkidle2', timeout: 10000 });

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

                // Extract all data from the caseHistoryDiv
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
                console.log(`Case data saved to ${jsonFilePath}`);

                // Save the data to MySQL database
                await saveToDatabase(caseData);

                // Check for any linked files (PDFs, Word documents, etc.)
                const links = await page.$$eval('a', anchors => anchors.map(a => a.href));
                const fileLinks = links.filter(link => link.endsWith('.pdf') || link.endsWith('.doc') || link.endsWith('.docx'));

                if (fileLinks.length > 0) {
                    console.log('Found linked files:', fileLinks);
                    for (let i = 0; i < fileLinks.length; i++) {
                        const filePath = path.join(currentDir, `file_${i + 1}_${cnrNumber}${path.extname(fileLinks[i])}`);
                        await downloadFile(page, fileLinks[i], filePath);
                        console.log(`Downloaded file to ${filePath}`);
                    }
                } else {
                    console.log('No linked files found.');
                }

                return true; // Successfully scraped
            } catch (timeoutError) {
                console.log('Timeout waiting for case details. The captcha might be incorrect.');
            }
        } catch (error) {
            console.log(`Error during attempt ${attempts}: ${error.message}`);
            await page.screenshot({ path: `error_screenshot_${cnrNumber}_${attempts}.png` });
            await delay(1000); // Use delay instead of page.waitForTimeout
        }
    }

    return false; // Failed to scrape after max attempts
}

// Function to save data to MySQL database
async function saveToDatabase(data) {
    const connection = await mysql.createConnection({
        host: 'localhost', // Replace with your MySQL host
        user: 'root', // Replace with your MySQL username
        password: 'password', // Replace with your MySQL password
        database: 'case_data', // Replace with your database name
    });

    const query = `
        INSERT INTO cases (cnr_number, case_details, case_status, petitioner_advocate, respondent_advocate, acts, category_details, ia_details, linked_cases, history_of_hearings, document_details, objection)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    const values = [
        data['CNR Number'],
        JSON.stringify(data['Case Details']),
        JSON.stringify(data['Case Status']),
        data['Petitioner and Advocate'],
        data['Respondent and Advocate'],
        JSON.stringify(data['Acts']),
        JSON.stringify(data['Category Details']),
        JSON.stringify(data['IA Details']),
        JSON.stringify(data['Linked Cases']),
        JSON.stringify(data['History of Case Hearings']),
        JSON.stringify(data['Document Details']),
        JSON.stringify(data['Objection']),
    ];

    await connection.execute(query, values);
    await connection.end();
    console.log('Data saved to MySQL database.');
}

// Main function to loop through CNR numbers
async function main() {
    const browser = await puppeteer.launch({ headless: false, defaultViewport: { width: 1366, height: 768 } });
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.4896.127 Safari/537.36');

    const startCNR = 0; // Starting 6-digit number
    const endCNR = 400000; // Ending 6-digit number (adjust as needed)
    const year = '2025'; // Year part of the CNR number
    const prefix = 'KLHC01'; // Prefix part of the CNR number

    let consecutiveFailures = 0;

    for (let i = startCNR; i <= endCNR; i++) {
        const cnrNumber = `${prefix}${i.toString().padStart(6, '0')}${year}`;
        console.log(`Scraping CNR: ${cnrNumber}`);

        const success = await scrapeCNR(page, cnrNumber);
        if (success) {
            consecutiveFailures = 0;
        } else {
            consecutiveFailures++;
            if (consecutiveFailures >= 3000) {
                console.log('3000 consecutive failures. Stopping the loop.');
                break;
            }
        }
    }

    await browser.close();
}

main().catch(console.error);