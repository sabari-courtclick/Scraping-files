import puppeteer from 'puppeteer';
import { createWorker } from 'tesseract.js';
import sharp from 'sharp';
import * as cheerio from 'cheerio';

export default class Scraper {
  constructor() {
    this.baseUrl = 'https://services.ecourts.gov.in/ecourtindia_v6/';
    this.browser = null;
    this.page = null;
    this.session = null;
    this.captchaCache = new Map();
    this.appToken = null;
  }

  async initializeSession() {
    console.log('Launching browser...');
    this.browser = await puppeteer.launch({ 
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--window-size=1920,1080'
      ] 
    });
    this.page = await this.browser.newPage();
    
    // Set viewport for better rendering
    await this.page.setViewport({ width: 1920, height: 1080 });

    // Set headers to mimic a real browser
    await this.page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
    );

    // Set additional headers
    await this.page.setExtraHTTPHeaders({
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1'
    });

    // Navigate to the homepage
    console.log('Navigating to homepage...');
    await this.page.goto(this.baseUrl, { 
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });

    // Wait for the page to be fully loaded
    await this.page.waitForSelector('body', { visible: true, timeout: 10000 });
    
    // Wait for network to be idle
    await this.page.waitForNetworkIdle({ timeout: 10000, idleTime: 1000 });

    // Get cookies for session management
    const cookies = await this.page.cookies();
    this.session = cookies;

    console.log('Search field found, proceeding with scraping...');
  }

  async solveCaptcha(maxRetries = 3) {
    let attempt = 0;
    while (attempt < maxRetries) {
      try {
        console.log(`Solving CAPTCHA (Attempt ${attempt + 1})...`);
        
        // Wait for captcha to be visible
        await this.page.waitForSelector('#captcha_image', { visible: true, timeout: 5000 });
        
        // Get CAPTCHA image
        const captchaElement = await this.page.$('#captcha_image');
        const captchaBuffer = await captchaElement.screenshot();

        // Check cache first
        const cacheKey = captchaBuffer.toString('base64');
        if (this.captchaCache.has(cacheKey)) {
          console.log('Using cached CAPTCHA solution');
          return this.captchaCache.get(cacheKey);
        }

        // Preprocess CAPTCHA image
        const processedImage = await sharp(captchaBuffer)
          .greyscale()
          .threshold(128)
          .sharpen({ sigma: 1.5, flat: 1, jagged: 2 })
          .toBuffer();

        // Save processed image for debugging
        await sharp(processedImage).toFile(`captcha_processed_${attempt}.png`);

        // OCR with Tesseract.js
        const worker = await createWorker();
        await worker.loadLanguage('eng');
        await worker.initialize('eng');
        await worker.setParameters({
          tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
          tessedit_pageseg_mode: '7',
          tessjs_create_pdf: '0',
          tessjs_create_hocr: '0',
          tessjs_create_tsv: '0',
          tessjs_create_box: '0',
          tessjs_create_unlv: '0',
          tessjs_create_osd: '0',
          tessjs_create_psm: '7',
          tessjs_create_ocr: '1'
        });

        const { data: { text } } = await worker.recognize(processedImage);
        await worker.terminate();

        const captchaText = text.replace(/[^a-zA-Z0-9]/g, '').trim();

        if (!captchaText || captchaText.length < 4 || captchaText.length > 8) {
          throw new Error('Invalid CAPTCHA text length');
        }

        // Cache the solution
        this.captchaCache.set(cacheKey, captchaText);
        console.log('Solved CAPTCHA:', captchaText);
        return captchaText;
      } catch (error) {
        attempt++;
        console.error(`CAPTCHA solving failed (Attempt ${attempt}):`, error.message);

        // Check if refresh captcha button exists
        const refreshButton = await this.page.$('a[onclick="refreshCaptcha()"]');
        if (refreshButton) {
          await refreshButton.click();
          await new Promise(resolve => setTimeout(resolve, 1000));
        }

        if (attempt >= maxRetries) {
          throw new Error(`Failed to solve CAPTCHA after ${maxRetries} attempts`);
        }
        
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
  }

  async fetchCaseDetails(cnr, maxRetries = 3) {
    let attempt = 0;
    while (attempt < maxRetries) {
      try {
        console.log(`Attempt ${attempt + 1} for CNR: ${cnr}`);

        // Get app token if not already present
        if (!this.appToken) {
          await this._getAppToken();
        }

        // Get CAPTCHA
        const captchaBuffer = await this.getCaptcha();
        
        // Solve CAPTCHA
        const captchaText = await this.solveCaptcha();

        // Prepare form data
        const formData = new FormData();
        formData.append('cnr', cnr);
        formData.append('captcha', captchaText);
        formData.append('app_token', this.appToken);

        // Make API request
        const response = await fetch(`${this.baseUrl}searchByCNR`, {
          method: 'POST',
          body: formData,
          headers: {
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.5',
            'Connection': 'keep-alive',
            'Upgrade-Insecure-Requests': '1'
          }
        });

        const responseData = await response.text();

        // Check for error messages
        if (responseData.includes('Invalid CNR Number') || 
            responseData.includes('Invalid Captcha') || 
            responseData.includes('error_message')) {
          const errorMatch = responseData.match(/<div class="error_message">([^<]+)<\/div>/);
          const errorMessage = errorMatch ? errorMatch[1].trim() : 'Unknown error';
          throw new Error(`Website returned error: ${errorMessage}`);
        }

        // Parse case details
        const caseDetails = this.parseCaseDetails(responseData);
        
        if (!caseDetails.courtName && !caseDetails.case_type) {
          throw new Error('No case details found in the response');
        }

        // If case details are found, fetch case history
        if (caseDetails.cnr_number) {
          try {
            const caseHistory = await this.fetchCaseHistory(caseDetails);
            caseDetails.case_history = caseHistory;
          } catch (historyError) {
            console.error('Error fetching case history:', historyError.message);
            // Continue with basic case details
          }
        }
        
        return caseDetails;
      } catch (error) {
        attempt++;
        console.error(`Attempt ${attempt} failed:`, error.message);

        // Get a fresh token for retry
        await this._getAppToken();

        if (attempt >= maxRetries) {
          throw new Error(`Failed after ${maxRetries} attempts: ${error.message}`);
        }

        // Exponential backoff
        const delay = Math.min(1000 * Math.pow(2, attempt), 10000);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  async _getAppToken(maxRetries = 3) {
    console.log('Getting app token...');
    let attempt = 0;

    while (attempt < maxRetries) {
      try {
        const response = await fetch(this.baseUrl);
        const html = await response.text();
        
        // Extract app_token from HTML
        const tokenMatch = html.match(/var\s+app_token\s*=\s*['"]([^'"]+)['"]/);
        if (tokenMatch && tokenMatch[1]) {
          this.appToken = tokenMatch[1];
          console.log('App token obtained');
          return this.appToken;
        }
        
        throw new Error('App token not found in response');
      } catch (error) {
        attempt++;
        console.error(`Attempt ${attempt} to get app token failed:`, error.message);
        
        if (attempt >= maxRetries) {
          throw new Error('Failed to get app token after multiple attempts');
        }
        
        // Wait before retrying
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
  }

  async getCaptcha(maxRetries = 3) {
    console.log('Getting CAPTCHA...');
    let attempt = 0;

    while (attempt < maxRetries) {
      try {
        // Make sure we have an app token
        if (!this.appToken) {
          await this._getAppToken();
        }

        // Request CAPTCHA image
        const response = await fetch(`${this.baseUrl}getCaptcha`, {
          method: 'POST',
          body: new URLSearchParams({
            app_token: this.appToken
          }),
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
          }
        });

        if (!response.ok) {
          throw new Error(`Failed to get CAPTCHA: ${response.status}`);
        }

        const captchaBuffer = await response.arrayBuffer();
        return Buffer.from(captchaBuffer);
      } catch (error) {
        attempt++;
        console.error(`Attempt ${attempt} to get CAPTCHA failed:`, error.message);
        
        if (attempt >= maxRetries) {
          throw new Error('Failed to get CAPTCHA after multiple attempts');
        }
        
        // Refresh app token and retry
        await this._getAppToken();
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
  }

  async fetchCaseHistory(caseDetails) {
    console.log('Fetching case history...');
    try {
      // Get a fresh token for history request
      await this._getAppToken();
      
      // Get court codes from CNR number
      const cnr = caseDetails.cnr_number;
      const stateCode = cnr.substring(0, 2);
      const districtCode = cnr.substring(2, 4);
      const courtCode = cnr.substring(4, 8);
      const caseNumber = cnr.substring(8);

      // Prepare form data
      const formData = new FormData();
      formData.append('state_code', stateCode);
      formData.append('dist_code', districtCode);
      formData.append('court_code', courtCode);
      formData.append('case_no', caseNumber);
      formData.append('cino', cnr);
      formData.append('app_token', this.appToken);

      // Make request to business endpoint
      const businessResponse = await fetch(`${this.baseUrl}business`, {
        method: 'GET',
        headers: {
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
          'Connection': 'keep-alive',
          'Upgrade-Insecure-Requests': '1'
        }
      });

      // Post to viewBusiness endpoint
      const historyResponse = await fetch(`${this.baseUrl}viewBusiness`, {
        method: 'POST',
        body: formData,
        headers: {
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
          'Connection': 'keep-alive',
          'Upgrade-Insecure-Requests': '1'
        }
      });

      const historyHtml = await historyResponse.text();
      return this._parseCaseHistory(historyHtml);
    } catch (error) {
      console.error('Error in fetchCaseHistory:', error.message);
      return [];
    }
  }

  parseCaseDetails(html) {
    const $ = cheerio.load(html);
    const caseDetails = {
      html_content: html,  // Store the HTML content
      cnr_number: null,
      case_type: null,
      filing_number: null,
      filing_date: null,
      registration_number: null,
      registration_date: null,
      case_status: null,
      disposal_nature: null,
      disposal_date: null,
      decision_date: null,
      court_number_and_judge: null,
      petitioner_name: null,
      petitioner_advocate: null,
      respondent_name: null,
      respondent_advocate: null,
      under_acts: null,
      under_sections: null,
      first_hearing_date: null,
      case_history: [],
      transfer_details: [],
      ia_details: [],
      court_name: null
    };

    // Extract court name from the heading
    caseDetails.courtName = $('#chHeading').text().trim();

    // Parse case details table
    $('.case_details_table tr').each((i, row) => {
      const cols = $(row).find('td');
      if (cols.length >= 2) {
        const label = $(cols[0]).text().trim().toLowerCase();
        const value = $(cols[1]).text().trim();
        
        if (label.includes('case type')) {
          caseDetails.case_type = value;
        } else if (label.includes('filing number')) {
          caseDetails.filing_number = value;
          if (cols.length >= 4) {
            caseDetails.filing_date = $(cols[3]).text().trim();
          }
        } else if (label.includes('registration number')) {
          caseDetails.registration_number = value;
          if (cols.length >= 4) {
            caseDetails.registration_date = $(cols[3]).text().trim();
          }
        } else if (label.includes('cnr number')) {
          // Extract only the 16-character CNR number
          caseDetails.cnr_number = value.substring(0, 16);
        }
      }
    });

    // Parse case status table
    $('.case_status_table tr').each((i, row) => {
      const cols = $(row).find('td');
      if (cols.length >= 2) {
        const label = $(cols[0]).text().trim().toLowerCase();
        const value = $(cols[1]).text().trim();
        
        if (label.includes('first hearing date')) {
          caseDetails.first_hearing_date = value;
        } else if (label.includes('decision date')) {
          caseDetails.decision_date = value;
          if (caseDetails.case_status === 'Case disposed') {
            caseDetails.disposal_date = value;
          }
        } else if (label.includes('case status')) {
          caseDetails.case_status = value;
        } else if (label.includes('nature of disposal')) {
          caseDetails.disposal_nature = value;
        } else if (label.includes('court number and judge')) {
          caseDetails.court_number_and_judge = value;
        }
      }
    });

    // Parse petitioner and advocate details
    $('.Petitioner_Advocate_table tr').each((i, row) => {
      const text = $(row).find('td').text().trim();
      const parts = text.split('Advocate-');
      if (parts.length >= 2) {
        caseDetails.petitioner_name = parts[0].trim();
        caseDetails.petitioner_advocate = parts[1].trim();
      } else {
        caseDetails.petitioner_name = text;
      }
    });

    // Parse respondent and advocate details
    $('.Respondent_Advocate_table tr').each((i, row) => {
      const text = $(row).find('td').text().trim();
      const parts = text.split('Advocate-');
      if (parts.length >= 2) {
        caseDetails.respondent_name = parts[0].trim();
        caseDetails.respondent_advocate = parts[1].trim();
      } else {
        caseDetails.respondent_name = text;
      }
    });

    // Parse acts and sections
    const acts = [];
    const sections = [];
    $('#act_table tr').each((i, row) => {
      if (i === 0) return; // Skip header row
      const cols = $(row).find('td');
      if (cols.length >= 2) {
        const act = $(cols[0]).text().trim().replace(/\\$/, '');
        const section = $(cols[1]).text().trim();
        if (act) acts.push(act);
        if (section) sections.push(section);
      }
    });
    caseDetails.under_acts = acts.join(',') || null;
    caseDetails.under_sections = sections.join(',') || null;

    // Parse case history
    $('.history_table tr').each((i, row) => {
      if (i === 0) return; // Skip header row
      const cols = $(row).find('td');
      if (cols.length >= 4) {
        const historyEntry = {
          judge: $(cols[0]).text().trim(),
          business_date: $(cols[1]).text().trim().split('\n')[0],
          hearing_date: $(cols[2]).text().trim(),
          purpose: $(cols[3]).text().trim()
        };
        if (Object.values(historyEntry).some(val => val)) {
          caseDetails.case_history.push(historyEntry);
        }
      }
    });

    // Parse transfer details
    $('.transfer_table tr').each((i, row) => {
      if (i === 0) return; // Skip header row
      const cols = $(row).find('td');
      if (cols.length >= 4) {
        const transferEntry = {
          registration_number: $(cols[0]).text().trim(),
          transfer_date: $(cols[1]).text().trim(),
          from_court: $(cols[2]).text().trim(),
          to_court: $(cols[3]).text().trim()
        };
        caseDetails.transfer_details.push(transferEntry);
      }
    });

    // Parse IA details
    $('.IAheading tr').each((i, row) => {
      if (i === 0) return; // Skip header row
      const cols = $(row).find('td');
      if (cols.length >= 5) {
        const iaNo = $(cols[0]).text().trim();
        const partyRaw = $(cols[1]).text().trim();
        const dtFiling = $(cols[2]).text().trim();
        const nextDatePurpose = $(cols[3]).text().trim();
        const iaStatus = $(cols[4]).text().trim();

        const partyName = partyRaw.replace(/<br\/>/g, ' ').trim();
        
        let nextDate = '';
        let purpose = '';
        if (nextDatePurpose) {
          const parts = nextDatePurpose.split('(');
          nextDate = parts[0].trim();
          purpose = parts[1] ? parts[1].replace(')', '').trim() : '';
        }

        const iaEntry = {
          ia_no: iaNo,
          party: partyName,
          dt_filing: dtFiling,
          next_date: nextDate,
          purpose: purpose,
          ia_status: iaStatus,
          classification: 'General'
        };
        caseDetails.ia_details.push(iaEntry);
      }
    });

    return caseDetails;
  }

  async close() {
    if (this.browser) {
      await this.browser.close();
    }
  }
}