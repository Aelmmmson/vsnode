const express = require('express');
const router = express.Router();
const db = require('../config/db');

// POST endpoint to get account details by account number
router.post('/signature', async (req, res) => {
  const { accountNumber } = req.body;
  
  if (!accountNumber) {
    return res.status(400).json({ error: 'Account number is required' });
  }

  try {
    const [rows] = await db.query(`
      SELECT 
        a.account_number,
        a.account_holder,
        a.bank_name,
        a.branch_name,
        a.account_type,
        a.required_signatures,
        s.signature_url
      FROM accounts a
      LEFT JOIN signatures s ON a.account_id = s.account_id
      WHERE a.account_number = ?
    `, [accountNumber]);

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Account not found' });
    }

    res.json({
      account: {
        accountNumber: rows[0].account_number,
        accountHolder: rows[0].account_holder,
        bankName: rows[0].bank_name,
        branchName: rows[0].branch_name,
        accountType: rows[0].account_type,
        requiredSignatures: rows[0].required_signatures,
        signatures: rows.map(row => row.signature_url).filter(url => url)
      }
    });
  } catch (error) {
    console.error('Error fetching account:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;