USE bank_signatures;

INSERT INTO accounts (account_number, account_holder, bank_name, branch_name, account_type, required_signatures) VALUES
('0600017567560', 'Union Systems Global Limited', 'Societe Generale Ghana', 'Kaneshie Market', 'business', 2),
('9040007857211', 'Benjamin Anderson', 'Stanbic Bank', 'Ring Road Central', 'personal', 1),
('3051010011804', 'Stella Oparebea Boi', 'GCB', 'Winneba', 'joint', 2);

INSERT INTO signatures (account_id, signature_url) VALUES
((SELECT account_id FROM accounts WHERE account_number = '0600017567560'), 'https://res.cloudinary.com/demo/image/upload/v1/signatures/usgl_sig1'),
((SELECT account_id FROM accounts WHERE account_number = '0600017567560'), 'https://res.cloudinary.com/demo/image/upload/v1/signatures/usgl_sig2'),
((SELECT account_id FROM accounts WHERE account_number = '9040007857211'), 'https://res.cloudinary.com/demo/image/upload/v1/signatures/ba_sig1'),
((SELECT account_id FROM accounts WHERE account_number = '3051010011804'), 'https://res.cloudinary.com/demo/image/upload/v1/signatures/sob_sig1'),
((SELECT account_id FROM accounts WHERE account_number = '3051010011804'), 'https://res.cloudinary.com/demo/image/upload/v1/signatures/sob_sig2');