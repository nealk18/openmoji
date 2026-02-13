import path from 'path'
import fs from 'fs-extra'
import express from 'express'
import { exec } from 'child_process'
import lodash from 'lodash'
import multer from 'multer'
import { v1 as uuidv1 } from 'uuid'
import getSvgWithAddedOutline from './modules/getSvgWithAddedOutline.mjs'

const { find, map } = lodash

const openmojis = JSON.parse(
  fs.readFileSync('./openmoji/data/openmoji-tester.json', 'utf-8')
)

const port = process.env.PORT || 3000
const pathTmp = '/tmp'

const app = express()

app.use(express.static('public'))
app.use(express.json())
app.use(express.urlencoded({ extended: true }))

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, req._jobDir),
  filename: (req, file, cb) => cb(null, file.originalname),
})
const upload = multer({ storage })

app.post(
  '/test-svg',
  prepareTmpDir,
  upload.array('svgFiles'),
  checkUpload,
  prepareOpenmojiJson,
  runTestAndSaveReport,
  deleteTmpDir,      // ✅ set cleanup BEFORE sending response
  sendReport         // ✅ last: sends the file once
)

app.post(
  '/test-visual',
  prepareTmpDir,
  upload.array('svgFiles'),
  checkUpload,
  addOutlineToSvgs,
  prepareOpenmojiJson,
  createVisualReportAndSave,
  deleteTmpDir,      // ✅ set cleanup BEFORE sending response
  sendReport         // ✅ last
)

function addOutlineToSvgs(req, res, next) {
  const files = req.files || []
  files.forEach((file) => {
    const svgString = fs.readFileSync(file.path, 'utf-8')
    try {
      const outlinedSvgString = getSvgWithAddedOutline(svgString)
      fs.writeFileSync(file.path, outlinedSvgString, 'utf-8')
    } catch {
      console.log('adding outline didnt work')
    }
  })
  next()
}

function createVisualReportAndSave(req, res, next) {
  const templateLocation = path.join('.', 'template-visual-test.html')
  let newHtml = fs.readFileSync(templateLocation, 'utf-8')

  const newLocation = path.join(req._jobDir, 'report.html')

  const files = req.files || []
  let svgContent = ''
  files.forEach((file) => {
    const svgString = fs.readFileSync(file.path, 'utf-8')
    svgContent += '<div class="emoji">'
    svgContent += '<div class="title">' + file.originalname + '</div>'
    svgContent += '<div>'
    svgContent += svgString
    svgContent += '</div>'
    svgContent += '</div>'
  })

  newHtml = newHtml.replace('{{{result}}}', svgContent)
  fs.writeFileSync(newLocation, newHtml, 'utf-8')
  next()
}

function checkUpload(req, res, next) {
  const files = req.files || []
  if (files.length === 0) {
    return res.status(400).send('Please choose some OpenMoji svg files! :)')
  }
  next()
}

function prepareTmpDir(req, res, next) {
  req._jobId = 'openmoji-' + uuidv1()
  req._jobDir = path.resolve(pathTmp, req._jobId)
  fs.ensureDir(req._jobDir, (err) => {
    if (err) return next(err)
    next()
  })
}

function prepareOpenmojiJson(req, res, next) {
  const files = req.files || []
  const openmojisResults = map(files, (f) => {
    const filename = path.basename(f.filename, '.svg')
    let found = find(openmojis, (o) => o.hexcode === filename)
    if (found) {
      found.group = ''
      found.subgroups = ''
      return found
    }
    return {
      emoji: '"�"',
      hexcode: filename,
      group: '',
      subgroups: '',
      skintone: '',
    }
  })

  fs.writeJson(path.join(req._jobDir, 'openmoji.json'), openmojisResults, (err) => {
    if (err) return next(err)
    next()
  })
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
  ].join(' ')

  exec(cmd, (err) => {
    if (err) return next(err)
    next()
  })
}

function sendReport(req, res, next) {
  const reportPath = path.join(req._jobDir, 'report.html')

  // If report doesn't exist, fail clearly (prevents weird double-send situations)
  if (!fs.existsSync(reportPath)) {
    return res.status(500).send('Report not generated.')
  }

  // ✅ Do NOT call next() after this — response is being sent.
  res.sendFile(reportPath, (err) => {
    if (err) return next(err)
  })
}

function deleteTmpDir(req, res, next) {
  const jobDir = req._jobDir

  // remove after response is fully done
  res.on('finish', () => {
    fs.remove(path.resolve(jobDir)).catch(() => {})
  })

  // ✅ safe to continue: this does NOT send headers/body
  next()
}

// Helpful: express error handler (prevents half-responses)
app.use((err, req, res, next) => {
  console.error(err)
  if (res.headersSent) return next(err)
  res.status(500).send('Server error.')
})

const listener = app.listen(port, function () {
  console.log(`Your app is listening on localhost:${listener.address().port}`)
})
