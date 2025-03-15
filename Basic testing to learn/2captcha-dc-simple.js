import puppeteer from "puppeteer";
import fs from "fs";
import { Solver } from "2captcha-ts";

const baseUrl = 'https://services.ecourts.gov.in/ecourtindia_v6/';
const cnrNumbers = ['KLER010024292019'];
const API_KEY = "f048fd937e44bef6e0689899680cd105";
const solver = new Solver(API_KEY);

// Cache for CAPTCHA solutions
const captchaCache = {};

// Function to solve CAPTCHA using 2Captcha
async function solveCaptcha(base64Image) {
    if (captchaCache[base64Image]) {
        console.log("[INFO] Using cached CAPTCHA solution.");
        return captchaCache[base64Image];
    }

    console.log("[INFO] Sending CAPTCHA to 2captcha service...");
    const startTime = Date.now();
    const captchaResult = await solver.imageCaptcha({
        method: 'base64',
        body: base64Image
    });
    const endTime = Date.now();
    console.log(`[INFO] 2captcha solution received in ${(endTime - startTime) / 1000} seconds.`);

    if ((endTime - startTime) / 1000 > 30) {
        console.log("[WARN] 2Captcha is taking too long. Consider using an alternative service.");
    }

    captchaCache[base64Image] = captchaResult.data;
    return captchaResult.data;
}

// Function to scrape hidden case business details
async function scrapeCaseBusinessDiv(page) {
    try {
        console.log("[INFO] Scraping hidden case business details...");

        // Wait for the hidden content to load
        await page.waitForSelector('#caseBusinessDiv_cnr', { visible: true, timeout: 5000 });

        // Extract the hidden content
        const businessDetails = await page.evaluate(() => {
            const businessDiv = document.querySelector('#caseBusinessDiv_cnr');
            return businessDiv ? businessDiv.innerText.trim() : null;
        });

        console.log("[INFO] Hidden case business details scraped successfully.");
        return businessDetails;
    } catch (error) {
        console.log("[ERROR] Error scraping hidden case business details:", error.message);
        return null;
    }
}

// Function to handle multiple dates in the "Business on Date" column
async function scrapeMultipleBusinessDates(page) {
    const businessDates = await page.$$eval("table.history_table a", (links) =>
        links.map((link) => link.innerText.trim())
    );

    const allBusinessDetails = [];
    for (const date of businessDates) {
        console.log(`[INFO] Clicking date: ${date}`);
        await page.click(`table.history_table a >> text="${date}"`);
        await page.waitForSelector('#caseBusinessDiv_cnr', { visible: true, timeout: 5000 });

        const businessDetails = await scrapeCaseBusinessDiv(page);
        if (businessDetails) {
            allBusinessDetails.push({ date, details: businessDetails });
        }

        // Go back to the main page
        await page.click("#caseBusinessDiv_back");
        await page.waitForSelector("table.case_details_table", { visible: true, timeout: 5000 });
    }

    return allBusinessDetails;
}

async function processCNR(cnrNumber, browser) {
    const maxAttempts = 3;
    let attempt = 0;
    let success = false;
    let caseData = null;

    while (attempt < maxAttempts && !success) {
        const startTime = Date.now();
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 800 });

        // Disable unnecessary resources for optimization
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            if (['image', 'stylesheet', 'font', 'script'].includes(req.resourceType())) {
                req.abort();
            } else {
                req.continue();
            }
        });

        try {
            console.log(`[INFO] Attempt ${attempt + 1} for CNR: ${cnrNumber}`);

            await page.goto(baseUrl, {
                waitUntil: "networkidle2",
                timeout: 10000
            });

            // Solve CAPTCHA
            const captchaElement = await page.$("#captcha_image");
            const captchaPath = `captcha_${cnrNumber}.png`;
            await captchaElement.screenshot({ path: captchaPath, omitBackground: true });
            console.log("[INFO] CAPTCHA image saved:", captchaPath);

            const base64Image = fs.readFileSync(captchaPath, { encoding: 'base64' });
            const captchaText = await solveCaptcha(base64Image);
            console.log("[INFO] CAPTCHA text entered");

            await page.type("#fcaptcha_code", captchaText);
            await page.type("#cino", cnrNumber);
            console.log("[INFO] CNR number entered:", cnrNumber);

            await page.click("#searchbtn");
            await page.waitForSelector("table.case_details_table", { visible: true, timeout: 10000 });

            // Scrape case details
            const allTableData = await page.evaluate(() => {
                const result = {
                    caseDetails: [],
                    caseStatus: [],
                    petitionerAdvocate: [],
                    respondentAdvocate: [],
                    actsAndSections: [],
                    iaStatus: [],
                    caseHistory: []
                };

                document.querySelectorAll("table.case_details_table tr").forEach(row => {
                    const rowData = Array.from(row.querySelectorAll("td")).map(td => td.innerText.trim());
                    if (rowData.length) result.caseDetails.push(rowData);
                });

                document.querySelectorAll("table.case_status_table tr").forEach(row => {
                    const rowData = Array.from(row.querySelectorAll("td")).map(td => td.innerText.trim());
                    if (rowData.length) result.caseStatus.push(rowData);
                });

                document.querySelectorAll("table.Petitioner_Advocate_table tr").forEach(row => {
                    const rowData = Array.from(row.querySelectorAll("td")).map(td => td.innerText.trim());
                    if (rowData.length) result.petitionerAdvocate.push(rowData);
                });

                document.querySelectorAll("table.Respondent_Advocate_table tr").forEach(row => {
                    const rowData = Array.from(row.querySelectorAll("td")).map(td => td.innerText.trim());
                    if (rowData.length) result.respondentAdvocate.push(rowData);
                });

                document.querySelectorAll("table.acts_table tr").forEach(row => {
                    const rowData = Array.from(row.querySelectorAll("th, td")).map(cell => cell.innerText.trim());
                    if (rowData.length) result.actsAndSections.push(rowData);
                });

                document.querySelectorAll("table.IAheading tr").forEach(row => {
                    const rowData = Array.from(row.querySelectorAll("th, td")).map(cell => cell.innerText.trim());
                    if (rowData.length) result.iaStatus.push(rowData);
                });

                document.querySelectorAll("table.history_table tr").forEach(row => {
                    const rowData = Array.from(row.querySelectorAll("th, td")).map(cell => cell.innerText.trim());
                    if (rowData.length) result.caseHistory.push(rowData);
                });

                return result;
            });

            // Scrape multiple business dates
            const businessDetails = await scrapeMultipleBusinessDates(page);
            allTableData.caseBusinessDetails = businessDetails;

            caseData = formatCaseData(allTableData);
            console.log("[INFO] Data formatted successfully");

            success = true;

            const endTime = Date.now();
            console.log(`[INFO] Time taken to scrape CNR ${cnrNumber}: ${(endTime - startTime) / 1000} seconds.`);

        } catch (error) {
            console.log("[ERROR]", error);
        } finally {
            try {
                await page.close();
            } catch (error) {
                console.log("[WARN] Error closing page:", error.message);
            }
        }

        attempt++;
    }

    if (!success) {
        console.log(`[ERROR] Failed to process CNR ${cnrNumber} after ${maxAttempts} attempts.`);
        return null;
    }

    return caseData;
}

function formatCaseData(rawData) {
    let caseDetails = {};
    rawData.caseDetails.forEach(row => {
        if (row[0] === 'Case Type') {
            caseDetails.case_type = row[1];
        } else if (row[0] === 'Filing Number') {
            caseDetails.filing_number = row[1];
            caseDetails.filing_date = row[3];
        } else if (row[0] === 'Registration Number') {
            caseDetails.registration_number = row[1];
            caseDetails.registration_date = row[3];
        } else if (row[0] === 'CNR Number') {
            caseDetails.cnr_number = row[1].split(' (')[0];
        }
    });

    
    let caseStatus = {};
    rawData.caseStatus.forEach(row => {
        if (row[0] === 'First Hearing Date') {
            caseStatus.first_hearing_date = row[1];
        } else if (row[0] === 'Next Hearing Date') {
            caseStatus.next_hearing_date = row[1];
        } else if (row[0] === 'Case Stage') {
            caseStatus.case_stage = row[1];
        } else if (row[0] === 'Court Number and Judge') {
            caseStatus.court_number_judge = row[1];
        }
    });


    let litigantsAndAdvocates = {
        petitioners: [], 
        respondents: []  
    };
    
  
    rawData.petitionerAdvocate.forEach(row => {
        if (!row[0]) return;
        
        const text = row[0];
        const matches = text.match(/(\d+\)\s+[^\n]+)\n\s*Advocate[- :]+([^\n]+)/g);
        
        if (matches) {
            matches.forEach(match => {
                const parts = match.split(/\n\s*Advocate[- :]+/);
                const petitionerName = parts[0].replace(/^\d+\)\s+/, '').trim();
                const advocateName = parts[1].trim();
                
                litigantsAndAdvocates.petitioners.push({
                    name: petitionerName,
                    advocate: advocateName
                });
            });
        }
    });
    
 
    rawData.respondentAdvocate.forEach(row => {
        if (!row[0]) return;
        
        const text = row[0];
        const matches = text.match(/(\d+\)\s+[^\n]+)\n\s*Advocate[- :]+([^\n]+)/g);
        
        if (matches) {
            matches.forEach(match => {
                const parts = match.split(/\n\s*Advocate[- :]+/);
                const respondentName = parts[0].replace(/^\d+\)\s+/, '').trim();
                const advocateName = parts[1].trim();
                
                litigantsAndAdvocates.respondents.push({
                    name: respondentName,
                    advocate: advocateName
                });
            });
        }
    });
    let acts = {};
    if (rawData.actsAndSections.length > 1) {
        for (let i = 1; i < rawData.actsAndSections.length; i++) {
            const act = rawData.actsAndSections[i][0];
            const section = rawData.actsAndSections[i][1];
            acts[act] = section;
        }
    }

  
    let iaStatus = {
        ia_number: [],
        party_name: [],
        date_of_filing: [],
        next_date_purpose: [],
        ia_status: []
    };

    if (rawData.iaStatus.length > 1) {
        for (let i = 1; i < rawData.iaStatus.length; i++) {
            const row = rawData.iaStatus[i];
            iaStatus.ia_number.push(row[0] || '');
            iaStatus.party_name.push(row[1] || '');
            iaStatus.date_of_filing.push(row[2] || '');
            iaStatus.next_date_purpose.push(row[3] || '');
            iaStatus.ia_status.push(row[4] || '');
        }
    }


    let caseHistory = {
        judge: [],
        business_on_date: [],
        hearing_date: [],
        purpose: []
    };

    if (rawData.caseHistory.length > 1) {
        for (let i = 1; i < rawData.caseHistory.length; i++) {
            const row = rawData.caseHistory[i];
            caseHistory.judge.push(row[0] || '');
            caseHistory.business_on_date.push(row[1] || '');
            caseHistory.hearing_date.push(row[2] || '');
            caseHistory.purpose.push(row[3] || '');
        }
    }

  
    return {
        case_details: caseDetails,
        case_status: caseStatus,
        litigant_and_advocate: litigantsAndAdvocates,
        acts: acts,
        ia_status: iaStatus,
        case_history: caseHistory
    };
}

async function main() {
    let browser = null;
    const results = [];
    
    try {
        console.log("[INFO] Starting browser...");
        browser = await puppeteer.launch({
            headless: false,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--disable-features=VizDisplayCompositor'
            ]
        });
        
        if (cnrNumbers.length === 0) {
            console.log("[WARN] No CNR numbers provided in the array. Please add CNR numbers to process.");
            return;
        }
        
        console.log(`[INFO] Processing ${cnrNumbers.length} CNR numbers...`);
        
        for (const cnrNumber of cnrNumbers) {
            const result = await processCNR(cnrNumber, browser);
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
        console.error("[ERROR] Main process error:", error);
    } finally {
        if (browser) {
            try {
                await browser.close();
                console.log("[INFO] Browser closed");
            } catch (error) {
                console.error("[ERROR] Error closing browser:", error);
            }
        }
    }
}

main();