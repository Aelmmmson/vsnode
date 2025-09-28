require('dotenv').config();

const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const cors = require('cors');
const axios = require('axios');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const bodyParser = require('body-parser');
const faceapi = require('face-api.js');
const canvas = require('canvas');
const tf = require('@tensorflow/tfjs');
const { Canvas, Image, ImageData } = canvas;
const winston = require('winston');

// Setup logging
const logger = winston.createLogger({
  transports: [
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'combined.log' }),
    new winston.transports.Console()
  ]
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Explicitly set TensorFlow backend
tf.setBackend('cpu').then(() => {
  logger.info('TensorFlow.js backend set to CPU');
}).catch(err => {
  logger.error('Error setting TensorFlow.js backend:', err);
  process.exit(1);
});

// Configure face-api.js environment
faceapi.env.monkeyPatch({ Canvas, Image, ImageData });

const app = express();
const port = process.env.PORT || 7007;

// Load face models on startup
const MODELS_PATH = './models';
(async () => {
  try {
    await faceapi.nets.tinyFaceDetector.loadFromDisk(MODELS_PATH);
    await faceapi.nets.faceLandmark68Net.loadFromDisk(MODELS_PATH);
    await faceapi.nets.faceRecognitionNet.loadFromDisk(MODELS_PATH);
    logger.info('Face models loaded successfully');
  } catch (err) {
    logger.error('Error loading face models:', err);
    process.exit(1);
  }
})();

// CORS setup
app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    if (origin.startsWith('http://localhost')) return callback(null, true);
    callback(new Error('Not allowed by CORS'));
  }
}));

app.use(express.json());
app.use(bodyParser.json());

// Multer error handling
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    logger.error(`Multer error: ${err.message}, Field: ${err.field}`);
    return res.status(400).json({ error: `Multer error: ${err.message}`, field: err.field });
  }
  logger.error('Unexpected error:', err);
  next(err);
});

// ----- Helper Function: Fetch Account Data from External API -----
async function fetchAccountData(accountNumber) {
  try {
    const config = {
      method: 'get',
      maxBodyLength: Infinity,
      url: `http://10.203.14.169/imaging/get_account_signature-${accountNumber}`,
      headers: { 
        'Cookie': 'PHPSESSID=j12mdcbmma7d3mmcgb5q9pjj5q'
      }
    };
    const response = await axios.request(config);
    const data = response.data;
    if (!data.approved || !Array.isArray(data.approved) || data.approved.length === 0) {
      throw new Error('Invalid response format from external API: approved array is missing or empty');
    }
    for (const item of data.approved) {
      if (!item.photo || !item.signature) {
        throw new Error('Invalid response format from external API: photo or signature missing in approved item');
      }
    }
    return data.approved; // Return the approved array directly
  } catch (error) {
    logger.error(`Error fetching account data for ${accountNumber}:`, error);
    throw error;
  }
}

// ----- Project 1: Signature Comparison -----
const uploadSignatures = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const filetypes = /jpeg|jpg|png/;
    if (filetypes.test(file.mimetype)) return cb(null, true);
    cb(new Error('File must be an image (jpeg/jpg/png)'));
  }
});

app.post('/compare-signatures', uploadSignatures.fields([
  { name: 'signature1', maxCount: 1 },
  { name: 'signature2', maxCount: 1 }
]), async (req, res) => {
  try {
    const { signature1, signature2 } = req.files;
    if (!signature1 || !signature2) return res.status(400).json({ error: 'Two signature images are required' });

    const [img1, img2] = await Promise.all([
      sharp(signature1[0].buffer).resize(300, 150).grayscale().raw().toBuffer({ resolveWithObject: true }),
      sharp(signature2[0].buffer).resize(300, 150).grayscale().raw().toBuffer({ resolveWithObject: true })
    ]);

    if (img1.info.width !== img2.info.width || img1.info.height !== img2.info.height) {
      return res.status(400).json({ error: 'Images must have the same dimensions after resizing' });
    }

    const pixelCount = img1.info.width * img1.info.height;
    let difference = 0;
    for (let i = 0; i < pixelCount; i++) {
      difference += Math.abs(img1.data[i] - img2.data[i]);
    }

    const maxDifference = pixelCount * 255;
    const similarity = 1 - (difference / maxDifference);

    res.json({ similarity: similarity.toFixed(4) });
    logger.info(`Signature comparison completed for account: ${req.body.accountNumber || 'unknown'}, similarity: ${similarity}`);
  } catch (error) {
    logger.error('Error comparing signatures:', error);
    res.status(500).json({ error: 'Failed to compare signatures', details: error.message });
  }
});

// ----- Project 2: Cheque Image Upload and Extraction -----
const uploadCheque = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }
});

const geminiApiKey = process.env.GEMINI_API_KEY;
if (!geminiApiKey) {
  logger.error('GEMINI_API_KEY is not set in the .env file.');
  process.exit(1);
}
const genAI = new GoogleGenerativeAI(geminiApiKey);
const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash-latest' });

function fileToGenerativePart(buffer, mimeType) {
  return {
    inlineData: {
      data: buffer.toString('base64'),
      mimeType
    },
  };
}

app.post('/upload-cheque', uploadCheque.single('chequeImage'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image file uploaded.' });

  try {
    const imageBuffer = req.file.buffer;
    const mimeType = req.file.mimetype;
    const imagePart = fileToGenerativePart(imageBuffer, mimeType);

    const prompt = `Analyze this bank cheque image meticulously and extract the following information. Pay close attention to both printed and handwritten fields. Provide very precise and accurate details.

1. **Payee Name**: The full name of the person or entity to whom the cheque is made payable. This is often handwritten. If it says "CASH" or "SELF", extract that.
2. **Payer/Account Holder Name**: The full name of the individual or entity whose bank account the cheque is drawn from. This is typically pre-printed or typed.
3. **Amount in Figures**: The numerical amount of the cheque, including currency symbol (e.g., "GHS 1,234.50" or "$500.00").
4. **Amount in Words**: The amount of the cheque written out in words (e.g., "One Thousand Two Hundred Thirty-Four Ghana Cedis and Fifty Pesewas").
5. **Amount Mismatch**: Determine if the "Amount in Figures" and "Amount in Words" clearly do NOT match. State "Yes" if there's a mismatch, "No" if they match or if either is unclear/missing preventing a comparison.
6. **Date**: The date the cheque was issued (e.g., "August 3, 2025" or "03/08/2025").
7. **Account Number**: The bank account number.
8. **Bank Name**: The full name of the issuing bank.
9. **Bank Branch**: The specific branch name of the bank, if discernible.
10. **Required Signatures**: How many signatures are expected for this cheque to be valid (e.g., "1", "2", "UNKNOWN" if not clearly indicated on the cheque itself).
11. **Signatures Present**: The actual number of distinct signatures physically visible on the cheque.
12. **Signature Status**: Based on comparison: "VALID" (present >= required, or if required is UNKNOWN and at least one is present), "INSUFFICIENT" (present < required), "NONE" (no signatures present), "UNSURE" (if unable to confidently determine required or present).
13. **MICR**: MICR number.
14. **Check Number**: The check number; normally a 6-digit pre-printed on the cheque below the routing number at the top right or first set of numbers in the MICR (e.g., 090125).
15. **Routing Number**: The routing number; normally a 6-digit pre-printed on the cheque above the check number at the top right or second set of digits in the MICR (e.g., 000347).
16. **Bank Code**: Usually the last set 2-digit number in the MICR.

**Output Format**: Provide the information as a strict JSON object. If a field cannot be confidently extracted or is not applicable, use \`null\` for its value.
\`\`\`json
{
  "PayeeName": null,
  "PayerAccountHolderName": null,
  "AmountFigures": null,
  "AmountWords": null,
  "AmountMismatch": null,
  "Date": null,
  "AccountNumber": null,
  "BankName": null,
  "BankBranch": null,
  "RequiredSignatures": null,
  "SignaturesPresent": null,
  "SignatureStatus": null,
  "MICR": null,
  "CheckNumber": null,
  "RoutingNumber": null,
  "BankCode": null
}
\`\`\`
`;

    const result = await model.generateContent([prompt, imagePart]);
    const response = await result.response;
    let extractedText = response.text();

    if (extractedText.startsWith('```json')) extractedText = extractedText.substring(7);
    if (extractedText.endsWith('```')) extractedText = extractedText.substring(0, extractedText.length - 3);
    extractedText = extractedText.trim();

    let parsedData;
    try {
      parsedData = JSON.parse(extractedText);
      logger.info('Cheque processed successfully');
    } catch (jsonError) {
      logger.error('Gemini response not valid JSON:', extractedText, jsonError);
      return res.status(500).json({ error: 'AI output not JSON', rawResponse: extractedText });
    }

    res.json({ success: true, extractedData: parsedData });
  } catch (error) {
    logger.error('Error with Gemini API:', error);
    res.status(500).json({ error: 'Failed to process image with AI' });
  }
});

// ----- Face Recognition with face-api.js -----
const uploadFaces = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const filetypes = /jpeg|jpg|png/;
    if (filetypes.test(file.mimetype)) return cb(null, true);
    cb(new Error('File must be an image (jpeg/jpg/png)'));
  }
});

app.post('/compare-faces', uploadFaces.fields([{ name: 'livePhoto', maxCount: 1 }]), async (req, res) => {
  const { accountNumber } = req.body;
  const livePhotoBuffer = req.files.livePhoto ? req.files.livePhoto[0].buffer : null;

  if (!accountNumber || !livePhotoBuffer) {
    return res.status(400).json({ error: 'accountNumber and livePhoto are required' });
  }

  try {
    // Fetch face photos from external API
    const accountData = await fetchAccountData(accountNumber);
    const faceResults = [];
    let bestSimilarity = 0;
    let isMatch = false;

    // Resize and normalize live image
    const resizedLivePhoto = await sharp(livePhotoBuffer)
      .resize(800, 800, { fit: 'inside' })
      .normalise()
      .jpeg({ quality: 80 })
      .toBuffer();
    const liveImg = await canvas.loadImage(resizedLivePhoto);
    const liveDetection = await faceapi.detectSingleFace(liveImg, new faceapi.TinyFaceDetectorOptions({
      inputSize: 416,
      scoreThreshold: 0.5
    }))
      .withFaceLandmarks()
      .withFaceDescriptor();

    if (!liveDetection) {
      logger.warn(`No face detected in live photo for account: ${accountNumber}`);
      return res.status(400).json({ error: 'No face detected in the live photo' });
    }

    // Process each stored face photo
    for (const item of accountData) {
      const faceUrl = item.photo;
      const storedPhotoBuffer = Buffer.from(faceUrl.split(',')[1], 'base64');
      const resizedStoredPhoto = await sharp(storedPhotoBuffer)
        .resize(800, 800, { fit: 'inside' })
        .normalise()
        .jpeg({ quality: 80 })
        .toBuffer();
      const storedImg = await canvas.loadImage(resizedStoredPhoto);
      const storedDetection = await faceapi.detectSingleFace(storedImg, new faceapi.TinyFaceDetectorOptions({
        inputSize: 416,
        scoreThreshold: 0.5
      }))
        .withFaceLandmarks()
        .withFaceDescriptor();

      if (!storedDetection) {
        logger.warn(`No face detected in stored photo for account: ${accountNumber}`);
        faceResults.push({
          faceUrl,
          isMatch: false,
          similarity: 0
        });
        continue;
      }

      const distance = faceapi.euclideanDistance(liveDetection.descriptor, storedDetection.descriptor);
      const similarity = 1 - distance;
      const match = distance < 0.5;

      faceResults.push({
        faceUrl,
        isMatch: match,
        similarity: parseFloat(similarity.toFixed(4))
      });

      if (similarity > bestSimilarity) {
        bestSimilarity = similarity;
      }
      if (match) {
        isMatch = true;
      }
    }

    logger.info(`Face comparison for account ${accountNumber}: isMatch=${isMatch}, bestSimilarity=${bestSimilarity.toFixed(4)}`);
    res.json({
      isMatch,
      bestSimilarity: parseFloat(bestSimilarity.toFixed(4)),
      faces: faceResults
    });
  } catch (error) {
    logger.error(`Error comparing faces for account ${accountNumber}:`, error);
    res.status(500).json({ error: 'Failed to compare faces', details: error.message });
  }
});

// Start server
app.listen(port, () => {
  logger.info(`Server running at http://localhost:${port}`);
});