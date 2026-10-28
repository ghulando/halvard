import { fileURLToPath } from 'node:url';

export const pluginRoot = fileURLToPath(new URL('../../', import.meta.url));

// The guard re-parses printed commands and rejects a backslash outside quotes,
// so text with an apostrophe goes in double quotes instead of '\''.
export const quote = (text: string) =>
  text.includes("'") ? '"' + text.replace(/["\\$`]/g, '\\$&') + '"' : "'" + text + "'";
