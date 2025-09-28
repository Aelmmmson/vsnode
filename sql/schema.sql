CREATE DATABASE bank_signatures;

USE bank_signatures;

CREATE TABLE accounts (
  account_id INT AUTO_INCREMENT PRIMARY KEY,
  account_number VARCHAR(50) UNIQUE NOT NULL,
  account_holder VARCHAR(100) NOT NULL,
  bank_name VARCHAR(100) NOT NULL,
  branch_name VARCHAR(100) NOT NULL,
  account_type ENUM('personal', 'business', 'joint') NOT NULL,
  required_signatures INT NOT NULL
);

CREATE TABLE signatures (
  signature_id INT AUTO_INCREMENT PRIMARY KEY,
  account_id INT NOT NULL,
  signature_url VARCHAR(255) NOT NULL,
  FOREIGN KEY (account_id) REFERENCES accounts(account_id)
);




-- NEW
-- Updated SQL Schema for bank_signatures DB
-- Adds a new table `faces` similar to `signatures` to store customer face photos per account.
-- This allows multiple faces per account if needed (e.g., for variations), but you can use one per account.
-- Run this SQL on your MySQL database to update the schema.

-- Create the `faces` table
DROP TABLE IF EXISTS `faces`;
CREATE TABLE IF NOT EXISTS `faces` (
  `face_id` int NOT NULL AUTO_INCREMENT,
  `account_id` int NOT NULL,
  `face_url` varchar(255) NOT NULL,
  PRIMARY KEY (`face_id`),
  KEY `account_id` (`account_id`)
) ENGINE=MyISAM AUTO_INCREMENT=1 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Example insert statements (replace with your actual URLs; add as needed)
INSERT INTO `faces` (`account_id`, `face_url`) VALUES
(1, 'https://res.cloudinary.com/dufkynfvg/image/upload/v1754395761/customer_face1.jpg'),
(2, 'https://res.cloudinary.com/dufkynfvg/image/upload/v1754395761/customer_face2.jpg'),
(3, 'https://res.cloudinary.com/dufkynfvg/image/upload/v1754395761/customer_face3.jpg');