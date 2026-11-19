// Project files of a work tab: the tree, a file read for show and a spreadsheet.
export interface FileEntry {
  name: string;
  path: string; // relative to the folder the tree is listed from: the tab's cwd unless the panel moved
  dir: boolean;
  size: number | null;
}

/** The folder the files panel lists from: the tab's cwd, or a folder above or beside it the tab may read. */
export interface FileRoot {
  path: string; // absolute
  cwd: string; // the tab's cwd: the way back
  top: string; // the highest folder `path` may go up to; `path` itself when it cannot
  parent: string | null; // the folder above `path`; null at `top`
  crumbs: { name: string; path: string; reach: boolean }[]; // `~` or the drive first, then a folder each; `reach`: inside `top`
}

/** A path the tree lists relative to a folder, made absolute in that folder's separators: a native Windows path keeps `\`. */
export function inFolder(folder: string, rel: string): string {
  const sep = /^[A-Za-z]:\\|^\\\\/.test(folder) ? '\\' : '/';
  return `${folder.endsWith(sep) ? folder.slice(0, -1) : folder}${sep}${rel.split('/').join(sep)}`;
}

export interface ProjectFile {
  path: string;
  size: number;
  kind: 'text' | 'binary';
  text: string | null; // null: binary
  truncated: boolean; // only the beginning of a large file
  sha: string | null; // what a save has to name; null: this file cannot be edited in place
}

/** A spreadsheet read for show: every cell as the text it holds, rows and columns past the caps cut off. */
export interface ProjectSheet {
  sheets: { name: string; rows: string[][]; truncated: boolean }[];
}
