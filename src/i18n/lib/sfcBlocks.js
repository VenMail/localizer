/** Find complete SFC sections, matching nested Vue <template> slot tags. */
function findSfcBlocks(source, tagName) {
  // Skip comments and raw-text sections while finding templates; a string in
  // a script or a commented-out slot must not change the template depth.
  const tag = tagName === 'template'
    ? /<!--[\s\S]*?-->|<(?:script|style)\b[^>]*>[\s\S]*?<\/(?:script|style)\s*>|<(\/?)template\b[^>]*>/gi
    : /<!--[\s\S]*?-->|<(\/?)script\b[^>]*>/gi;
  const templateBlocks = tagName === 'script' ? findSfcBlocks(source, 'template') : [];
  const blocks = [];
  let depth = 0;
  let opened = null;
  let match;
  while ((match = tag.exec(source)) !== null) {
    if (match[1] === undefined) continue;
    if (templateBlocks.some(block => match.index >= block.start && match.index < block.end)) continue;
    if (!match[1]) {
      if (tagName === 'script' && depth > 0) continue;
      if (/\/\s*>$/.test(match[0])) continue;
      if (depth === 0) opened = { start: match.index, innerStart: tag.lastIndex };
      depth++;
    } else if (depth > 0) {
      depth--;
      if (depth === 0) {
        blocks.push({ ...opened, innerEnd: match.index, end: tag.lastIndex });
        opened = null;
      }
    }
  }
  return blocks;
}

module.exports = { findSfcBlocks };
