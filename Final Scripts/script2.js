import puppeteer from "puppeteer";
import axios from "axios"; // You'll need to add this dependency
import dotenv from 'dotenv';
dotenv.config();

const baseUrl = process.env.baseUrl; 
const cnrNumbers = ['KLKN220007192019','KLWD030000802019','KLKK010067682024','KLER150000052020'];
const API_KEY = process.env.apiKey;
const CAPTCHA_API_URL = "https://2captcha.com/in.php";
const CAPTCHA_RESULT_URL = "https://2captcha.com/res.php";
const MAX_CAPTCHA_RETRIES = 3;
const CAPTCHA_CHECK_INTERVAL = 2000; // 2 seconds

// Direct API call to 2captcha for submitting captcha
async function submitCaptcha(base64Image) {
    try {
        const response = await axios({
            method: 'post',
            url: CAPTCHA_API_URL,
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            data: `key=${API_KEY}&method=base64&body=${encodeURIComponent(base64Image)}&json=1`
        });

        if (response.data.status === 0) {
            throw new Error(`2captcha error: ${response.data.request}`);
        }

        return response.data.request; // Returns captcha ID
    } catch (error) {
        throw new Error(`Error submitting captcha: ${error.message}`);
    }
}

// Direct API call to 2captcha for getting captcha result
async function getCaptchaResult(captchaId) {
    try {
        const response = await axios({
            method: 'get',
            url: `${CAPTCHA_RESULT_URL}?key=${API_KEY}&action=get&id=${captchaId}&json=1`
        });

        return response.data;
    } catch (error) {
        throw new Error(`Error getting captcha result: ${error.message}`);
    }
}

// Poll for captcha result with timeout
async function pollForCaptchaResult(captchaId, maxWaitTime = 30000) {
    const startTime = Date.now();
    
    while (Date.now() - startTime < maxWaitTime) {
        const result = await getCaptchaResult(captchaId);
        
        if (result.status === 0 && result.request === "CAPCHA_NOT_READY") {
            // Captcha not ready, wait and try again
            await new Promise(resolve => setTimeout(resolve, CAPTCHA_CHECK_INTERVAL));
            continue;
        }
        
        if (result.status === 0) {
            // Error occurred
            throw new Error(`2captcha error: ${result.request}`);
        }
        
        // Captcha solved
        return result.request;
    }
    
    throw new Error(`Captcha solving timeout after ${maxWaitTime/1000} seconds`);
}

// Solve captcha using direct API calls
async function solveCaptchaWithDirectAPI(base64Image) {
    console.log("[INFO] Submitting captcha to 2captcha service...");
    const captchaId = await submitCaptcha(base64Image);
    console.log(`[INFO] Captcha submitted successfully. ID: ${captchaId}`);
    
    console.log("[INFO] Polling for captcha result...");
    const captchaText = await pollForCaptchaResult(captchaId);
    console.log(`[INFO] Captcha solved: ${captchaText}`);
    
    return captchaText;
}

async function processCNR(cnrNumber, browser) {
    console.time(`CNR_${cnrNumber}_Total`);
    const page = await browser.newPage();

    try {
        await page.goto(baseUrl);
        
        const hasError = await page.evaluate(() => {
            return document.body.innerText.includes("Oops") && document.body.innerText.includes("Invalid Request");
        });
        
        if (hasError) {
            console.log("[WARN] 'Oops! Invalid Request' page detected. Clicking the refresh link...");
            const refreshLink = await page.$("div#msg-danger a");
        
            if (refreshLink) {
                await refreshLink.click();
                await new Promise(resolve => setTimeout(resolve, 2000)); 
            } else {
                console.log("[ERROR] Refresh link not found! Reloading manually...");
                await page.reload({ waitUntil: "networkidle2" });
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }
        
        let captchaSuccess = false;
        let captchaAttempts = 0;
        
        while (!captchaSuccess && captchaAttempts < MAX_CAPTCHA_RETRIES) {
            captchaAttempts++;
            console.log(`[INFO] CAPTCHA attempt ${captchaAttempts}/${MAX_CAPTCHA_RETRIES}`);
            
            try {
                await page.waitForSelector("#captcha_image");
                const captchaElement = await page.$("#captcha_image");
                const base64Image = await captchaElement.screenshot({ 
                    encoding: "base64", 
                    omitBackground: true 
                });
                
                console.time(`CAPTCHA_Solving_${cnrNumber}_Attempt${captchaAttempts}`);
                
                let captchaText;
                try {
                    captchaText = await solveCaptchaWithDirectAPI(base64Image);
                } catch (captchaError) {
                    console.log("[ERROR] 2captcha service error:", captchaError.message);
                    
                    // Check for token expiration or other API issues
                    if (captchaError.message.includes("ERROR_ZERO_BALANCE") || 
                        captchaError.message.includes("ERROR_KEY_DOES_NOT_EXIST") ||
                        captchaError.message.includes("ERROR_IP_NOT_ALLOWED")) {
                        console.log("[ERROR] API key issue detected. Please check your 2captcha account/API key.");
                        throw new Error("2captcha API key issue. Please check your account.");
                    }
                    
                    continue; // Try next CAPTCHA attempt
                }
                
                console.timeEnd(`CAPTCHA_Solving_${cnrNumber}_Attempt${captchaAttempts}`);
                
                // Clear existing value and enter CAPTCHA
                await page.$eval("#fcaptcha_code", el => el.value = "");
                await page.type("#fcaptcha_code", captchaText);
                console.log("[INFO] CAPTCHA text entered");
                
                // Clear existing value and enter CNR number
                await page.$eval("#cino", el => el.value = "");
                await page.type("#cino", cnrNumber);
                console.log("[INFO] CNR number entered:", cnrNumber);

                console.log("[INFO] Clicking search button...");
                await page.click("#searchbtn");
                
                // Wait a moment to check for error messages
                await page.waitForTimeout(2000);
                
                // Check for invalid CAPTCHA error
                const invalidCaptcha = await page.evaluate(() => {
                    const errorModal = document.querySelector(".modal-body .alert-danger-cust");
                    return errorModal && errorModal.innerText.includes("Invalid Captcha");
                });
                
                if (invalidCaptcha) {
                    console.log("[WARN] Invalid CAPTCHA detected, retrying...");
                    
                    // Close the error modal if it exists
                    const backButton = await page.$("#main_back_cnr");
                    if (backButton) {
                        await backButton.click();
                        await page.waitForTimeout(1000);
                    }
                    
                    continue; // Try next CAPTCHA attempt
                }
                
                // Wait for case details or error message
                try {
                    await page.waitForSelector('table.case_details_table', { timeout: 5000 });
                    captchaSuccess = true;
                    console.log("[INFO] CAPTCHA solved successfully!");
                } catch (timeoutError) {
                    console.log("[WARN] Case details not found, checking for errors...");
                    
                    // If no case details found, check if it's due to CAPTCHA or other error
                    const hasError = await page.evaluate(() => {
                        return document.body.innerText.includes("Invalid Captcha");
                    });
                    
                    if (hasError) {
                        console.log("[WARN] Invalid CAPTCHA confirmed, retrying...");
                        
                        // Try to go back to the search page
                        const backButton = await page.$("#main_back_cnr");
                        if (backButton) {
                            await backButton.click();
                            await page.waitForTimeout(1000);
                        } else {
                            await page.goto(baseUrl);
                        }
                    } else {
                        // If not CAPTCHA error, might be valid "no results" response
                        captchaSuccess = true;
                        console.log("[INFO] No case details found, but CAPTCHA appears valid.");
                    }
                }
                
            } catch (error) {
                console.log(`[ERROR] CAPTCHA attempt ${captchaAttempts} failed:`, error.message);
                
                // Try to refresh the page for next attempt
                try {
                    await page.goto(baseUrl);
                    await page.waitForTimeout(2000);
                } catch (refreshError) {
                    console.log("[ERROR] Failed to refresh page:", refreshError.message);
                }
            }
        }
        
        if (!captchaSuccess) {
            console.log(`[ERROR] Failed to solve CAPTCHA after ${MAX_CAPTCHA_RETRIES} attempts for CNR ${cnrNumber}`);
            return null;
        }
        
        // Successful CAPTCHA flow continues here
        console.log("[INFO] Case details loaded successfully. Scraping table data...");

        const allTableData = await page.evaluate(() => {
            const result = {
                caseDetails: [],
                caseStatus: [],
                petitionerAdvocate: [],
                respondentAdvocate: [],
                actsAndSections: [],
                iaStatus: [],
                subCourtDetails:[],
                firDetails:[],
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

            document.querySelectorAll("table.Lower_court_table tr").forEach(row => {
                const rowData = Array.from(row.querySelectorAll("th, td")).map(cell => cell.innerText.trim());
                if (rowData.length) result.subCourtDetails.push(rowData);
            });

            document.querySelectorAll("table.FIR_details_table tr").forEach(row => {
                const rowData = Array.from(row.querySelectorAll("th, td")).map(cell => cell.innerText.trim());
                if (rowData.length) result.firDetails.push(rowData);
            });

            document.querySelectorAll("table.history_table tr").forEach(row => {
                const rowData = Array.from(row.querySelectorAll("th, td")).map(cell => cell.innerText.trim());
                if (rowData.length) result.caseHistory.push(rowData);
            });
            
            return result;
        });

        console.log("[INFO] Data formatted successfully");
        return allTableData;

    } catch (error) {
        console.log(`[ERROR] Processing CNR ${cnrNumber} failed:`, error.message);
        return null;
    } finally {
        try {
            await page.close();
            console.timeEnd(`CNR_${cnrNumber}_Total`);
        } catch (error) {
            console.log("[WARN] Error closing page:", error.message);
        }
    }
}

async function main() {
    console.time("Total_Execution");
    let browser = null;
    const results = [];
    
    try {
        console.log("[INFO] Starting browser...");
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
                '--disable-blink-features=AutomationControlled' 
            ],
            defaultViewport: { width: 800, height: 600 } 
        });
        
        for (const cnrNumber of cnrNumbers) {
            console.log(`[INFO] Processing CNR: ${cnrNumber}`);
            const result = await processCNR(cnrNumber, browser);
            results.push({
                cnrNumber,
                data: result,
                success: !!result
            });
        }
        
        console.log("[INFO] All CNR numbers processed. Results summary:");
        for (const result of results) {
            console.log(`- CNR ${result.cnrNumber}: ${result.success ? "SUCCESS" : "FAILED"}`);
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
        console.timeEnd("Total_Execution");
    }
}

main();