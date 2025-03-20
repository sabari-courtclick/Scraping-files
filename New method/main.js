import Scraper from './scraper.js';
import fs from 'fs';

(async () => {
  const scraper = new Scraper();
  try {
    await scraper.initializeSession();
    const caseDetails = await scraper.fetchCaseDetails('KLWD030000802019');
    console.log('Case details:', JSON.stringify(caseDetails, null, 2));
    
    // Save case details to file
    const fs = require('fs');
    fs.writeFileSync('case_details.json', JSON.stringify(caseDetails, null, 2));
    console.log('Case details saved to case_details.json');
  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    await scraper.close();
  }
})();