-- ES-365: interestpaid.account_number was numeric(9) but the saving account number is the member number, and
-- member numbers can have 10 digits (e.g. 9999962472): the insert failed with "numeric field overflow" and the
-- whole interest run was rolled back. Same width as interestpaid.mbno. Safe to run more than once.
ALTER TABLE interestpaid ALTER COLUMN account_number TYPE numeric(18,0);
