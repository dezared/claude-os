// Lines the server writes in English inside text a person also sees: shown in the UI language here.
// No imports, so the server tests can check them against what the server writes.

// server/chat/files.ts names a non-image attachment in the message text Claude reads. Older history has the Russian line.
const ATTACHED_FILE = /^(?:Attached file|Приложен файл): (.+)$/gm; // shippable-allow: chat history compatibility

export const localizeAttachedFiles = (text: string, label: (path: string) => string) => text.replace(ATTACHED_FILE, (_m, path: string) => label(path));

// server/chat/diff.ts ends a cut permission diff with this line; a real diff line never starts with "...".
const TRUNCATED = /^\.\.\. truncated, (\d+) more lines$/;

export const truncatedLines = (line: string): number | null => {
  const m = TRUNCATED.exec(line);
  return m ? Number(m[1]) : null;
};
