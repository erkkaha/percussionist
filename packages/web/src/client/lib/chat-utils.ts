// chat-utils.ts — utilities for parsing structured content in agent chat messages

/** An option definition extracted from an [!option ...] tag */
export interface OptionDef {
  key: string;
  label: string;
  description?: string;
}

/**
 * Parse [!options] blocks from agent message text.
 *
 * Extracts structured option definitions from:
 *   [!options]
 *   [!option key="x" label="y" description="z"]
 *   [/!options]
 *
 * Returns the parsed options and text with successfully parsed blocks removed.
 * Malformed blocks are left as-is (raw tags visible) for graceful degradation.
 */
export function parseOptionBlocks(text: string): { options: OptionDef[]; cleanText: string } {
  const options: OptionDef[] = [];
  
  // Pattern to match [!options]...[/!options] blocks
  const blockRegex = /\[!options\]([\s\S]*?)\[\/!options\]/g;
  
  let cleanText = text;
  let match: RegExpExecArray | null;

  while ((match = blockRegex.exec(text)) !== null) {
    const blockContent = match[1];
    if (blockContent === undefined) continue;

    // Parse individual [!option ...] lines within the block
    const optionLines = blockContent.split("\n").map((line) => line.trim());
    
    for (const line of optionLines) {
      if (!line.startsWith("[!option ")) continue;
      
      const parsed = parseOptionLine(line);
      if (parsed) {
        options.push(parsed);
      }
    }
    
    // Remove this successfully parsed block from cleanText
    cleanText = cleanText.replace(match[0], "");
  }

  return { options, cleanText };
}

/**
 * Parse a single [!option key="x" label="y" description="z"] line.
 *
 * Extracts quoted attributes. Returns null if required attributes (key/label)
 * are missing or malformed.
 */
function parseOptionLine(line: string): OptionDef | null {
  // Expected format: [!option key="value" label="value" description="value"]
  
  const result: Partial<OptionDef> = {};
  
  // Match quoted attribute patterns: key="value"
  const attrRegex = /(\w+)="([^"]*)"/g;
  let attrMatch: RegExpExecArray | null;

  while ((attrMatch = attrRegex.exec(line)) !== null) {
    const [, key, value] = attrMatch;
    if (key === "key" || key === "label" || key === "description") {
      result[key as keyof OptionDef] = value;
    }
  }

  // Validate required attributes
  if (!result.key || !result.label) {
    return null; // Malformed, leave raw
  }

  return {
    key: result.key,
    label: result.label,
    description: result.description,
  };
}
