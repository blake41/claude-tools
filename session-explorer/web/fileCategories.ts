export interface FileCategories {
  docs: string[];
  viz: string[];
  code: string[];
}

const DOC_EXTS = new Set([".md", ".mdx", ".txt", ".rst"]);
const VIZ_EXTS = new Set([".html", ".htm", ".svg"]);

export function categorizeFiles(files: Array<{ file_path: string }>): FileCategories {
  const result: FileCategories = { docs: [], viz: [], code: [] };

  for (const f of files) {
    const ext = f.file_path.slice(f.file_path.lastIndexOf(".")).toLowerCase();
    if (DOC_EXTS.has(ext)) {
      result.docs.push(f.file_path);
    } else if (VIZ_EXTS.has(ext)) {
      result.viz.push(f.file_path);
    } else {
      result.code.push(f.file_path);
    }
  }

  return result;
}

export function categorizeFileRefs<T extends { file_path: string }>(files: T[]): {
  docs: T[];
  viz: T[];
  code: T[];
} {
  const result: { docs: T[]; viz: T[]; code: T[] } = { docs: [], viz: [], code: [] };

  for (const f of files) {
    const ext = f.file_path.slice(f.file_path.lastIndexOf(".")).toLowerCase();
    if (DOC_EXTS.has(ext)) {
      result.docs.push(f);
    } else if (VIZ_EXTS.has(ext)) {
      result.viz.push(f);
    } else {
      result.code.push(f);
    }
  }

  return result;
}
