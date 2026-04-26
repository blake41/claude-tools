export type LibraryType = "skill" | "agent" | "command" | "rule" | "claude-md" | "hook";

export type LibraryScope =
  | { kind: "global" }
  | { kind: "plugin"; name: string }
  | { kind: "project"; workspacePath: string; workspaceName: string };

export interface ThinWrapper {
  // What the command delegates to. Skills are the only known target type today,
  // but this leaves room for command-to-command delegation.
  targetType: "skill";
  targetName: string;
  // Resolved id of the target artifact, if it exists in the library. Set after
  // the full scan completes so cross-references can be looked up.
  targetId: string | null;
  match: string;
}

export interface LibraryArtifact {
  id: string;
  type: LibraryType;
  scope: LibraryScope;
  name: string;
  namespace: string | null;
  displayName: string;
  sourcePath: string;
  description: string | null;
  created: string;
  inspiration: string | null;
  frontmatter: Record<string, unknown>;
  body: string;
  thinWrapper: ThinWrapper | null;
  parseError?: string;
}

export function encodeArtifactId(type: LibraryType, scope: LibraryScope, name: string): string {
  let scopeKey: string;
  if (scope.kind === "global") scopeKey = "global";
  else if (scope.kind === "plugin") scopeKey = `plugin:${scope.name}`;
  else scopeKey = `project:${scope.workspacePath}`;
  return `${type}::${scopeKey}::${name}`;
}
