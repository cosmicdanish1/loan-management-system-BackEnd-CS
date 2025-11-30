/**
 * Utility class for generating member numbers
 */
export class MemberNumberUtil {
  /**
   * Generate a member number with format: MEM + padded sequence number
   * @param sequenceNumber - The sequence number for the member
   * @returns Formatted member number (e.g., MEM001, MEM002, etc.)
   */
  static generateMemberNumber(sequenceNumber: number): string {
    const paddedNumber = sequenceNumber.toString().padStart(6, '0');
    return `MEM${paddedNumber}`;
  }

  /**
   * Extract sequence number from member number
   * @param memberNumber - The member number (e.g., MEM000001)
   * @returns The sequence number
   */
  static extractSequenceNumber(memberNumber: string): number {
    const match = memberNumber.match(/^MEM(\d+)$/);
    return match ? parseInt(match[1], 10) : 0;
  }

  /**
   * Validate member number format
   * @param memberNumber - The member number to validate
   * @returns True if valid format, false otherwise
   */
  static isValidMemberNumber(memberNumber: string): boolean {
    return /^MEM\d{6}$/.test(memberNumber);
  }
}
