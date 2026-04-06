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
  last_user_message?: string | null;
}

export interface Message {
  id: number;
  role: "user" | "assistant";
  content: string;
  timestamp: string | null;
  sequence: number;
  message_type?: string;
}

export interface SessionDetail extends SessionSummary {
  messages: Message[];
  workspace: Workspace;
  tags?: Tag[];
}

export interface SearchMatch {
  role: "user" | "assistant";
  snippet: string;
  timestamp: string;
  sequence: number;
  message_type?: string;
  context?: string | null;
  context_role?: "user" | "assistant" | null;
  preview?: string | null;
  tool_content?: string | null;
}

export interface SearchResult extends SessionSummary {
  match_count: number;
  matches: SearchMatch[];
  match_source?: 'content' | 'files';
  matched_files?: string[];
  workspace_name?: string;
  workspace_path?: string;
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

export interface SavedSearch {
  id: number;
  tag_id: number;
  query_text: string;
  last_run_at: string | null;
  last_run_count: number | null;
  created_at: string;
  tag_name?: string;
  tag_color?: string;
}

export interface ChatHistoryEntry {
  id: number;
  query_text: string;
  answer_text: string | null;
  session_ids: string | null;
  session_count: number;
  queries: string | null;
  created_at: string;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  result?: ChatResult;
  queries?: string[];
}

export interface ChatResult {
  session_ids: string[];
  action?: {
    type: string;
    tag_name?: string;
    tag_color?: string;
    tag_id?: number;
  };
  explanation?: string;
  queries?: string[];
}

export interface Insight {
  id: number;
  session_id: string;
  type: 'correction' | 'decision' | 'pattern' | 'discovery' | 'gotcha' | 'preference';
  content: string;
  canonical_form: string | null;
  canonical_hash: string | null;
  context: string | null;
  entities: string[] | null;
  source: 'parent' | 'subagent';
  observation_count: number;
  score: number;
  upvotes: number;
  downvotes: number;
  extracted_at: string;
  last_observed_at: string;
  session_title: string | null;
  workspace_name: string;
  files: string[];
}

export interface InsightStats {
  total: number;
  type_distribution: Array<{ type: string; count: number }>;
  top_files: Array<{ file_path: string; insight_count: number }>;
  extraction_coverage: { total_sessions: number; extracted_sessions: number };
}

export interface InsightDetail extends Insight {
  sessions: Array<{
    session_id: string;
    extracted_at: string;
    title: string | null;
    started_at: string;
  }>;
}
