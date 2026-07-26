-- Seed: Loan business rules in system_configs
-- Targets the real table `system_configs` (unique on "key").
-- Safe to re-run — uses ON CONFLICT.

INSERT INTO system_configs (key, name, value, description, "dataType", category, "isActive", "createdAt", "updatedAt") VALUES
    ('RULE_LOAN_LT_MAX_AMT',    'Max Amount (Regular Loan)',    '1000000', 'Regular Loan maximum amount (Rs 10,00,000)',  'number',     'business_rules', true, NOW(), NOW()),
    ('RULE_LOAN_EL_MAX_AMT',    'Max Amount (Emergency Loan)',  '500000',  'Emergency Loan maximum amount (Rs 5,00,000)', 'number',     'business_rules', true, NOW(), NOW()),
    ('RULE_LOAN_LT_MAX_TENURE', 'Max Tenure (Regular Loan)',    '120',     'Regular Loan maximum tenure in months',       'number',     'business_rules', true, NOW(), NOW()),
    ('RULE_LOAN_EL_MAX_TENURE', 'Max Tenure (Emergency Loan)',  '60',      'Emergency Loan maximum tenure in months',     'number',     'business_rules', true, NOW(), NOW()),
    ('RULE_LOAN_LT_INTEREST_RATE','Interest Rate (Regular Loan)', '12',    'Regular Loan annual interest rate',           'percentage', 'business_rules', true, NOW(), NOW()),
    ('RULE_LOAN_EL_INTEREST_RATE','Interest Rate (Emergency Loan)','12',   'Emergency Loan annual interest rate',         'percentage', 'business_rules', true, NOW(), NOW())
ON CONFLICT (key) DO UPDATE
    SET value       = EXCLUDED.value,
        name        = EXCLUDED.name,
        description = EXCLUDED.description,
        "updatedAt" = NOW();
