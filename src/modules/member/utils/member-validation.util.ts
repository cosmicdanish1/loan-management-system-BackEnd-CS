/**
 * Utility class for member data validation
 */
export class MemberValidationUtil {
  /**
   * Validate Aadhar number format
   * @param aadharNumber - The Aadhar number to validate
   * @returns True if valid, false otherwise
   */
  static isValidAadhar(aadharNumber: string): boolean {
    if (!aadharNumber) return true; // Optional field
    return /^\d{12}$/.test(aadharNumber);
  }

  /**
   * Validate PAN number format
   * @param panNumber - The PAN number to validate
   * @returns True if valid, false otherwise
   */
  static isValidPAN(panNumber: string): boolean {
    if (!panNumber) return true; // Optional field
    return /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/.test(panNumber);
  }

  /**
   * Validate phone number format
   * @param phoneNumber - The phone number to validate
   * @returns True if valid, false otherwise
   */
  static isValidPhoneNumber(phoneNumber: string): boolean {
    // Allow various formats: +919876543210, 919876543210, 9876543210
    return /^(\+91|91)?[6-9]\d{9}$/.test(phoneNumber);
  }

  /**
   * Validate email format
   * @param email - The email to validate
   * @returns True if valid, false otherwise
   */
  static isValidEmail(email: string): boolean {
    if (!email) return true; // Optional field
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  }

  /**
   * Validate age based on date of birth
   * @param dateOfBirth - The date of birth
   * @param minAge - Minimum age required (default: 18)
   * @param maxAge - Maximum age allowed (default: 100)
   * @returns True if age is within range, false otherwise
   */
  static isValidAge(dateOfBirth: Date, minAge: number = 18, maxAge: number = 100): boolean {
    const today = new Date();
    const birthDate = new Date(dateOfBirth);
    const age = today.getFullYear() - birthDate.getFullYear();
    const monthDiff = today.getMonth() - birthDate.getMonth();
    
    const actualAge = monthDiff < 0 || (monthDiff === 0 && today.getDate() < birthDate.getDate()) 
      ? age - 1 
      : age;

    return actualAge >= minAge && actualAge <= maxAge;
  }

  /**
   * Sanitize and format phone number
   * @param phoneNumber - The phone number to format
   * @returns Formatted phone number
   */
  static formatPhoneNumber(phoneNumber: string): string {
    // Remove all non-digit characters
    const digits = phoneNumber.replace(/\D/g, '');
    
    // If starts with 91, keep it; if starts with +91, remove +; if 10 digits, add 91
    if (digits.startsWith('91') && digits.length === 12) {
      return digits;
    } else if (digits.length === 10) {
      return `91${digits}`;
    }
    
    return digits;
  }

  /**
   * Validate and sanitize member data
   * @param memberData - The member data to validate
   * @returns Validation result with errors if any
   */
  static validateMemberData(memberData: any): { isValid: boolean; errors: string[] } {
    const errors: string[] = [];

    // Validate required fields
    if (!memberData.firstName?.trim()) {
      errors.push('First name is required');
    }

    if (!memberData.lastName?.trim()) {
      errors.push('Last name is required');
    }

    if (!memberData.dateOfBirth) {
      errors.push('Date of birth is required');
    } else if (!this.isValidAge(new Date(memberData.dateOfBirth))) {
      errors.push('Member must be between 18 and 100 years old');
    }

    if (!memberData.address?.trim()) {
      errors.push('Address is required');
    }

    if (!memberData.phoneNumber?.trim()) {
      errors.push('Phone number is required');
    } else if (!this.isValidPhoneNumber(memberData.phoneNumber)) {
      errors.push('Invalid phone number format');
    }

    // Validate optional fields
    if (memberData.email && !this.isValidEmail(memberData.email)) {
      errors.push('Invalid email format');
    }

    if (memberData.aadharNumber && !this.isValidAadhar(memberData.aadharNumber)) {
      errors.push('Invalid Aadhar number format');
    }

    if (memberData.panNumber && !this.isValidPAN(memberData.panNumber)) {
      errors.push('Invalid PAN number format');
    }

    return {
      isValid: errors.length === 0,
      errors,
    };
  }
}
