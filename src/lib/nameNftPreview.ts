/**
 * CAW name NFT preview (v0.3.8): the REAL design, reproduced
 * locally for any name before it is minted.
 *
 * Verified against the chain (2026-11-08): tokenURI of the
 * CAW_NAME contract (0x864f...393f) returns a data-URI JSON
 * whose image is a data-URI SVG. Across 600+ sampled tokens the
 * SVG is byte-identical except for ONE <text> element: the name
 * itself, in monospace bold white, end-anchored at x=90%,
 * y=231, with a font size that depends only on the name length
 * (measured on-chain for every length: 3->99, 4->77, 5->64,
 * 6->55, 7->49, 8->44, 9->40, 10->36, 11->33, 12->31, 13->29,
 * 14->27, 15->25, 16->23, 17 and longer -> 22). The template
 * below is the exact on-chain SVG with that text element
 * regenerated, so the preview is the true mint image.
 */
const FONT_SIZE: Record<number, number> = {
  3: 99, 4: 77, 5: 64, 6: 55, 7: 49, 8: 44, 9: 40, 10: 36,
  11: 33, 12: 31, 13: 29, 14: 27, 15: 25, 16: 23,
};

export function nameNftFontSize(name: string): number {
  const len = [...name].length;
  if (len >= 17) return 22;
  return FONT_SIZE[len] ?? 99;
}

const SVG_PRE = "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"270\" height=\"270\" viewBox=\"0 0 270 270\" fill=\"none\" data-ember-extension=\"1\"> <rect width=\"270\" height=\"270\" fill=\"url(#paint0_linear)\"/> <defs> <filter id=\"dropShadow\" color-interpolation-filters=\"sRGB\" filterUnits=\"userSpaceOnUse\" height=\"270\" width=\"270\"> <feDropShadow dx=\"0\" dy=\"1\" stdDeviation=\"2\" flood-opacity=\"0.225\" width=\"200%\" height=\"200%\"/> </filter> </defs><path d=\"M30.36,35.15l15.28,1.29a7.47,7.47,0,0,0,5.29-3l-1.84-7.27a33,33,0,0,1,8.77,0L56,33.42s1.69,3.13,6.6,2.94c.75,0,14-1.25,14-1.25L69.15,45.52l-5.73.54a9.57,9.57,0,0,1-4.11-.29,10.59,10.59,0,0,1-3-1.63L53.47,50.6l-2.73-6.45a10.13,10.13,0,0,0-1.52.88c-2,1.36-5.49,1.08-5.49,1.08l-5.82-.48Z\" style=\"fill:#000000\" filter=\"url(#dropShadow)\"/><path d=\"M48.32,84.39,41.8,70.51a7.45,7.45,0,0,0-5.25-3.07l-5.39,5.22a33.26,33.26,0,0,1-4.4-7.58L34,63s1.86-3-.75-7.18c-.4-.63-8.06-11.48-8.06-11.48l12.72,1.23,3.33,4.69A9.54,9.54,0,0,1,43.05,54a10.71,10.71,0,0,1,.09,3.41l7-.76-4.22,5.59a10.44,10.44,0,0,0,1.52.86c2.19,1.08,3.67,4.22,3.67,4.22l2.5,5.28Z\" style=\"fill:#000000\" filter=\"url(#dropShadow)\"/><path d=\"M82,44.21,73.25,56.8a7.46,7.46,0,0,0,0,6.09l7.22,2a32.65,32.65,0,0,1-4.36,7.6l-5.39-5.26s-3.55-.1-5.85,4.25c-.35.66-5.9,12.72-5.9,12.72l-5.3-11.64L56,67.39A9.69,9.69,0,0,1,58.34,64a10.82,10.82,0,0,1,2.9-1.78L57.07,56.5l6.95.86a11.11,11.11,0,0,0,0-1.76c-.17-2.43,1.81-5.29,1.81-5.29l3.32-4.8Z\" style=\"fill:#000000\" filter=\"url(#dropShadow)\"/>";
const SVG_POST = " <defs> <style> text { font-family: monospace; font-style: normal; font-weight: bold; line-height: 34px; } </style> <linearGradient id=\"paint0_linear\" x1=\"110.5\" y1=\"140\" x2=\"-30\" gradientUnits=\"userSpaceOnUse\" y42=\"37.5\"> <stop stop-color=\"#000000\"/> <stop offset=\"0.25\" stop-color=\"#ECc052\"/> <stop offset=\"1\" stop-color=\"#ECc052\"/> </linearGradient> <linearGradient id=\"paint1_linear\" x1=\"0\" y1=\"0\" x2=\"269.553\" y2=\"285.527\" gradientUnits=\"userSpaceOnUse\"> <stop stop-color=\"#000000\"/> <stop offset=\"1\" stop-color=\"#22222\"/> </linearGradient> </defs> </svg>";

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** The exact SVG the contract serves for this name's NFT. */
export function nameNftSvg(name: string): string {
  const fs = nameNftFontSize(name);
  return (
    SVG_PRE +
    '<text y="231" font-size="' + fs + 'px" fill="white" filter="url(#dropShadow)" style="text-anchor: end;" x="90%">' +
    xmlEscape(name) +
    '</text>' +
    SVG_POST
  );
}
