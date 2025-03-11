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
                fs.writeFileSync('case_data.json', JSON.stringify(caseData, null, 2));
                console.log('Case data saved to case_data.json');

                // Check for any linked files (PDFs, Word documents, etc.)
                const links = await page.$$eval('a', anchors => anchors.map(a => a.href));
                const fileLinks = links.filter(link => link.endsWith('.pdf') || link.endsWith('.doc') || link.endsWith('.docx'));

                if (fileLinks.length > 0) {
                    console.log('Found linked files:', fileLinks);
                    for (let i = 0; i < fileLinks.length; i++) {
                        const filePath = path.join(currentDir, `file_${i + 1}${path.extname(fileLinks[i])}`);
                        await downloadFile(page, fileLinks[i], filePath);
                        console.log(`Downloaded file to ${filePath}`);
                    }
                } else {
                    console.log('No linked files found.');
                }

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

scrapeWebsite('KLHC010125962025').catch(console.error);