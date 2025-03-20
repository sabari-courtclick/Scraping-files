import axios from 'axios';
import FormData from 'form-data';
import fs from 'fs';
import { createWorker } from 'tesseract.js';
import sharp from 'sharp';
import * as cheerio from 'cheerio';

export default class Scraper {
  constructor() {
    this.baseUrl = 'https://services.ecourts.gov.in/ecourtindia_v6/';
    this.appToken = null;
    this.session = axios.create({
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
        'Accept-Language': 'en-US,en;q=0.9',
        'Connection': 'keep-alive',
        'Cache-Control': 'max-age=0',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1'
      },
      maxRedirects: 5,
      withCredentials: true
    });
  }

  async initializeSession() {
    console.log('Initializing session...');
    let attempt = 0;
    const maxRetries = 3;

    while (attempt < maxRetries) {
      try {
        // Get initial page to set up session
        console.log(`Attempt ${attempt + 1}: Loading initial page...`);
        const response = await this.session.get(this.baseUrl);
        
        // Log response for debugging
        console.log(`Initial page response status: ${response.status}`);
        
        // Save the HTML for debugging
        fs.writeFileSync('initial_page.html', response.data);
        console.log('Saved initial page HTML to initial_page.html');
        
        // Extract app token using Python's approach
        const responseText = response.data;
        if (responseText.includes('app_token')) {
          const tokenStart = responseText.indexOf('app_token') + 'app_token'.length + 2;
          const tokenEnd = responseText.indexOf('"', tokenStart);
          this.appToken = responseText.substring(tokenStart, tokenEnd);
          
          console.log(`App token obtained successfully: ${this.appToken}`);
          
          // Verify token is valid
          if (this.appToken && this.appToken.length >= 10) {
            return;
          } else {
            console.log('Token too short or invalid:', this.appToken);
          }
        }

        // If we get here, token wasn't found or was invalid
        console.warn(`Attempt ${attempt + 1}: App token not found in response`);
        console.log('Response data excerpt:', responseText.substring(0, 1000) + '...');
        
        attempt++;
        if (attempt < maxRetries) {
          console.log(`Retrying in 3 seconds...`);
          await new Promise(resolve => setTimeout(resolve, 3000));
        }
      } catch (error) {
        console.error(`Attempt ${attempt + 1} failed:`, error.message);
        attempt++;
        
        if (attempt < maxRetries) {
          console.log(`Retrying in 3 seconds...`);
          await new Promise(resolve => setTimeout(resolve, 3000));
        }
      }
    }

    throw new Error('Failed to initialize session after multiple attempts');
  }

  async _getAppTokenAndCaptcha(maxRetries = 3) {
    console.log('Getting app token and CAPTCHA...');
    let attempt = 0;

    while (attempt < maxRetries) {
      try {
        // Get main page to get cookies and app token
        const response = await this.session.get(this.baseUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
            'Accept-Language': 'en-US,en;q=0.9',
            'Connection': 'keep-alive',
            'Upgrade-Insecure-Requests': '1'
          }
        });
        
        // Save HTML for debugging
        fs.writeFileSync('token_page.html', response.data);
        
        // Extract app token using Python's approach
        const responseText = response.data;
        if (responseText.includes('app_token')) {
          const tokenStart = responseText.indexOf('app_token') + 'app_token'.length + 2;
          const tokenEnd = responseText.indexOf('"', tokenStart);
          this.appToken = responseText.substring(tokenStart, tokenEnd);
          console.log(`Successfully retrieved new app token: ${this.appToken}`);
          
          // Get CAPTCHA directly
          const captchaResponse = await this.session.post(
            `${this.baseUrl}vendor/securimage/securimage_show.php`,
            null,
            {
              headers: {
                'Referer': this.baseUrl,
                'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                'Connection': 'keep-alive',
                'Sec-Fetch-Site': 'same-origin',
                'Sec-Fetch-Mode': 'no-cors',
                'Sec-Fetch-Dest': 'image'
              },
              responseType: 'arraybuffer'
            }
          );

          if (captchaResponse.status === 200 && captchaResponse.headers['content-type'].startsWith('image/')) {
            // Save CAPTCHA for debugging
            fs.writeFileSync('last_captcha.png', captchaResponse.data);
            console.log('CAPTCHA image saved to last_captcha.png');
            
            // Process CAPTCHA image
            const captchaBuffer = Buffer.from(captchaResponse.data);
            const processedImage = await sharp(captchaBuffer)
              .greyscale()
              .modulate({ brightness: 1.5, contrast: 2 })
              .threshold(128)
              .toBuffer();

            // Save processed image for debugging
            await sharp(processedImage).toFile('last_captcha_processed.png');

            // OCR with Tesseract.js
            const worker = await createWorker();
            await worker.loadLanguage('eng');
            await worker.initialize('eng');
            await worker.setParameters({
              tessedit_char_whitelist: '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz',
              tessedit_pageseg_mode: '8',
              tessjs_create_pdf: '0',
              tessjs_create_hocr: '0',
              tessjs_create_tsv: '0',
              tessjs_create_box: '0',
              tessjs_create_unlv: '0',
              tessjs_create_osd: '0',
              tessjs_create_psm: '8',
              tessjs_create_ocr: '1'
            });

            const { data: { text } } = await worker.recognize(processedImage);
            await worker.terminate();

            const captchaText = text.replace(/[^a-zA-Z0-9]/g, '').trim();
            if (captchaText && captchaText.length >= 4) {
              console.log('Successfully extracted CAPTCHA text:', captchaText);
              return { success: true, captchaText };
            } else {
              console.warn('Invalid CAPTCHA text extracted:', captchaText);
            }
          } else {
            console.warn('Failed to get CAPTCHA image:', captchaResponse.status);
          }
        } else {
          console.warn('Failed to find app token in page');
        }
        
        throw new Error('Failed to get CAPTCHA or app token');
      } catch (error) {
        attempt++;
        console.error(`Attempt ${attempt} failed:`, error.message);
        
        if (attempt >= maxRetries) {
          return { success: false, error: error.message };
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

        // Get fresh token and CAPTCHA
        const { success, captchaText, error } = await this._getAppTokenAndCaptcha();
        if (!success) {
          console.error('Failed to get app token and CAPTCHA:', error);
          attempt++;
          continue;
        }

        // Make initial request to set up session
        await this.session.get(this.baseUrl);

        // Prepare request data
        const formData = new FormData();
        formData.append('cino', cnr);
        formData.append('fcaptcha_code', captchaText);
        formData.append('ajax_req', 'true');
        formData.append('app_token', this.appToken);

        // Make request
        const response = await this.session.post(
          `${this.baseUrl}?p=cnr_status/searchByCNR`,
          formData,
          {
            headers: {
              ...formData.getHeaders(),
              'X-Requested-With': 'XMLHttpRequest',
              'Origin': 'https://services.ecourts.gov.in',
              'Referer': `${this.baseUrl}?p=cnr_status/searchByCNR`,
              'Sec-Fetch-Site': 'same-origin',
              'Sec-Fetch-Mode': 'cors',
              'Sec-Fetch-Dest': 'empty'
            }
          }
        );

        if (response.status === 200) {
          const result = response.data;
          
          // Check for error message
          if (result.errormsg) {
            console.warn(`Error in response (attempt ${attempt + 1}):`, result.errormsg);
            // Save failed response for debugging
            fs.writeFileSync(`failed_response_${attempt + 1}.json`, JSON.stringify(result, null, 2));
            attempt++;
            continue;
          }

          // Save HTML response for debugging
          const htmlContent = result.casetype_list || '';
          fs.writeFileSync('last_response.html', htmlContent);
          console.log('Saved HTML response to last_response.html');

          // Check if case exists
          if (htmlContent.includes('This Case Code does not exists')) {
            console.log(`Case ${cnr} does not exist`);
            return { cnr_number: cnr, exists: false };
          }

          // Parse case details from HTML response
          const caseDetails = this._parseCaseDetails(htmlContent);
          if (caseDetails) {
            caseDetails.exists = true;
            console.log(`Successfully fetched data for CNR ${cnr} on attempt ${attempt + 1}`);
            return caseDetails;
          } else {
            console.warn(`Failed to parse case details from response on attempt ${attempt + 1}`);
          }
        } else {
          console.error(`HTTP ${response.status} error on attempt ${attempt + 1}`);
        }

        attempt++;
      } catch (error) {
        console.error(`Error on attempt ${attempt + 1}:`, error.message);
        attempt++;
      }

      // Add delay between attempts
      if (attempt < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }

    console.error(`Failed to fetch case details for ${cnr} after ${maxRetries} attempts`);
    return null;
  }

  _parseCaseDetails(html) {
    try {
      const $ = cheerio.load(html);
      
      // Check if case does not exist
      if ($('span:contains("This Case Code does not exists")').length > 0) {
        return null;
      }

      const caseDetails = {
        html_content: html,
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

      // Extract court name
      const courtHeading = $('#chHeading').text().trim();
      if (courtHeading) {
        caseDetails.court_name = courtHeading;
      }

      // Check if the page contains case details
      if (!html.includes('Case Details')) {
        console.error('No case details found in the response');
        return null;
      }

      // Parse case details table
      $('.case_details_table tr').each((_, row) => {
        const cols = $(row).find('td');
        if (cols.length >= 2) {
          const label = $(cols[0]).text().trim().toLowerCase();
          if (label.includes('case type')) {
            caseDetails.case_type = $(cols[1]).text().trim();
          } else if (label.includes('filing number')) {
            caseDetails.filing_number = $(cols[1]).text().trim();
            if (cols.length >= 4) {
              caseDetails.filing_date = $(cols[3]).text().trim();
            }
          } else if (label.includes('registration number')) {
            caseDetails.registration_number = $(cols[1]).text().trim();
            if (cols.length >= 4) {
              caseDetails.registration_date = $(cols[3]).text().trim();
            }
          } else if (label.includes('cnr number')) {
            const cnrText = $(cols[1]).text().trim();
            caseDetails.cnr_number = cnrText.substring(0, 16);
          }
        }
      });

      // Parse case status table
      $('.case_status_table tr').each((_, row) => {
        const cols = $(row).find('td');
        if (cols.length >= 2) {
          const label = $(cols[0]).text().trim().toLowerCase();
          if (label.includes('first hearing date')) {
            caseDetails.first_hearing_date = $(cols[1]).text().trim();
          } else if (label.includes('decision date')) {
            const decisionDate = $(cols[1]).text().trim();
            caseDetails.decision_date = decisionDate;
            if (caseDetails.case_status === 'Case disposed') {
              caseDetails.disposal_date = decisionDate;
            }
          } else if (label.includes('case status')) {
            caseDetails.case_status = $(cols[1]).text().trim();
          } else if (label.includes('nature of disposal')) {
            caseDetails.disposal_nature = $(cols[1]).text().trim();
          } else if (label.includes('court number and judge')) {
            caseDetails.court_number_and_judge = $(cols[1]).text().trim();
          }
        }
      });

      // Parse petitioner and advocate details
      $('.Petitioner_Advocate_table tr').each((_, row) => {
        const text = $(row).find('td').first().text().trim();
        const parts = text.split('Advocate-');
        if (parts.length >= 2) {
          caseDetails.petitioner_name = parts[0].trim();
          caseDetails.petitioner_advocate = parts[1].trim();
        } else {
          caseDetails.petitioner_name = text;
        }
      });

      // Parse respondent and advocate details
      $('.Respondent_Advocate_table tr').each((_, row) => {
        const text = $(row).find('td').first().text().trim();
        const parts = text.split('Advocate-');
        if (parts.length >= 2) {
          caseDetails.respondent_name = parts[0].trim();
          caseDetails.respondent_advocate = parts[1].trim();
        } else {
          caseDetails.respondent_name = text;
        }
      });

      // Parse acts and sections
      const { acts, sections } = this._extractActsAndSections($);
      caseDetails.under_acts = acts;
      caseDetails.under_sections = sections;

      // Extract case history
      try {
        const historyEntries = this._extractCaseHistory($);
        caseDetails.case_history = historyEntries;
        console.log(`Found ${historyEntries.length} case history entries`);
      } catch (error) {
        console.error('Error extracting case history:', error.message);
        caseDetails.case_history = [];
      }

      // Extract transfer details
      try {
        const transferEntries = this._extractTransferDetails($);
        caseDetails.transfer_details = transferEntries;
        console.log(`Found ${transferEntries.length} transfer entries`);
      } catch (error) {
        console.error('Error extracting transfer details:', error.message);
        caseDetails.transfer_details = [];
      }

      // Extract IA details
      try {
        const iaEntries = this._extractIADetails($);
        caseDetails.ia_details = iaEntries;
        console.log(`Found ${iaEntries.length} IA entries`);
      } catch (error) {
        console.error('Error extracting IA details:', error.message);
        caseDetails.ia_details = [];
      }

      return caseDetails;
    } catch (error) {
      console.error('Error parsing case details:', error.message);
      return null;
    }
  }

  _extractActsAndSections($) {
    const acts = [];
    const sections = [];
    
    $('#act_table tr').slice(1).each((_, row) => {
      const cols = $(row).find('td');
      if (cols.length >= 2) {
        const act = $(cols[0]).text().trim().replace(/\\$/, '');
        const section = $(cols[1]).text().trim();
        if (act) acts.push(act);
        if (section) sections.push(section);
      }
    });
    
    return {
      acts: acts.length ? acts.join(',') : null,
      sections: sections.length ? sections.join(',') : null
    };
  }

  _extractCaseHistory($) {
    const historyEntries = [];
    
    $('.history_table tr').slice(1).each((_, row) => {
      const cols = $(row).find('td');
      if (cols.length >= 4) {
        const historyEntry = {
          judge: $(cols[0]).text().trim(),
          business_date: $(cols[1]).text().trim().split('\n')[0],
          hearing_date: $(cols[2]).text().trim(),
          purpose: $(cols[3]).text().trim()
        };
        
        if (Object.values(historyEntry).some(val => val)) {
          historyEntries.push(historyEntry);
        }
      }
    });
    
    return historyEntries;
  }

  _extractTransferDetails($) {
    const transferEntries = [];
    
    $('.transfer_table tr').slice(1).each((_, row) => {
      const cols = $(row).find('td');
      if (cols.length >= 4) {
        const transferEntry = {
          registration_number: $(cols[0]).text().trim(),
          transfer_date: $(cols[1]).text().trim(),
          from_court: $(cols[2]).text().trim(),
          to_court: $(cols[3]).text().trim()
        };
        
        transferEntries.push(transferEntry);
      }
    });
    
    return transferEntries;
  }

  _extractIADetails($) {
    const iaEntries = [];
    
    $('.IAheading tr').slice(1).each((_, row) => {
      const cols = $(row).find('td');
      if (cols.length >= 5) {
        const iaNo = $(cols[0]).text().trim();
        const partyRaw = $(cols[1]).text().trim();
        const dtFiling = $(cols[2]).text().trim();
        const nextDatePurpose = $(cols[3]).text().trim();
        const iaStatus = $(cols[4]).text().trim();

        // Clean party name
        const partyName = partyRaw.replace(/<br\/>/g, ' ').trim();

        // Split next date and purpose
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
        
        iaEntries.push(iaEntry);
      }
    });
    
    return iaEntries;
  }

  async close() {
    console.log('Closing session...');
    this.appToken = null;
  }
}