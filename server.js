// combined-server.js
// This is the merged server combining all three projects.
// Run on a single port, e.g., 5000. Update your frontend API calls to use this unified port.
// All endpoints remain the same: /compare-signatures, /upload-cheque, /api/accounts/signature
// Dependencies: Install all from the three projects: express, multer, sharp, cors, dotenv, @google/generative-ai, body-parser
// Also, ensure you have the db config from project 3.
// For routes, I've assumed the routes file is './routes/accounts.js' and corrected the name for consistency.

require('dotenv').config(); // From project 2, for GEMINI_API_KEY

const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const bodyParser = require('body-parser'); // From project 3, though express.json() could replace it
const accountRoutes = require('./routes/accounts'); // From project 3; ensure the file is named accounts.js
// If it's account.js, change to require('./routes/account');

const app = express();
const port = process.env.PORT || 7007; // Unified port; can be set via .env or default to 5000

// CORS setup: Using the flexible one from project 1 to allow all localhost origins
app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);
    
    // Allow all localhost ports
    if (origin.startsWith('http://localhost')) {
      return callback(null, true);
    }
    
    callback(new Error('Not allowed by CORS'));
  }
}));

// Middleware for JSON parsing; combining express.json() and bodyParser.json()
app.use(express.json());
app.use(bodyParser.json());

// Multer configs are endpoint-specific, so defined separately below

// Error handling middleware from project 1 (for multer errors)
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    console.error('Multer error:', err.message, 'Field:', err.field);
    return res.status(400).json({ error: `Multer error: ${err.message}`, field: err.field });
  }
  next(err);
});

// ----- Project 1: Signature Comparison -----

const uploadSignatures = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
  fileFilter: (req, file, cb) => {
    const filetypes = /jpeg|jpg|png/;
    const mimetype = filetypes.test(file.mimetype);
    if (mimetype) {
      return cb(null, true);
    }
    cb(new Error('File must be an image (jpeg/jpg/png)'));
  }
});

// Endpoint to compare two signatures
app.post('/compare-signatures', uploadSignatures.fields([
  { name: 'signature1', maxCount: 1 },
  { name: 'signature2', maxCount: 1 }
]), async (req, res) => {
  try {
    const { signature1, signature2 } = req.files;

    if (!signature1 || !signature2) {
      return res.status(400).json({ error: 'Two signature images are required' });
    }

    // Process images with sharp
    const [img1, img2] = await Promise.all([
      sharp(signature1[0].buffer).resize(300, 150).grayscale().raw().toBuffer({ resolveWithObject: true }),
      sharp(signature2[0].buffer).resize(300, 150).grayscale().raw().toBuffer({ resolveWithObject: true })
    ]);

    // Verify dimensions match
    if (img1.info.width !== img2.info.width || img1.info.height !== img2.info.height) {
      return res.status(400).json({ error: 'Images must have the same dimensions after resizing' });
    }

    // Compare pixel data
    const pixelCount = img1.info.width * img1.info.height;
    let difference = 0;
    for (let i = 0; i < pixelCount; i++) {
      difference += Math.abs(img1.data[i] - img2.data[i]);
    }

    // Calculate similarity (0 = identical, higher = more different)
    const maxDifference = pixelCount * 255; // Max difference for grayscale
    const similarity = 1 - (difference / maxDifference);

    res.json({ similarity: similarity.toFixed(4) });
  } catch (error) {
    console.error('Error comparing signatures:', error);
    res.status(500).json({ error: 'Failed to compare signatures', details: error.message });
  }
});

// ----- Project 2: Cheque Image Upload and Extraction -----

// Configure Multer for cheque uploads
const uploadCheque = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 } // 20MB limit
});

// Initialize Gemini API
const geminiApiKey = process.env.GEMINI_API_KEY;
if (!geminiApiKey) {
  console.error("GEMINI_API_KEY is not set in the .env file. Please check your .env file.");
  process.exit(1);
}
const genAI = new GoogleGenerativeAI(geminiApiKey);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash-latest" }); // Using a current model

// Helper function to convert buffer to base64 for Gemini
function fileToGenerativePart(buffer, mimeType) {
  return {
    inlineData: {
      data: buffer.toString("base64"),
      mimeType
    },
  };
}

// API endpoint for image upload and text extraction
app.post('/upload-cheque', uploadCheque.single('chequeImage'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No image file uploaded.' });
  }

  try {
    const imageBuffer = req.file.buffer;
    const mimeType = req.file.mimetype;

    const imagePart = fileToGenerativePart(imageBuffer, mimeType);

    const prompt = `Analyze this bank cheque image meticulously and extract the following information. Pay close attention to both printed and handwritten fields. Provide very precise and accurate details.

    1.  **Payee Name**: The full name of the person or entity to whom the cheque is made payable. This is often handwritten. If it says "CASH" or "SELF", extract that.
    2.  **Payer/Account Holder Name**: The full name of the individual or entity whose bank account the cheque is drawn from. This is typically pre-printed or typed.
    3.  **Amount in Figures**: The numerical amount of the cheque, including currency symbol (e.g., "GHS 1,234.50" or "$500.00").
    4.  **Amount in Words**: The amount of the cheque written out in words (e.g., "One Thousand Two Hundred Thirty-Four Ghana Cedis and Fifty Pesewas").
    5.  **Amount Mismatch**: Determine if the "Amount in Figures" and "Amount in Words" clearly do NOT match. State "Yes" if there's a mismatch, "No" if they match or if either is unclear/missing preventing a comparison.
    6.  **Date**: The date the cheque was issued (e.g., "August 3, 2025" or "03/08/2025").
    7.  **Account Number**: The bank account number.
    8.  **Bank Name**: The full name of the issuing bank.
    9.  **Bank Branch**: The specific branch name of the bank, if discernible.
    10. **Required Signatures**: How many signatures are expected for this cheque to be valid (e.g., "1", "2", "UNKNOWN" if not clearly indicated on the cheque itself).
    11. **Signatures Present**: The actual number of distinct signatures physically visible on the cheque.
    12. **Signature Status**: Based on comparison: "VALID" (present >= required, or if required is UNKNOWN and at least one is present), "INSUFFICIENT" (present < required), "NONE" (no signatures present), "UNSURE" (if unable to confidently determine required or present).

    13. **MICR**: MICR number.
    14. **Check Number**: The check number; normally a 6 digit pre-printed on the cheque below the routing number at the top right or first set of numbers in the micr (eg. 09-01-25 -top right or 090125 in micr).
    14. **Routing Number**: The routing number; normally a 6 digit pre-printed on the cheque above the check number at the top right or second set of digits in the micr (eg. 000347).
    15. **Bank Code**: Usually the last set 2 digit number in the micr.

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

    // --- IMPORTANT FIX HERE ---
    // Remove markdown code block wrappers if they exist
    if (extractedText.startsWith('```json')) {
      extractedText = extractedText.substring(7); // Remove '```json
    }
    if (extractedText.endsWith('```')) {
      extractedText = extractedText.substring(0, extractedText.length - 3); // Remove '\n```' or '```'
    }
    extractedText = extractedText.trim(); // Trim any leading/trailing whitespace

    // Attempt to parse the text as JSON.
    let parsedData;
    try {
      parsedData = JSON.parse(extractedText);
    } catch (jsonError) {
      console.error('Gemini response was not a valid JSON string (after stripping markdown):', extractedText, jsonError);
      // If it still fails, the structure inside the markdown block was bad JSON.
      return res.status(500).json({
        error: 'AI could not format the output as perfect JSON. Raw response (after stripping markdown) received:',
        rawResponse: extractedText
      });
    }

    res.json({ success: true, extractedData: parsedData });

  } catch (error) {
    console.error('Error processing image with Gemini API:', error);
    res.status(500).json({ error: 'Failed to process image with AI. Please try again. Check backend logs for details.' });
  }
});

// ----- Project 3: Account Routes -----

app.use('/api/accounts', accountRoutes);

// Start the server
app.listen(port, () => {
  console.log(`Combined server running at http://localhost:${port}`);
});