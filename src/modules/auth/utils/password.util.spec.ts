import { PasswordUtil } from './password.util';

describe('PasswordUtil', () => {
  describe('hashPassword', () => {
    it('should hash a password', async () => {
      const password = 'testPassword123';
      const hashedPassword = await PasswordUtil.hashPassword(password);

      expect(hashedPassword).toBeDefined();
      expect(hashedPassword).not.toBe(password);
      expect(hashedPassword.length).toBeGreaterThan(0);
    });

    it('should generate different hashes for the same password', async () => {
      const password = 'testPassword123';
      const hash1 = await PasswordUtil.hashPassword(password);
      const hash2 = await PasswordUtil.hashPassword(password);

      expect(hash1).not.toBe(hash2);
    });
  });

  describe('comparePassword', () => {
    it('should return true for matching password and hash', async () => {
      const password = 'testPassword123';
      const hashedPassword = await PasswordUtil.hashPassword(password);

      const result = await PasswordUtil.comparePassword(password, hashedPassword);

      expect(result).toBe(true);
    });

    it('should return false for non-matching password and hash', async () => {
      const password = 'testPassword123';
      const wrongPassword = 'wrongPassword456';
      const hashedPassword = await PasswordUtil.hashPassword(password);

      const result = await PasswordUtil.comparePassword(wrongPassword, hashedPassword);

      expect(result).toBe(false);
    });
  });

  describe('generateRandomPassword', () => {
    it('should generate a password with default length', () => {
      const password = PasswordUtil.generateRandomPassword();

      expect(password).toBeDefined();
      expect(password.length).toBe(12);
    });

    it('should generate a password with specified length', () => {
      const length = 16;
      const password = PasswordUtil.generateRandomPassword(length);

      expect(password).toBeDefined();
      expect(password.length).toBe(length);
    });

    it('should generate different passwords on multiple calls', () => {
      const password1 = PasswordUtil.generateRandomPassword();
      const password2 = PasswordUtil.generateRandomPassword();

      expect(password1).not.toBe(password2);
    });
  });

  describe('validatePasswordStrength', () => {
    it('should validate a strong password', () => {
      const strongPassword = 'StrongPass123!';
      const result = PasswordUtil.validatePasswordStrength(strongPassword);

      expect(result.isValid).toBe(true);
      expect(result.score).toBeGreaterThanOrEqual(3);
      expect(result.feedback).toHaveLength(0);
    });

    it('should invalidate a weak password', () => {
      const weakPassword = 'weak';
      const result = PasswordUtil.validatePasswordStrength(weakPassword);

      expect(result.isValid).toBe(false);
      expect(result.score).toBeLessThan(3);
      expect(result.feedback.length).toBeGreaterThan(0);
    });

    it('should provide feedback for missing requirements', () => {
      const passwordWithoutUppercase = 'lowercase123!';
      const result = PasswordUtil.validatePasswordStrength(passwordWithoutUppercase);

      expect(result.feedback).toContain('Password should contain uppercase letters');
    });

    it('should provide feedback for short password', () => {
      const shortPassword = 'Aa1!';
      const result = PasswordUtil.validatePasswordStrength(shortPassword);

      expect(result.feedback).toContain('Password should be at least 8 characters long');
    });

    it('should provide feedback for missing numbers', () => {
      const passwordWithoutNumbers = 'StrongPassword!';
      const result = PasswordUtil.validatePasswordStrength(passwordWithoutNumbers);

      expect(result.feedback).toContain('Password should contain numbers');
    });

    it('should provide feedback for missing special characters', () => {
      const passwordWithoutSpecial = 'StrongPassword123';
      const result = PasswordUtil.validatePasswordStrength(passwordWithoutSpecial);

      expect(result.feedback).toContain('Password should contain special characters');
    });
  });
});
