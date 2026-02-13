// server.mjs
import * as cheerio from 'cheerio';
import path from 'path';
import fs from 'fs-extra';
import express from 'express';
import { exec } from 'child_process';
import lodash from 'lodash';
const { find, map } = lodash;
import multer from 'multer';
import { v1 as uuidv1 } from 'uuid';
import getSvgWithAddedOutline from './modules/getSvgWithAddedOutline.mjs';

const openmojis = JSON.parse(
  fs.readFileSync('./openmoji/data/openmoji-tester.json', 'utf-8')
);

const port = process.env.PORT || 3000;
const pathTmp = '/tmp';

const app = express();

// ---------- Multer (uploads) ----------
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, req._jobDir),
  filename: (req, file, cb) => cb(null, file.originalname),
});

const upload = multer({
  storage,
  limits: {
    // adjust as you like; Render free instances are small
    fileSize: 2 * 1024 * 1024, // 2MB per file
    files: 4000,               // max number of files
  },
  fileFilter: (req, file, cb) => {
    const name = (file.originalname || '').toLowerCase();
    if (!name.endsWith('.svg')) {
      return cb(new Error('Only .svg files are allowed.'));
    }
    cb(null, true);
  },
});

// ---------- Express ----------
app.use(express.static('public'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ---------- Routes ----------
app.post(
  '/test-svg',
  prepareTmpDir,
  upload.array('svgFiles'),
  checkUpload,
  prepareOpenmojiJson,
  runTestAndSaveReport,
  sendReportAndCleanup
);

app.post(
  '/test-visual',
  prepareTmpDir,
  upload.array('svgFiles'),
  checkUpload,
  addOutlineToSvgs,
  prepareOpenmojiJson,
  createVisualReportAndSave,
  sendReportAndCleanup
);

// ---------- Middleware / helpers ----------
function addOutlineToSvgs(req, res, next) {
  const files = req.files || [];
  for (const file of files) {
    const svgString = fs.readFileSync(file.path, 'utf-8');
    try {
      const outlinedSvgString = getSvgWithAddedOutline(svgString);
      fs.writeFileSync(file.path, outlinedSvgString, 'utf-8');
    } catch (e) {
      console.log('adding outline didnt work', e?.message || e);
    }
  }
  next();
}

function createVisualReportAndSave(req, res, next) {
  const templateLocation = path.join('.', 'template-visual-test.html');
  let newHtml = fs.readFileSync(templateLocation, 'utf-8');
  const newLocation = path.join(req._jobDir, 'report.html');

  const files = req.files || [];
  let svgContent = '';

  for (const file of files) {
    const svgString = fs.readFileSync(file.path, 'utf-8');
    svgContent += '<div class="emoji">';
    svgContent += '<div class="title">' + escapeHtml(file.originalname) + '</div>';
    svgContent += '<div>';
    svgContent += svgString;
    svgContent += '</div>';
    svgContent += '</div>';
  }

  newHtml = newHtml.replace('{{{result}}}', svgContent);
  fs.writeFileSync(newLocation, newHtml, 'utf-8');

  next();
}

function checkUpload(req, res, next) {
  const files = req.files || [];
  if (files.length === 0) {
    // End the request here (don’t continue the chain)
    return res.status(400).send('Please choose some OpenMoji svg files! :)');
  }
  next();
}

function prepareTmpDir(req, res, next) {
  req._jobId = 'openmoji-' + uuidv1();
  req._jobDir = path.resolve(pathTmp, req._jobId);

  fs.ensureDir(req._jobDir, (err) => {
    if (err) return next(err);
    next();
  });
}

function prepareOpenmojiJson(req, res, next) {
  const files = req.files || [];
  const openmojisResults = map(files, (f) => {
    const filename = path.basename(f.filename, '.svg');
    const found = find(openmojis, (o) => o.hexcode === filename);

    if (found) {
      // clone so we don't mutate the global object
      return {
        ...found,
        group: '',
        subgroups: '',
      };
    }

    return {
      emoji: '"�"',
      hexcode: filename,
      group: '',
      subgroups: '',
      skintone: '',
    };
  });

  fs.writeJson(path.join(req._jobDir, 'openmoji.json'), openmojisResults, (err) => {
    if (err) return next(err);
    next();
  });
}

/**
 * Runs mocha and always ensures report.html exists:
 * - if mocha succeeds, mochawesome generates report.html
 * - if mocha fails, we write a fallback report.html that includes stderr/stdout
 */
function runTestAndSaveReport(req, res, next) {
  const cmd = [
    'node_modules/.bin/mocha',
    '--reporter mochawesome',
    '--reporter-options',
    `quiet=true,reportDir=${req._jobDir},reportFilename=report,json=false,inline=true,code=false,cdn=true,reportTitle=OpenMoji-Tester,reportPageTitle=OpenMoji-Tester`,
    'openmoji/test/*.js',
    '--openmoji-data-json',
    `${req._jobDir}/openmoji.json`,
    '--openmoji-src-folder',
    `${req._jobDir}`,
  ].join(' ');

  exec(cmd, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
    // If mochawesome didn't generate an HTML report, create one (especially on failure)
    const reportPath = path.join(req._jobDir, 'report.html');
    const reportExists = fs.existsSync(reportPath);

    if (err && !reportExists) {
      const debugHtml = `
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>OpenMoji-Tester (error)</title>
    <style>
      body { font-family: system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; padding: 16px; }
      pre { background: #111; color: #eee; padding: 12px; overflow: auto; border-radius: 8px; }
      .muted { color: #666; }
    </style>
  </head>
  <body>
    <h1>OpenMoji-Tester: mocha failed</h1>
    <p class="muted">This is a fallback report generated by server.mjs.</p>
    <h2>Error</h2>
    <pre>${escapeHtml(err?.stack || String(err))}</pre>
    <h2>stderr</h2>
    <pre>${escapeHtml(stderr || '(empty)')}</pre>
    <h2>stdout</h2>
    <pre>${escapeHtml(stdout || '(empty)')}</pre>
    <h2>Sanity</h2>
    <pre>${escapeHtml(
      JSON.stringify(
        {
          jobDir: req._jobDir,
          cwd: process.cwd(),
          node: process.version,
          hasOpenmojiTestDir: fs.existsSync(path.join(process.cwd(), 'openmoji', 'test')),
          hasOpenmojiTestFiles: (() => {
            try {
              const dir = path.join(process.cwd(), 'openmoji', 'test');
              return fs.existsSync(dir) ? fs.readdirSync(dir).slice(0, 20) : [];
            } catch {
              return [];
            }
          })(),
        },
        null,
        2
      )
    )}</pre>
  </body>
</html>`;
      fs.writeFileSync(reportPath, debugHtml, 'utf-8');
    }

    // Continue: we will send whatever report.html exists (mochawesome or fallback)
    next();
  });
}

/**
 * LAST step: send report then delete tmp dir AFTER response finishes.
 * IMPORTANT: do NOT call next() here (prevents "Can't set headers after they are sent")
 */
function sendReportAndCleanup(req, res) {
  const reportPath = path.join(req._jobDir, 'report.html');

  // Cleanup after response finishes
  res.on('finish', () => {
    fs.remove(path.resolve(req._jobDir), (err) => {
      if (err) console.error(err);
    });
  });

  // If report is missing for some reason, fail gracefully
  if (!fs.existsSync(reportPath)) {
    return res
      .status(500)
      .send('Report was not generated (report.html missing). Check server logs.');
  }

  return res.sendFile(reportPath);
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ---------- Error handler (helps with multer/fileFilter errors) ----------
app.use((err, req, res, next) => {
  if (!err) return next();

  // Multer errors are common
  const msg = err?.message || String(err);
  if (msg.includes('Only .svg')) return res.status(400).send(msg);
  if (msg.includes('File too large')) return res.status(413).send(msg);

  console.error(err);
  return res.status(500).send(msg);
});

// ---------- Listen ----------
const listener = app.listen(port, function () {
  console.log(`Your app is listening on localhost:${listener.address().port}`);
});
