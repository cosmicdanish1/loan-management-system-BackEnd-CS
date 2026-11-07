const ONES = ['', 'One ', 'Two ', 'Three ', 'Four ', 'Five ', 'Six ', 'Seven ', 'Eight ', 'Nine ', 'Ten ', 'Eleven ', 'Twelve ', 'Thirteen ', 'Fourteen ', 'Fifteen ', 'Sixteen ', 'Seventeen ', 'Eighteen ', 'Nineteen '];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

/** 1..99 as words, with a trailing space ('' for 0) */
function twoDigits(n: number): string {
    if (n === 0) return '';
    return ONES[n] || TENS[Math.floor(n / 10)] + ' ' + ONES[n % 10];
}

/** Whole rupees (Indian grouping: Crore / Lakh / Thousand / Hundred); crores above 99 are spelled out by recursion */
function wholeToWords(n: number): string {
    if (n === 0) return 'Zero';
    const crore = Math.floor(n / 10000000);
    const lakh = Math.floor(n / 100000) % 100;
    const thousand = Math.floor(n / 1000) % 100;
    const hundred = Math.floor(n / 100) % 10;
    const rest = n % 100;

    let str = '';
    if (crore) str += (crore >= 100 ? wholeToWords(crore) + ' ' : twoDigits(crore)) + 'Crore ';
    if (lakh) str += twoDigits(lakh) + 'Lakh ';
    if (thousand) str += twoDigits(thousand) + 'Thousand ';
    if (hundred) str += ONES[hundred] + 'Hundred ';
    if (rest) str += (str !== '' ? 'and ' : '') + twoDigits(rest);
    return str.trim();
}

/**
 * Amount in words, Indian system. 0 is "Zero Only"; a fractional amount adds the paise
 * ("... Rupees and Fifty Paise Only"); anything that is not a finite number gives ''.
 */
export function numberToWords(num: number): string {
    const value = Number(num);
    if (!Number.isFinite(value)) return '';
    const negative = value < 0;
    const totalPaise = Math.round(Math.abs(value) * 100);
    const rupees = Math.floor(totalPaise / 100);
    const paise = totalPaise % 100;

    let words = wholeToWords(rupees);
    if (paise) words += ` Rupees and ${twoDigits(paise).trim()} Paise`;
    return (negative ? 'Minus ' : '') + words + ' Only';
}
