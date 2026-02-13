import * as cheerioNS from 'cheerio';
const cheerio = cheerioNS.default ?? cheerioNS;

import path from 'path';
import fs from 'fs-extra';
import express from 'express';
import { exec } from 'child_process';
import lodash from 'lodash';
const { find, map } = lodash;

import multer from 'multer';
import { v1 as uuidv1 } from 'uuid';
import getSvgWithAddedOutline from './modules/getSvgWithAddedOutline.mjs';

const openmojis = JSON.parse(fs.readFileSync('./openmoji/data/openmoji-tester.json', 'utf-8'));

const port = process.env.PORT || 3000;
const pathTmp = process.env.TMPDIR || '/tmp';

const app = express();

app.use(express.static('public'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, req._jobDir),
  filename: (req, file, cb) => cb(null, file.originalname),
});
const upload = multer({ storage });

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

function addOutlineToSvgs(req, res, next) {
  try {
    for (const file of req.files || []) {
      const svgString = fs.readFileSync(file.path, 'utf-8');
      try {
        const outlinedSvgString = getSvgWithAddedOutline(svgString);
        fs.writeFileSync(file.path, outlinedSvgString, 'utf-8');
      } catch {
        // keep going; outline step is best-effort
      }
    }
    next();
  } catch (err) {
    next(err);
  }
}

function createVisualReportAndSave(req, res, next) {
  try {
    const templateLocation = path.join('.', 'template-visual-test.html');
    let newHtml = fs.readFileSync(templateLocation, 'utf-8');

    const newLocation = path.join(req._jobDir, 'report.html');

    const files = req.files || [];
    let svgContent = '';

    for (const file of files) {
      const svgString = fs.readFileSync(file.path, 'utf-8');
      svgContent += '<div class="emoji">';
      svgContent += `<div class="title">${file.originalname}</div>`;
      svgContent += '<div>';
      svgContent += svgString;
      svgContent += '</div>';
      svgContent += '</div>';
    }

    newHtml = newHtml.replace('{{{result}}}', svgContent);
    fs.writeFileSync(newLocation, newHtml, 'utf-8');

    next();
  } catch (err) {
    next(err);
  }
}

function checkUpload(req, res, next) {
  const files = req.files || [];
  if (files.length === 0) {
    return res.status(400).send('Please choose some OpenMoji svg files! :)');
  }
  next();
}

function prepareTmpDir(req, res, next) {
  req._jobId = 'openmoji-' + uuidv1();
  req._jobDir = path.resolve(pathTmp, req._jobId);

  fs.ensureDir(req._jobDir)
    .then(() => next())
    .catch(next);
}

function prepareOpenmojiJson(req, res, next) {
  try {
    const files = req.files || [];
    const openmojisResults = map(files, (f) => {
      const filename = path.basename(f.filename, '.svg');
      const found = find(openmojis, (o) => o.hexcode === filename);

      if (found) {
        return { ...found, group: '', subgroups: '' };
      }

      return {
        emoji: '"�"',
        hexcode: filename,
        group: '',
        subgroups: '',
        skintone: '',
      };
    });

    fs.writeJson(path.join(req._jobDir, 'openmoji.json'), openmojisResults)
      .then(() => next())
      .catch(next);
  } catch (err) {
    next(err);
  }
}

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

  exec(cmd, (err, stdout, stderr) => {
    // If mocha fails, still generate/send whatever report exists (if any)
    // but bubble errors if report didn't get created.
    next();
  });
}

function sendReportAndCleanup(req, res, next) {
  const reportPath = path.join(req._jobDir, 'report.html');

  res.sendFile(reportPath, async (err) => {
    try {
      await fs.remove(req._jobDir);
    } catch {
      // ignore cleanup errors on free tier
    }

    if (err) return next(err);
  });
}

app.listen(port, () => {
  console.log(`Your app is listening on localhost:${port}`);
});
