// utils/barcode.js — Pure-JS Code128B barcode SVG generator (no npm deps)
// Generates a scannable SVG barcode from any AWB/string

const CODE128B_START = 104;
const CODE128_STOP   = 106;

// Code128B patterns: each entry = 11-bit bar pattern (1=bar, 0=space)
const PATTERNS = [
  '11011001100','11001101100','11001100110','10010011000','10010001100',
  '10001001100','10011001000','10011000100','10001100100','11001001000',
  '11001000100','11000100100','10110011100','10011011100','10011001110',
  '10111001100','10011101100','10011100110','11001110010','11001011100',
  '11001001110','11011100100','11001110100','11101101110','11101001100',
  '11100101100','11100100110','11101100100','11100110100','11100110010',
  '11011011000','11011000110','11000110110','10100011000','10001011000',
  '10001000110','10110001000','10001101000','10001100010','11010001000',
  '11000101000','11000100010','10110111000','10110001110','10001101110',
  '10111011000','10111000110','10001110110','11101110110','11010001110',
  '11000101110','11011101000','11011100010','11011101110','11101011000',
  '11101000110','11100010110','11101101000','11101100010','11100011010',
  '11101111010','11001000010','11110001010','10100110000','10100001100',
  '10010110000','10010000110','10000101100','10000100110','10110010000',
  '10110000100','10011010000','10011000010','10000110100','10000110010',
  '11000010010','11001010000','11110111010','11000010100','10001111010',
  '10100111100','10010111100','10010011110','10111100100','10011110100',
  '10011110010','11110100100','11110010100','11110010010','11011011110',
  '11011110110','11110110110','10101111000','10100011110','10001011110',
  '10111101000','10111100010','11110101000','11110100010','10111011110',
  '10111101110','11101011110','11110101110','11010000100','11010010000',
  '11010011100','11000111010'
];

function encode(text) {
  const vals = [CODE128B_START];
  let checksum = CODE128B_START;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i) - 32;
    if (code < 0 || code > 95) continue; // skip non-printable
    vals.push(code);
    checksum += code * (i + 1);
  }
  vals.push(checksum % 103);
  vals.push(CODE128_STOP);
  return vals;
}

function generateBarcodeSVG(text, opts = {}) {
  const barWidth  = opts.barWidth  || 2;
  const height    = opts.height    || 60;
  const showText  = opts.showText  !== false;
  const fontSize  = opts.fontSize  || 11;
  const color     = opts.color     || '#000000';

  const vals    = encode(text);
  // Build bit string: quiet zone + bars + quiet zone
  const quiet   = '0000000000'; // 10 quiet modules
  const bits    = quiet + vals.map(v => PATTERNS[v]).join('') + '11' + quiet; // STOP has extra bar

  const svgWidth = bits.length * barWidth;
  const totalH   = height + (showText ? fontSize + 6 : 0);

  let bars = '';
  let i = 0;
  while (i < bits.length) {
    const bit = bits[i];
    let j = i;
    while (j < bits.length && bits[j] === bit) j++;
    const w = (j - i) * barWidth;
    if (bit === '1') {
      bars += `<rect x="${i * barWidth}" y="0" width="${w}" height="${height}" fill="${color}"/>`;
    }
    i = j;
  }

  const labelY = height + fontSize + 2;
  const textEl = showText
    ? `<text x="${svgWidth / 2}" y="${labelY}" text-anchor="middle" font-family="monospace" font-size="${fontSize}" fill="${color}">${text}</text>`
    : '';

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${svgWidth}" height="${totalH}" viewBox="0 0 ${svgWidth} ${totalH}">${bars}${textEl}</svg>`;
}

module.exports = { generateBarcodeSVG };
