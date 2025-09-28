// fetch-models.js
// Run this once with `node fetch-models.js` to download models to ./models folder.
// Source: https://raw.githubusercontent.com/vladmandic/face-api/master/model/

const fs = require('fs');
const https = require('https');
const path = require('path');

const modelUrl = 'https://raw.githubusercontent.com/vladmandic/face-api/master/model/';
const models = [
  'face_detection_model-weights_manifest.json',
  'face_detection_model-weights.bin',
  'face_landmark_68_model-weights_manifest.json',
  'face_landmark_68_model-weights.bin',
  'face_recognition_model-weights_manifest.json',
  'face_recognition_model-weights.bin'
  // Add more if needed, e.g., 'tiny_face_detector_model-weights_manifest.json', etc.
];

const modelsDir = path.join(__dirname, 'models');
if (!fs.existsSync(modelsDir)) fs.mkdirSync(modelsDir);

models.forEach(file => {
  const dest = path.join(modelsDir, file);
  https.get(`${modelUrl}${file}`, (res) => {
    res.pipe(fs.createWriteStream(dest));
    console.log(`Downloading ${file}`);
  }).on('error', (err) => console.error(`Error downloading ${file}:`, err));
});