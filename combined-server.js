require('dotenv').config();

const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const cors = require('cors');
const axios = require('axios');
const bodyParser = require('body-parser');
const faceapi = require('face-api.js');
const canvas = require('canvas');
const tf = require('@tensorflow/tfjs');
const { Canvas, Image, ImageData } = canvas;
const winston = require('winston');

// LM Studio SDK Imports
const { Chat, LMStudioClient } = require('@lmstudio/sdk');

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
    logger.error(`Error fetching account's data for ${accountNumber}:`, error);
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

// JSON Schema for Cheque Extraction
const chequeSchema = {
  type: "object",
  properties: {
    PayeeName: { type: ["string", "null"] },
    PayerAccountHolderName: { type: ["string", "null"] },
    AmountFigures: { type: ["string", "null"] },
    AmountWords: { type: ["string", "null"] },
    AmountMismatch: { type: ["string", "null"] },
    Date: { type: ["string", "null"] },
    AccountNumber: { type: ["string", "null"] },
    BankName: { type: ["string", "null"] },
    BankBranch: { type: ["string", "null"] },
    RequiredSignatures: { type: ["string", "null"] },
    SignaturesPresent: { type: ["string", "null"] },
    SignatureStatus: { type: ["string", "null"] },
    MICR: { type: ["string", "null"] },
    CheckNumber: { type: ["string", "null"] },
    RoutingNumber: { type: ["string", "null"] },
    BankCode: { type: ["string", "null"] }
  },
  required: [],
  additionalProperties: false
};

// System prompt adapted for cheque extraction
const systemPrompt = `You are a precise cheque data extractor. Analyze handwritten/printed text carefully.
- Assign exact values from the image; ignore struck-through or cancelled text.
- Use null for unclear, empty, or non-applicable fields.
- Empty fields: empty string; empty dates: null.
- For amounts: Match figures vs. words strictly (AmountMismatch: "Yes" if mismatch, "No" otherwise).
- Output ONLY valid JSON matching the provided schema.`;

app.post('/upload-cheque', uploadCheque.single('chequeImage'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image file uploaded.' });

  try {
    const imageBuffer = req.file.buffer;
    const mimeType = req.file.mimetype;
    const base64Image = imageBuffer.toString('base64');

    // LM Studio SDK integration (like the working code)
    const client = new LMStudioClient();
    const model = await client.llm.model("google/gemma-3-12b"); // Use one of your loaded models; switch to vision model ID when loaded

    const chat = Chat.from([
      {
        role: "system",
        content: systemPrompt,
      },
      {
        role: "user",
        content: "Analyze this bank cheque image and extract the following information precisely:\n\n1. **Payee Name**: Full name or \"CASH\"/\"SELF\".\n2. **Payer/Account Holder Name**: Pre-printed account holder.\n3. **Amount in Figures**: Numerical with currency (e.g., \"GHS 1,234.50\").\n4. **Amount in Words**: Written out (e.g., \"One Thousand...\").\n5. **Amount Mismatch**: \"Yes\" if mismatch, \"No\" if match/unclear.\n6. **Date**: Issued date (e.g., \"August 3, 2025\").\n7. **Account Number**: Bank account.\n8. **Bank Name**: Issuing bank.\n9. **Bank Branch**: Branch if visible.\n10. **Required Signatures**: Expected count (e.g., \"1\", \"2\", \"UNKNOWN\").\n11. **Signatures Present**: Visible distinct signatures.\n12. **Signature Status**: \"VALID\" (present >= required or at least one if UNKNOWN), \"INSUFFICIENT\", \"NONE\", \"UNSURE\".\n13. **MICR**: Full MICR line.\n14. **Check Number**: 6-digit (e.g., 090125).\n15. **Routing Number**: 6-digit (e.g., 000347).\n16. **Bank Code**: Last 2 digits in MICR.\n\nUse the exact schema provided.",
        images: await Promise.all([
          client.files.prepareImageBase64("cheque_img_0", base64Image)
        ]),
      },
    ]);

    const result = await model.respond(chat, {
      structured: {
        type: "json",
        jsonSchema: chequeSchema,
      },
    });

    let extractedText = result.content.trim();

    // Clean up if wrapped in code blocks
    if (extractedText.startsWith('```json')) extractedText = extractedText.substring(7);
    if (extractedText.endsWith('```')) extractedText = extractedText.substring(0, extractedText.length - 3);
    extractedText = extractedText.trim();

    let parsedData;
    try {
      parsedData = JSON.parse(extractedText);
      logger.info('Cheque processed successfully via local AI');
    } catch (jsonError) {
      logger.error('Local AI response not valid JSON:', extractedText, jsonError);
      return res.status(500).json({ error: 'AI output not JSON', rawResponse: extractedText });
    }

    res.json({ success: true, extractedData: parsedData });
  } catch (error) {
    logger.error('Error with local AI server:', error);
    if (error.message && error.message.includes('vision') || error.statusCode === 400 || error.statusCode === 500) {
      logger.warn('Model likely lacks vision support. Load a vision model (e.g., LLaVA) in LM Studio.');
      return res.status(503).json({ error: 'Local AI server error (load a vision model like LLaVA in LM Studio for image processing)' });
    }
    res.status(500).json({ error: 'Failed to process image with local AI', details: error.message });
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