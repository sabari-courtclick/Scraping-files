import puppeteer from "puppeteer";

(async () =>{
    const browser = await puppeteer.launch();
    const page = await browser.newPage();
    await page.goto('https://books.toscrape.com');

    const books = await page.evaluate(() =>{
        const bookNodes = document.querySelectorAll('.product_pod');
        const books = [];
        bookNodes.forEach((book) => {
            const title = book.querySelector('h3 a').getAttribute('title');
            const price = book.querySelector('.price_color').innerText;
            books.push({title, price});
        });
        return books;
    });
    console.log(books);
    await browser.close();
})();