import puppeteer from 'puppeteer';
import axios from 'axios';
import fs from 'fs';
import dotenv from 'dotenv';

dotenv.config();

// Replace with your 2Captcha API key
const API_KEY = process.env.API_KEY;

// Function to solve captcha using 2Captcha API
async function solveCaptcha(imagePath) {
  const captchaImage = fs.readFileSync(imagePath, 'base64');
  console.log('Sending captcha to 2Captcha...');

  const response = await axios.post(`https://2captcha.com/in.php`, {
    key: API_KEY,
    method: 'base64',
    body: captchaImage,
    json: 1,
  });

  console.log('2Captcha API Response:', response.data);

  if (response.data.status !== 1) {
    throw new Error(`Failed to send captcha to 2Captcha: ${response.data.request}`);
  }

  const captchaId = response.data.request;
  console.log('Captcha sent to 2Captcha. Waiting for solution...');

  // Poll for the captcha solution
  let solution;
  for (let i = 0; i < 30; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5000)); // Wait 5 seconds
    const result = await axios.get(`https://2captcha.com/res.php`, {
      params: {
        key: API_KEY,
        action: 'get',
        id: captchaId,
        json: 1,
      },
    });

    console.log('2Captcha Polling Response:', result.data);

    if (result.data.status === 1) {
      solution = result.data.request;
      break;
    }
  }

  if (!solution) {
    throw new Error('Failed to solve captcha');
  }

  console.log(`Captcha solved: ${solution}`);
  return solution;
}

(async () => {
  // Launch the browser
  const browser = await puppeteer.launch({ headless: false }); // Set headless: false to see the browser
  const page = await browser.newPage();

  // Navigate to the website
  await page.goto('https://services.ecourts.gov.in/ecourtindia_v6/', {
    waitUntil: 'networkidle2',
  });

  let retry = true;
  while (retry) {
    try {
      // Enter the CNR number
      await page.type('#cino', 'KLWD030000802019');

      // Wait for the captcha element to be available
      await page.waitForSelector('#captcha_image', { timeout: 5000 });

      // Re-fetch the captcha element to ensure it's attached to the DOM
      const captchaElement = await page.$('#captcha_image');
      if (!captchaElement) {
        throw new Error('Captcha element not found');
      }

      // Take a screenshot of the captcha image
      await captchaElement.screenshot({ path: 'captcha.png' });

      // Verify the image file
      const stats = fs.statSync('captcha.png');
      console.log(`Captcha image size: ${stats.size} bytes`);

      if (stats.size === 0) {
        throw new Error('Captcha image is empty');
      }

      console.log('Captcha screenshot saved as captcha.png');

      // Solve the captcha using 2Captcha API
      let captchaText;
      try {
        captchaText = await solveCaptcha('captcha.png');
      } catch (error) {
        console.error('Error solving captcha:', error.message);
        console.error('Retrying...');
        continue; // Retry the process
      }

      // Enter the solved captcha into the captcha field
      await page.type('#fcaptcha_code', captchaText);

      // Click the search button
      await page.click('#searchbtn');

      // Wait for the modal to appear (if captcha is invalid)
      try {
        await page.waitForSelector('.modal-content', { timeout: 5000 });

        // Check if the session timeout error modal is displayed
        const sessionTimeoutModal = await page.$('.alert-danger-cust a[href="/ecourtindia_v6"]');
        if (sessionTimeoutModal) {
          console.log('Session timeout detected. Redirecting to home page...');

          // Click the "Click here to go Home Page" link
          await page.click('.alert-danger-cust a[href="/ecourtindia_v6"]');

          // Wait for the page to reload
          await page.waitForNavigation({ waitUntil: 'networkidle2' });

          console.log('Redirected to home page. Retrying...');
          continue; // Retry the process
        }

        // Close the modal by clicking the cross button
        await page.click('.btn-close');

        // Click the reload button to reset the page
        await page.click('#reload');

        // Wait for the page to reload
        await page.waitForNavigation({ waitUntil: 'networkidle2' });

        console.log('Page reloaded. Retrying...');
      } catch (error) {
        // If the modal does not appear, assume success
        console.log('Captcha was valid. Proceeding...');
        retry = false;
      }
    } catch (error) {
      console.error('Error during retry:', error.message);
      console.error('Reloading page...');

      // Click the reload button to reset the page
      await page.click('#reload');

      // Wait for the page to reload
      await page.waitForNavigation({ waitUntil: 'networkidle2' });

      console.log('Page reloaded. Retrying...');
    }
  }

  // Take a screenshot of the results page
  await page.screenshot({ path: 'results.png' });
  console.log('Results screenshot saved as results.png');

  // Close the browser
  await browser.close();
})();