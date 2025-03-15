import puppeteer from "puppeteer";
import { Solver } from "2captcha-ts"; 
import sharp from "sharp";
import fs from "fs";
import dotenv from 'dotenv'
dotenv.config()
const baseUrl =process.env.baseUrl; 
const cnrNumbers = ['KLKN220007192019','KLWD030000802019','KLKK010067682024','KLER150000052020'];
const API_KEY = process.env.apiKey; 
const solver = new Solver(API_KEY);
const startTime = Date.now();
const runDuration = 30 * 60 * 1000;
let totalAttempts=0

async function handleInvalidRequest(page) {
 const hasError = await page.evaluate(() => {
 return document.body.innerText.includes("Oops") && document.body.innerText.includes("Invalid Request");
 });

 if (hasError) {
 console.log("[WARN] 'Oops! Invalid Request' page detected. Clicking the refresh link...");
 const refreshLink = await page.$("div#msg-danger a");

 if (refreshLink) {
 await refreshLink.click();
 await page.waitForNavigation({ waitUntil: "networkidle2" });
 } else {
 console.log("[ERROR] Refresh link not found! Reloading manually...");
 await page.reload({ waitUntil: "networkidle2" });
 }
 }
}



async function solveCaptcha(page) {
 const captchaElement = await page.$("#captcha_image");
 const base64Image = await captchaElement.screenshot({
 encoding: "base64",
 omitBackground: true,
 });
 const imageBuffer = Buffer.from(base64Image, "base64");

 const enhancedImageBuffer = await sharp(imageBuffer)
 .resize({ width: 300, height: 100 })
 .grayscale() 
 .sharpen() 
 .normalize()
 .toFormat("png") 
 .toBuffer();
 const enhancedBase64 = enhancedImageBuffer.toString("base64");

 console.log("[INFO] Sending enhanced CAPTCHA to 2Captcha service...");
 const captchaResult = await solver.imageCaptcha({
 method: "base64",
 body: enhancedBase64,
 });

 return captchaResult.data;
}
 

async function processCNR(cnrNumber,page) {
 const maxAttempts=3;
 let attempt=0;
 let success=false
 let caseData=null;
 while(attempt<maxAttempts && !success)
 try {

 await handleInvalidRequest(page)
 await page.waitForSelector("#captcha_image")
 const captchaText = await solveCaptcha(page);
 console.log("[INFO] 2captcha solution received:", captchaText);
 
 await page.type("#fcaptcha_code", captchaText);
 console.log("[INFO] CAPTCHA text entered");
 await page.waitForSelector("#cino");
 await page.focus("#cino"); 
 await page.evaluate(() => {
 const input = document.querySelector("#cino");
 if (input) input.value = '';
 });
 
 await page.click("#cino");
 await page.type("#cino", cnrNumber);
 console.log("[INFO] CNR number entered:", cnrNumber);

 console.log("[INFO] Clicking search button...");
 await page.click("#searchbtn");


 let caseDetailsExists = await page.waitForSelector('table.case_details_table', { timeout: 3000 }).catch(() => null);

if (!caseDetailsExists) {
 console.log("[WARN] Case details not found, retrying...");
 await page.reload({ waitUntil: "networkidle2" });
 await handleInvalidRequest(page) 
} else {
 console.log("[INFO] Case details loaded successfully. Scraping table data...");
 totalAttempts++;
 console.log(totalAttempts)
 const allTableData = await page.evaluate(() => {
 const result = {
 caseDetails: [],
 caseStatus: [],
 petitionerAdvocate: [],
 respondentAdvocate: [],
 actsAndSections: [],
 iaStatus: [],
 subCourtDetails: [],
 firDetails: [],
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


 document.querySelectorAll("table.Lower_court_table tr").forEach(row=>{
 const rowData=Array.from(row.querySelectorAll("th, td")).map(cell => cell.innerText.trim());
 if (rowData.length) result.subCourtDetails.push(rowData);
 })

 document.querySelectorAll("table.FIR_details_table tr").forEach(row=>{
 const rowData=Array.from(row.querySelectorAll("th, td")).map(cell => cell.innerText.trim());
 if (rowData.length) result.firDetails.push(rowData);
 })

 document.querySelectorAll("table.history_table tr").forEach(row => {
 const rowData = Array.from(row.querySelectorAll("th, td")).map(cell => cell.innerText.trim());
 if (rowData.length) result.caseHistory.push(rowData);
 });
 return result;
 });

 
 success = true;
 caseData = formatCaseData(allTableData);
 await page.click("#main_back_cnr");
 await new Promise(resolve => setTimeout(resolve, 2000));
 await page.reload({ waitUntil: "networkidle2" });
 }

 } catch (error) {
 console.log("[ERROR]", error);
 } 
 attempt++;
 

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
 headless: true, 
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
 
 
 const page = await browser.newPage();
 await page.goto(baseUrl)
 while (Date.now() - startTime < runDuration) {
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
 }
 console.log("Total Attempts",totalAttempts)
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