import puppeteer from "puppeteer";

(async () => {
  // Launch Puppeteer with a user agent and headful mode for debugging
  const browser = await puppeteer.launch({
    headless: false, // Set to true for production
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const page = await browser.newPage();

  // Set a user agent to mimic a real browser
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
  );

  // Navigate to the IMDb page
  await page.goto('https://www.imdb.com/chart/top/', {
    waitUntil: 'networkidle2', // Wait for the network to be mostly idle
  });

  // Wait for the movie list to load
  await page.waitForSelector('.lister-list tr');

  // Scrape the movie data
  const movies = await page.evaluate(() => {
    const movieNodes = document.querySelectorAll('.lister-list tr');
    const movies = [];
    movieNodes.forEach((movie) => {
      const title = movie.querySelector('.titleColumn a')?.innerText;
      const rating = movie.querySelector('.imdbRating strong')?.innerText;
      if (title && rating) {
        movies.push({ title, rating });
      }
    });
    return movies;
  });

  console.log(movies);
  await browser.close();
})();