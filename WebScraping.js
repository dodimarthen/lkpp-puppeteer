const puppeteer = require('puppeteer-extra');
const mysql = require('mysql2/promise'); // Import the promise-based version of mysql2
const { websiteURL, username, password, paketbaruPage, SQL_Address, SQL_Password, SQL_User, Selected_Database } = require('./config.js');
const scrapeInformasiUtama = require('./ScrapInformasiUtama.js');
const scrapePpPpk = require('./ScrapPPK.js');
const scrapeKontrak = require('./ScrapSuratKontrak.js');
const scrapeStatus = require('./ScrapStatus.js');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const getStatus = require('./ScrapStatus.js');
const scrapNego = require('./ScrapRiwayatNegosiasi.js');

puppeteer.use(StealthPlugin());

const Scraping = async () => {
  // Record the start time
  const startTime = new Date();

  // Start a Puppeteer session:
  const browser = await puppeteer.launch({
    headless: true,
    defaultViewport: null,
  });

  // Create a MySQL connection pool
  const pool = mysql.createPool({
    host: SQL_Address,
    user: SQL_User,
    password: SQL_Password,
    database: Selected_Database,
    connectionLimit: 10 // Adjust the connection limit as needed
  });

  // SCRAPING PROCESS
  try {
    // Open a new page
    console.log("Opening the browser..");
    const page = await browser.newPage();
    await page.goto(websiteURL, {
      waitUntil: "domcontentloaded",
    });

    // Login
    console.log("Login process automation..")
    await page.waitForSelector('.input-login[name="username"]');
    await page.type('.input-login[name="username"]', username);
    await page.waitForSelector('.input-login[name="password"]');
    await page.type('.input-login[name="password"]', password);
    await page.waitForSelector('#btnLoginPenyedia');
    await page.click('#btnLoginPenyedia');
    await page.waitForSelector('.modal-header h4');
    const headerText = await page.evaluate(() => {
      return document.querySelector('.modal-header h4').textContent;
    });

    await page.goto(paketbaruPage, {
      waitUntil: "domcontentloaded",
    });

    const allHrefs = [];

    for (let i = 1; i <= 14; i++) {
      console.log("Scraping href from page", i);
      const hrefs = await scrapeHrefsFromPage(page);
      allHrefs.push(...hrefs);

      await new Promise(resolve => setTimeout(resolve, 3000));
      await page.evaluate(() => {
        const nextPageButton = document.querySelector('.pagination .active + li a');
        if (nextPageButton) {
          nextPageButton.click();
        }
      });
    }

    for (const href of allHrefs) {
      // Log the original href
      await page.goto(`https://e-katalog.lkpp.go.id${href}`, {
        waitUntil: "domcontentloaded",
      });

      console.log("Scraping Informasi Utama, PP/PPK BMKG, SK, Riwayat Negosiasi data for :", href);
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Call function to pull data for informasiUtama and ppkData using the original href
      const informasiUtamaData = await scrapeInformasiUtama(page);
      const ppkData = await scrapePpPpk(page);
      const statusData = await getStatus(page);
      // Log the modified href for kontrakData
      const hrefKontrak = `${href}/daftar-kontrak`.replace('/detail', '');
      const kontrakData = await scrapeKontrak(page, hrefKontrak);
      // Pull data riwayat negosiasi
      const hrefRiwayatNegosiasi = href.replace('/detail', '/riwayat-negosiasi-produk');
      const NegosiasiData = await scrapNego(page, hrefRiwayatNegosiasi);

      // Combine all data into a single object
      const combinedData = {
        ...informasiUtamaData,
        ...ppkData,
        ...statusData,
        ...kontrakData,
        ...NegosiasiData,
      };

      // Check the status before inserting into the database
      if (combinedData.Status !== 'Draft' && combinedData.Status !== 'Paket Batal') {
        // Insert data into the database
        await insertDataIntoDB(pool, combinedData);
      } else {
        console.log(`Skipping insertion for status: ${combinedData.Status}`);
      }

      // Pausing every loop
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    // Error Handling
  } catch (error) {
    console.error('An error occurred:', error.stack);
  } finally {
    // Close the browser
    console.log("Closing the browser..");
    await browser.close();

    // Release the MySQL connection pool
    pool.end();

    // Calculate the process time
    const endTime = new Date();
    const processTime = (endTime - startTime) / 1000;

    // Display the process time
    console.log("Process time:", processTime, "seconds");
  }
};

async function scrapeHrefsFromPage(page) {
  await page.waitForSelector('table#tblPenawaran tbody');
  await new Promise(resolve => setTimeout(resolve, 3000));
  const hrefs = await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll('table#tblPenawaran a[target="_blank"]'));
    const hrefsArray = links.map(link => {
      const hrefParts = link.getAttribute('href').split('/');
      const hrefNumber = hrefParts[hrefParts.length - 1];
      return `/v2/id/purchasing/paket/detail/${hrefNumber}`;
    });
    return hrefsArray;
  });
  return hrefs;
}

async function insertDataIntoDB(pool, data) {
  try {
    // Construct the SQL query to insert data into the database table
    const sql = `
      INSERT INTO hasil_scrap (
        nama_pemesan, jabatan_pemesan, nip_pemesan, email_pemesan, no_telp_pemesan,
        no_sertifikat_pbj_pemesan, nama_pembeli, jabatan_pembeli, nip_pembeli, 
        email_pembeli, no_telp_pembeli, no_sertifikat_pbj_pembeli, etalase_produk, 
        id_paket, nama_paket, satuan_kerja, alamat_satuan_kerja, alamat_pengiriman, 
        no_kontrak, tanggal_kontrak, status_paket, nama_barang, kuantitas_barang, 
        harga_barang, harga_ongkir, tanggal_pengiriman, total_harga
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    
    // Extract values from the combined data object
    const values = [
      data.Nama, data.Jabatan, data.NIP, data.Email, data["No. Telp"], data["No. Sertifikat PBJ"],
      data.Nama, data.Jabatan, data.NIP, data.Email, data["No. Telp"], data["No. Sertifikat PBJ"],
      data["Etalase Produk"], data["ID Paket"], data["Nama Paket"], data["Satuan Kerja"], 
      data["Alamat Satuan Kerja"], data["Alamat Pengiriman"], data["No.Kontrak"], 
      data["Tanggal Kontrak"], data.Status, data["Nama Produk"], data.Kuantitas, 
      data["Harga Satuan"], data["Ongkos Kirim"], data["Tanggal Pengiriman Produk"], data["Total Harga"]
    ];

    // Execute the SQL query
    await pool.query(sql, values);
    
    console.log('Data inserted successfully:', data);

  } catch (error) {
    console.error('Error inserting data:', error);
  }
}

// Call the Scraping function
Scraping();
