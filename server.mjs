import path from 'path';
import fs from 'fs-extra';
import express from 'express';
import { exec } from 'child_process';
import lodash from 'lodash';
import multer from 'multer';
import { v1 as uuidv1 } from 'uuid';
import getSvgWithAddedOutline from './modules/getSvgWithAddedOutline.mjs';

const { find, map } = lodash;

const openmojis = JSON.parse(
  fs.readFileSync('./openmoji/data/openmoji-tester.json', 'utf-8')
);

const port = process.env.PORT || 3000;
const pathTmp = '/tmp';

const app = express();

app.use(express.static('public'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

function prepareTmpDir(req, res, next) {
  req._jobId = 'openmoji-' + uuidv1();
  req._jobDir = path.resolve(pathTmp, req._jobId);

  fs.ensureDir(req._jobDir, (err) => {
    if (err) return next(err);
    next();
  });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, req._jobDir),
  filename: (req, file, cb) => cb(null, file.originalname),
});

// limits + only .svg
const upload = multer({
  storage,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB per file
    files: 300,                // optional: max files per request
  },
  fileFilter: (req, file, cb) => {
    const name = (file.originalname || '').toLowerCase();
    const ok =
      file.mimetype === 'image/svg+xml' || name.endsWith('.svg');

    if (!ok) return cb(new Error('Only .svg files are allowed'));
    cb(null, true);
  },
});

function checkUpload(req, res, next) {
  const files = req.files || [];
  if (files.length === 0) {
    return res.status(400).send('Please choose some .svg files.');
  }
  next();
}

function addOutlineToSvgs(req, res, next) {
  const files = req.files || [];
  files.forEach((file) => {
    const svgString = fs.readFileSync(file.path, 'utf-8');
    try {
      const outlinedSvgString = getSvgWithAddedOutline(svgString);
      fs.writeFileSync(file.path, outlinedSvgString, 'utf-8');
    } catch {
      // keep going even if one fails outline
      console.log('adding outline didnt work for:', file.originalname);
    }
  });
  next();
}

function prepareOpenmojiJson(req, res, next) {
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

  fs.writeJson(path.join(req._jobDir, 'openmoji.json'), openmojisResults, (err) => {
    if (err) return next(err);
    next();
  });
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
    // If mocha fails, you still might want to show the report (it usually exists).
    // But if something truly broke, show stderr.
    if (err && !fs.existsSync(path.join(req._jobDir, 'report.html'))) {
      console.error(stderr || err);
      return res.status(500).send('Test run failed.');
    }
    next();
  });
}

function createVisualReportAndSave(req, res, next) {
  const templateLocation = path.join('.', 'template-visual-test.html');
  let newHtml = fs.readFileSync(templateLocation, 'utf-8');

  const newLocation = path.join(req._jobDir, 'report.html');

  const files = req.files || [];
  let svgContent = '';

  files.forEach((file) => {
    const svgString = fs.readFileSync(file.path, 'utf-8');
    svgContent += '<div class="emoji">';
    svgContent += `<div class="title">${file.originalname}</div>`;
    svgContent += '<div>';
    svgContent += svgString;
    svgContent += '</div>';
    svgContent += '</div>';
  });

  newHtml = newHtml.replace('{{{result}}}', svgContent);
  fs.writeFileSync(newLocation, newHtml, 'utf-8');
  next();
}

function sendReport(req, res, next) {
  res.sendFile(path.join(req._jobDir, 'report.html'));
  next();
}

function deleteTmpDir(req, res, next) {
  const jobDir = req._jobDir;
  res.on('finish', () => {
    fs.remove(path.resolve(jobDir), (err) => {
      if (err) console.error(err);
    });
  });
  next();
}

// Routes
app.post(
  '/test-svg',
  prepareTmpDir,
  upload.array('svgFiles'),
  checkUpload,
  prepareOpenmojiJson,
  runTestAndSaveReport,
  sendReport,
  deleteTmpDir
);

app.post(
  '/test-visual',
  prepareTmpDir,
  upload.array('svgFiles'),
  checkUpload,
  addOutlineToSvgs,
  prepareOpenmojiJson,
  createVisualReportAndSave,
  sendReport,
  deleteTmpDir
);

// Nice error messages for upload problems (size/type, etc.)
app.use((err, req, res, next) => {
  if (err) {
    // Multer "file too large" error code
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).send('File too large. Max 5MB per SVG.');
    }
    return res.status(400).send(err.message || 'Request error');
  }
  next();
});

const listener = app.listen(port, () => {
  console.log(`Your app is listening on localhost:${listener.address().port}`);
});
