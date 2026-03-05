export interface Tag {
  id: number;
  name: string;
  color: string;
  description: string | null;
  session_count?: number;
}

export interface Workspace {
  id: number;
  path: string;
  dir_name: string;
  display_name: string;
  session_count: number;
  last_activity: string | null;
}

export interface ChangedFile {
  file_path: string;
  file_name: string;
  operation: 'write' | 'edit';
}

export interface SessionSummary {
  id: string;
  workspace_id: number;
  started_at: string;
  ended_at: string | null;
  git_branch: string | null;
  title: string | null;
  message_count: number;
  user_message_count: number;
  summary: string | null;
  tags?: Tag[];
  files_changed?: ChangedFile[];
}

export interface Message {
  id: number;
  role: "user" | "assistant";
  content: string;
  timestamp: string | null;
  sequence: number;
}

export interface SessionDetail extends SessionSummary {
  messages: Message[];
  workspace: Workspace;
  tags?: Tag[];
}

export interface SearchResult {
  session_id: string;
  session_title: string | null;
  started_at: string;
  matches: Array<{
    message_id: number;
    role: "user" | "assistant";
    snippet: string;
    sequence: number;
  }>;
}

export interface FileReference {
  file_path: string;
  file_name: string;
  operation: 'write' | 'edit' | 'read';
  session_count?: number;
  last_seen?: string;
}

export interface FileSearchResult {
  file_path: string;
  file_name: string;
  operation: string;
  session_count: number;
  last_seen: string;
}
