import puppeteer from 'puppeteer';

(async () => {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  await page.goto('https://www.amazon.com/s?k=laptop');
  await page.waitForSelector('.s-result-item');

  const products = await page.evaluate(() => {
    const productNodes = document.querySelectorAll('.s-result-item');
    const products = [];
    productNodes.forEach((product) => {
      const title = product.querySelector('h2 a span')?.innerText;
      const price = product.querySelector('.a-price span')?.innerText;
      if (title && price) {
        products.push({ title, price });
      }
    });
    return products;
  });

  console.log(products);
  await browser.close();
})();