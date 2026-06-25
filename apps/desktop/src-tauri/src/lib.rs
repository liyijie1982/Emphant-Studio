use base64::{engine::general_purpose, Engine as _};
use chrono::Utc;
use futures_util::StreamExt;
use mailparse::MailHeaderMap;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::{
    collections::{HashMap, HashSet},
    env,
    ffi::OsStr,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager};
use thiserror::Error;
use tokio::{fs, io::AsyncWriteExt};
use walkdir::{DirEntry, WalkDir};

const APP_NAME: &str = "Emphant Studio";
const DATA_DIRECTORY: &str = "Emphant Studio";
const LEGACY_DATA_DIRECTORY: &str = ".emphant";
const NOTES_DIRECTORY: &str = "notes";
const KNOWLEDGE_DIRECTORY: &str = "knowledge";
const TODOS_DIRECTORY: &str = "todos";
const GENERATED_DIRECTORY: &str = "emphant-generated";
const WORKSPACE_DATABASE: &str = "workspace.db";
const MAX_DOCUMENT_SIZE: usize = 25 * 1024 * 1024;
const MAX_EXTRACTED_LENGTH: usize = 500_000;

#[derive(Debug, Error)]
enum CommandError {
    #[error("{0}")]
    Message(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    Keyring(#[from] keyring::Error),
    #[error(transparent)]
    Http(#[from] reqwest::Error),
    #[error(transparent)]
    Sqlite(#[from] rusqlite::Error),
    #[error(transparent)]
    Walkdir(#[from] walkdir::Error),
}

impl serde::Serialize for CommandError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

type CommandResult<T> = Result<T, CommandError>;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceScanPayload {
    query: String,
    limit: Option<usize>,
}

#[derive(Debug, Deserialize)]
struct PathPayload {
    path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceDirectoryPayload {
    workspace_directory: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceSavePayload {
    workspace_directory: Option<String>,
    snapshot: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SelectDirectoryPayload {
    default_path: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SkillImportRequest {
    source: String,
    kind: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SkillManifest {
    id: Option<String>,
    name: Option<String>,
    description: Option<String>,
    kind: Option<String>,
    instructions: Option<String>,
    tags: Option<Vec<String>>,
    version: Option<String>,
    source: Option<String>,
    triggers: Option<Vec<String>>,
    required_tool_ids: Option<Vec<String>>,
    permissions: Option<Vec<String>>,
    code: Option<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DocumentExtractionRequest {
    name: String,
    mime_type: String,
    bytes: Vec<u8>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct KnowledgeSourceSaveRequest {
    workspace_directory: String,
    knowledge_base_id: String,
    knowledge_base_name: Option<String>,
    file_id: String,
    file_name: String,
    bytes: Vec<u8>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct KnowledgeSourceReadRequest {
    workspace_directory: String,
    relative_path: String,
}

#[derive(Debug, Deserialize)]
struct CredentialSetRequest {
    scope: String,
    id: String,
    secret: String,
}

#[derive(Debug, Deserialize)]
struct CredentialStatusRequest {
    scope: String,
    id: String,
}

#[derive(Debug, Deserialize)]
struct AgentRunIdPayload {
    #[serde(rename = "runId")]
    run_id: String,
}

#[derive(Debug, Serialize)]
struct WorkspaceFileMatch {
    path: String,
    size: u64,
}

fn default_workspace_directory() -> CommandResult<PathBuf> {
    let documents = dirs::document_dir()
        .or_else(dirs::home_dir)
        .ok_or_else(|| CommandError::Message("无法定位用户文档目录。".into()))?;
    Ok(documents.join("Emphant Studio Workspace"))
}

fn app_data_directory(app: &AppHandle) -> CommandResult<PathBuf> {
    app.path()
        .app_data_dir()
        .map_err(|error| CommandError::Message(error.to_string()))
}

fn resolve_workspace_directory(input: Option<String>) -> CommandResult<PathBuf> {
    Ok(match input {
        Some(path) if !path.trim().is_empty() => PathBuf::from(path),
        _ => default_workspace_directory()?,
    })
}

fn ensure_inside(root: &Path, target: &Path) -> CommandResult<PathBuf> {
    let root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    let target = if target.exists() {
        target.canonicalize()?
    } else {
        target.to_path_buf()
    };
    if target == root || target.starts_with(&root) {
        Ok(target)
    } else {
        Err(CommandError::Message("资源必须位于当前工作区内。".into()))
    }
}

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn now_millis_string() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .to_string()
}

fn value_str<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|text| !text.trim().is_empty())
}

fn safe_name(value: &str) -> String {
    let mut result = value
        .chars()
        .filter(|ch| !ch.is_control())
        .map(|ch| {
            if matches!(ch, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') {
                '_'
            } else {
                ch
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    result.truncate(80);
    if result.trim().is_empty() {
        "untitled".into()
    } else {
        result.trim().into()
    }
}

fn safe_relative_path(value: &str) -> Option<PathBuf> {
    let trimmed = value
        .trim()
        .trim_matches('`')
        .trim_matches('"')
        .trim_matches('\'');
    if trimmed.is_empty() {
        return None;
    }
    let path = PathBuf::from(trimmed);
    if path.is_absolute() {
        return None;
    }
    if path
        .components()
        .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return None;
    }
    Some(path)
}

fn generated_file_name(index: usize, language: &str) -> String {
    let extension = match language.trim().to_ascii_lowercase().as_str() {
        "ts" | "typescript" => "ts",
        "tsx" => "tsx",
        "js" | "javascript" => "js",
        "jsx" => "jsx",
        "py" | "python" => "py",
        "rs" | "rust" => "rs",
        "go" => "go",
        "java" => "java",
        "kt" | "kotlin" => "kt",
        "swift" => "swift",
        "html" => "html",
        "css" => "css",
        "json" => "json",
        "yaml" | "yml" => "yaml",
        "toml" => "toml",
        "sql" => "sql",
        "sh" | "shell" | "bash" => "sh",
        "md" | "markdown" => "md",
        _ => "txt",
    };
    format!("generated-{index:03}.{extension}")
}

fn path_from_fence_info(info: &str) -> Option<PathBuf> {
    let info = info.trim();
    for token in info.split_whitespace() {
        let lower = token.to_ascii_lowercase();
        for prefix in ["path=", "file=", "filename=", "filepath="] {
            if let Some(value) = lower.strip_prefix(prefix) {
                let original = &token[token.len() - value.len()..];
                return safe_relative_path(original);
            }
        }
        if token.contains('/') || token.contains('\\') || Path::new(token).extension().is_some() {
            if let Some(path) = safe_relative_path(token) {
                return Some(path);
            }
        }
    }

    for marker in ["file:", "path:", "filename:", "filepath:"] {
        if let Some(index) = info.to_ascii_lowercase().find(marker) {
            let value = info[index + marker.len()..].trim();
            if let Some(first) = value.split_whitespace().next() {
                return safe_relative_path(first);
            }
        }
    }
    None
}

fn strip_content_path_marker(content: &str) -> (Option<PathBuf>, String) {
    let mut lines = content.lines();
    let Some(first_line) = lines.next() else {
        return (None, String::new());
    };
    let marker_line = first_line
        .trim()
        .trim_start_matches("//")
        .trim_start_matches("#")
        .trim_start_matches("<!--")
        .trim_end_matches("-->")
        .trim();
    let lower = marker_line.to_ascii_lowercase();
    for marker in ["file:", "path:", "filename:", "filepath:"] {
        if let Some(value) = lower.strip_prefix(marker) {
            let original = &marker_line[marker_line.len() - value.len()..];
            if let Some(path) = safe_relative_path(original.trim()) {
                return (Some(path), lines.collect::<Vec<_>>().join("\n"));
            }
        }
    }
    (None, content.to_string())
}

fn should_autosave_generated_content(prompt: &str, answer: &str) -> bool {
    let text = format!("{}\n{}", prompt, answer).to_ascii_lowercase();
    [
        "生成",
        "创建",
        "写一个",
        "代码",
        "文件",
        "文档",
        "报告",
        "落盘",
        "保存",
        "generate",
        "create",
        "write",
        "file",
        "code",
        "document",
        "report",
        "save",
    ]
    .iter()
    .any(|needle| text.contains(needle))
}

fn extract_generated_files(prompt: &str, answer: &str) -> Vec<(PathBuf, String)> {
    let autosave = should_autosave_generated_content(prompt, answer);
    let mut files = Vec::new();
    let mut remaining = answer;

    while let Some(start) = remaining.find("```") {
        remaining = &remaining[start + 3..];
        let Some(info_end) = remaining.find('\n') else {
            break;
        };
        let info = remaining[..info_end].trim();
        remaining = &remaining[info_end + 1..];
        let Some(end) = remaining.find("```") else {
            break;
        };
        let raw_content = &remaining[..end];
        remaining = &remaining[end + 3..];

        let language = info.split_whitespace().next().unwrap_or("");
        let (content_path, content) = strip_content_path_marker(raw_content.trim_matches('\n'));
        let path = path_from_fence_info(info).or(content_path).or_else(|| {
            autosave.then(|| PathBuf::from(generated_file_name(files.len() + 1, language)))
        });

        if let Some(path) = path {
            if !content.trim().is_empty() {
                files.push((path, content));
            }
        }
    }

    if files.is_empty() && autosave && !answer.trim().is_empty() && !answer.contains("```") {
        files.push((PathBuf::from("response.md"), answer.trim().to_string()));
    }

    files
}

async fn save_generated_files(
    workspace: &Path,
    prompt: &str,
    answer: &str,
) -> CommandResult<Vec<String>> {
    let files = extract_generated_files(prompt, answer);
    if files.is_empty() {
        return Ok(Vec::new());
    }

    let output_root = workspace.join(GENERATED_DIRECTORY);
    fs::create_dir_all(&output_root).await?;
    let mut saved_paths = Vec::new();

    for (relative_path, content) in files {
        let target = ensure_inside(&output_root, &output_root.join(relative_path))?;
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).await?;
        }
        fs::write(&target, content).await?;
        saved_paths.push(target.to_string_lossy().to_string());
    }

    Ok(saved_paths)
}

fn skill_id_from_name(name: &str) -> String {
    let slug = safe_name(name)
        .to_lowercase()
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' })
        .collect::<String>()
        .split('-')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    format!(
        "skill-{}-{}",
        slug,
        uuid::Uuid::new_v4()
            .to_string()
            .chars()
            .take(8)
            .collect::<String>()
    )
}

fn base_directory_name(name: &str, id: &str) -> String {
    format!("{}--{}", safe_name(name), safe_name(id))
}

fn note_path(directory: &Path, note: &Value) -> PathBuf {
    directory.join(format!(
        "{}--{}.md",
        safe_name(value_str(note, "title").unwrap_or("untitled")),
        safe_name(value_str(note, "id").unwrap_or("unknown"))
    ))
}

fn source_path(directory: &Path, file: &Value) -> PathBuf {
    directory.join(format!(
        "{}--{}.md",
        safe_name(value_str(file, "name").unwrap_or("source")),
        safe_name(value_str(file, "id").unwrap_or("unknown"))
    ))
}

fn workspace_data_root(workspace_directory: &Path) -> PathBuf {
    workspace_directory.join(DATA_DIRECTORY)
}

fn workspace_db_path(root: &Path) -> PathBuf {
    root.join(WORKSPACE_DATABASE)
}

fn json_text(value: &Value) -> CommandResult<String> {
    Ok(serde_json::to_string(value)?)
}

fn value_i64(value: &Value, key: &str) -> Option<i64> {
    value.get(key).and_then(Value::as_i64).or_else(|| {
        value
            .get(key)
            .and_then(Value::as_u64)
            .and_then(|number| i64::try_from(number).ok())
    })
}

fn open_workspace_database(root: &Path) -> CommandResult<Connection> {
    std::fs::create_dir_all(root)?;
    let connection = Connection::open(workspace_db_path(root))?;
    connection.pragma_update(None, "journal_mode", "WAL")?;
    connection.pragma_update(None, "foreign_keys", "ON")?;
    connection.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS app_meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS workspace_files (
            path TEXT PRIMARY KEY,
            relative_path TEXT NOT NULL,
            name TEXT NOT NULL,
            extension TEXT NOT NULL,
            mime_type TEXT NOT NULL,
            size INTEGER NOT NULL,
            modified_at INTEGER NOT NULL,
            indexed_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS documents (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            mime_type TEXT NOT NULL,
            size INTEGER NOT NULL,
            uploaded_at TEXT,
            original_relative_path TEXT,
            extracted_by TEXT,
            extraction_warning TEXT,
            knowledge_status TEXT,
            knowledge_progress INTEGER,
            content_text TEXT,
            payload_json TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS knowledge_bases (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            status TEXT NOT NULL,
            chunk_count INTEGER NOT NULL,
            tags_json TEXT NOT NULL,
            indexed_content TEXT,
            graph_json TEXT,
            payload_json TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS knowledge_chunks (
            id TEXT PRIMARY KEY,
            knowledge_base_id TEXT NOT NULL,
            source_file_id TEXT,
            title TEXT,
            summary TEXT,
            token_count INTEGER NOT NULL,
            content TEXT NOT NULL,
            keywords_json TEXT NOT NULL,
            entity_ids_json TEXT NOT NULL,
            payload_json TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY (knowledge_base_id) REFERENCES knowledge_bases(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS todo_items (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            task_group TEXT NOT NULL,
            status TEXT NOT NULL,
            scheduled_at TEXT,
            created_at TEXT,
            updated_at TEXT,
            completed_at TEXT,
            payload_json TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS topics (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            title_mode TEXT,
            workspace_directory TEXT,
            source_mail_id TEXT,
            source_todo_id TEXT,
            payload_json TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS messages (
            id TEXT PRIMARY KEY,
            topic_id TEXT NOT NULL,
            role TEXT NOT NULL,
            created_at TEXT NOT NULL,
            status TEXT NOT NULL,
            assistant_name TEXT,
            blocks_json TEXT NOT NULL,
            payload_json TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_workspace_files_name ON workspace_files(name);
        CREATE INDEX IF NOT EXISTS idx_documents_name ON documents(name);
        CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_base ON knowledge_chunks(knowledge_base_id);
        CREATE INDEX IF NOT EXISTS idx_todo_items_status ON todo_items(status);
        CREATE INDEX IF NOT EXISTS idx_messages_topic ON messages(topic_id);
        "#,
    )?;
    Ok(connection)
}

async fn init_workspace_database(root: &Path) -> CommandResult<()> {
    let root = root.to_path_buf();
    tokio::task::spawn_blocking(move || -> CommandResult<()> {
        let connection = open_workspace_database(&root)?;
        connection.execute(
            "INSERT OR REPLACE INTO app_meta (key, value, updated_at) VALUES (?1, ?2, ?3)",
            params!["schema_version", "1", now_iso()],
        )?;
        Ok(())
    })
    .await
    .map_err(|error| CommandError::Message(error.to_string()))?
}

fn is_indexable_entry(entry: &DirEntry) -> bool {
    let name = entry.file_name().to_string_lossy();
    if name.starts_with('.') || name == "node_modules" || name == "target" || name == DATA_DIRECTORY
    {
        return false;
    }
    true
}

fn scan_workspace_with_walkdir(
    root: &Path,
    query: &str,
    limit: usize,
) -> CommandResult<Vec<WorkspaceFileMatch>> {
    let query = query.to_lowercase();
    let mut results = Vec::new();
    for entry in WalkDir::new(root)
        .max_depth(4)
        .into_iter()
        .filter_entry(is_indexable_entry)
    {
        let entry = entry?;
        if results.len() >= limit {
            break;
        }
        if !entry.file_type().is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy();
        if !name.to_lowercase().contains(&query) {
            continue;
        }
        let metadata = entry.metadata()?;
        results.push(WorkspaceFileMatch {
            path: entry.path().to_string_lossy().to_string(),
            size: metadata.len(),
        });
    }
    Ok(results)
}

async fn index_workspace_files(root: &Path, scan_root: &Path) -> CommandResult<()> {
    let root = root.to_path_buf();
    let scan_root = scan_root.to_path_buf();
    tokio::task::spawn_blocking(move || -> CommandResult<()> {
        let mut connection = open_workspace_database(&root)?;
        let transaction = connection.transaction()?;
        let indexed_at = now_iso();
        for entry in WalkDir::new(&scan_root)
            .max_depth(6)
            .into_iter()
            .filter_entry(is_indexable_entry)
        {
            let entry = entry?;
            if !entry.file_type().is_file() {
                continue;
            }
            let metadata = entry.metadata()?;
            let path = entry.path();
            let relative_path = path
                .strip_prefix(&scan_root)
                .unwrap_or(path)
                .to_string_lossy()
                .to_string();
            let name = path
                .file_name()
                .and_then(OsStr::to_str)
                .unwrap_or_default()
                .to_string();
            let extension = path
                .extension()
                .and_then(OsStr::to_str)
                .unwrap_or_default()
                .to_lowercase();
            let mime_type = mime_guess::from_path(path)
                .first_or_octet_stream()
                .essence_str()
                .to_string();
            let modified_at = metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map(|duration| duration.as_secs() as i64)
                .unwrap_or_default();
            transaction.execute(
                r#"
                INSERT OR REPLACE INTO workspace_files
                    (path, relative_path, name, extension, mime_type, size, modified_at, indexed_at)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                "#,
                params![
                    path.to_string_lossy().to_string(),
                    relative_path,
                    name,
                    extension,
                    mime_type,
                    metadata.len() as i64,
                    modified_at,
                    indexed_at
                ],
            )?;
        }
        transaction.commit()?;
        Ok(())
    })
    .await
    .map_err(|error| CommandError::Message(error.to_string()))?
}

async fn sync_snapshot_to_database(root: &Path, snapshot: &Value) -> CommandResult<()> {
    let root = root.to_path_buf();
    let snapshot = snapshot.clone();
    tokio::task::spawn_blocking(move || -> CommandResult<()> {
        let mut connection = open_workspace_database(&root)?;
        let transaction = connection.transaction()?;
        let updated_at = now_iso();

        transaction.execute("DELETE FROM knowledge_chunks", [])?;
        transaction.execute("DELETE FROM knowledge_bases", [])?;
        transaction.execute("DELETE FROM documents", [])?;
        transaction.execute("DELETE FROM todo_items", [])?;
        transaction.execute("DELETE FROM topics", [])?;
        transaction.execute("DELETE FROM messages", [])?;

        for file in snapshot
            .get("files")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let id = value_str(file, "id").unwrap_or("");
            if id.is_empty() {
                continue;
            }
            transaction.execute(
                r#"
                INSERT OR REPLACE INTO documents
                    (id, name, mime_type, size, uploaded_at, original_relative_path, extracted_by,
                     extraction_warning, knowledge_status, knowledge_progress, content_text,
                     payload_json, updated_at)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
                "#,
                params![
                    id,
                    value_str(file, "name").unwrap_or(""),
                    value_str(file, "mimeType").unwrap_or("application/octet-stream"),
                    value_i64(file, "size").unwrap_or_default(),
                    value_str(file, "uploadedAt"),
                    value_str(file, "originalRelativePath"),
                    value_str(file, "extractedBy"),
                    value_str(file, "extractionWarning"),
                    value_str(file, "knowledgeStatus"),
                    value_i64(file, "knowledgeProgress"),
                    value_str(file, "contentText"),
                    json_text(file)?,
                    updated_at
                ],
            )?;
        }

        for base in snapshot
            .get("knowledgeBases")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let base_id = value_str(base, "id").unwrap_or("");
            if base_id.is_empty() {
                continue;
            }
            transaction.execute(
                r#"
                INSERT OR REPLACE INTO knowledge_bases
                    (id, name, status, chunk_count, tags_json, indexed_content, graph_json,
                     payload_json, updated_at)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                "#,
                params![
                    base_id,
                    value_str(base, "name").unwrap_or(""),
                    value_str(base, "status").unwrap_or("ready"),
                    value_i64(base, "chunkCount").unwrap_or_default(),
                    json_text(base.get("tags").unwrap_or(&json!([])))?,
                    value_str(base, "indexedContent"),
                    base.get("graph").map(json_text).transpose()?,
                    json_text(base)?,
                    updated_at
                ],
            )?;

            for chunk in base
                .get("chunks")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                let chunk_id = value_str(chunk, "id").unwrap_or("");
                if chunk_id.is_empty() {
                    continue;
                }
                transaction.execute(
                    r#"
                    INSERT OR REPLACE INTO knowledge_chunks
                        (id, knowledge_base_id, source_file_id, title, summary, token_count,
                         content, keywords_json, entity_ids_json, payload_json, updated_at)
                    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
                    "#,
                    params![
                        chunk_id,
                        base_id,
                        value_str(chunk, "sourceFileId"),
                        value_str(chunk, "title"),
                        value_str(chunk, "summary"),
                        value_i64(chunk, "tokenCount").unwrap_or_default(),
                        value_str(chunk, "content").unwrap_or(""),
                        json_text(chunk.get("keywords").unwrap_or(&json!([])))?,
                        json_text(chunk.get("entityIds").unwrap_or(&json!([])))?,
                        json_text(chunk)?,
                        updated_at
                    ],
                )?;
            }
        }

        for todo in snapshot
            .get("todoItems")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let id = value_str(todo, "id").unwrap_or("");
            if id.is_empty() {
                continue;
            }
            transaction.execute(
                r#"
                INSERT OR REPLACE INTO todo_items
                    (id, title, task_group, status, scheduled_at, created_at, updated_at,
                     completed_at, payload_json)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                "#,
                params![
                    id,
                    value_str(todo, "title").unwrap_or(""),
                    value_str(todo, "taskGroup").unwrap_or(""),
                    value_str(todo, "status").unwrap_or("pending"),
                    value_str(todo, "scheduledAt"),
                    value_str(todo, "createdAt"),
                    value_str(todo, "updatedAt"),
                    value_str(todo, "completedAt"),
                    json_text(todo)?
                ],
            )?;
        }

        for topic in snapshot
            .get("topics")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let id = value_str(topic, "id").unwrap_or("");
            if id.is_empty() {
                continue;
            }
            transaction.execute(
                r#"
                INSERT OR REPLACE INTO topics
                    (id, title, updated_at, title_mode, workspace_directory, source_mail_id,
                     source_todo_id, payload_json)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                "#,
                params![
                    id,
                    value_str(topic, "title").unwrap_or(""),
                    value_str(topic, "updatedAt").unwrap_or(&updated_at),
                    value_str(topic, "titleMode"),
                    value_str(topic, "workspaceDirectory"),
                    value_str(topic, "sourceMailId"),
                    value_str(topic, "sourceTodoId"),
                    json_text(topic)?
                ],
            )?;
        }

        for message in snapshot
            .get("messages")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let id = value_str(message, "id").unwrap_or("");
            if id.is_empty() {
                continue;
            }
            transaction.execute(
                r#"
                INSERT OR REPLACE INTO messages
                    (id, topic_id, role, created_at, status, assistant_name, blocks_json, payload_json)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                "#,
                params![
                    id,
                    value_str(message, "topicId").unwrap_or(""),
                    value_str(message, "role").unwrap_or("user"),
                    value_str(message, "createdAt").unwrap_or(&updated_at),
                    value_str(message, "status").unwrap_or("done"),
                    value_str(message, "assistantName"),
                    json_text(message.get("blocks").unwrap_or(&json!([])))?,
                    json_text(message)?
                ],
            )?;
        }

        transaction.commit()?;
        Ok(())
    })
    .await
    .map_err(|error| CommandError::Message(error.to_string()))?
}

async fn write_json(path: &Path, value: &Value) -> CommandResult<()> {
    let temporary_path = path.with_extension("json.tmp");
    fs::write(
        &temporary_path,
        format!("{}\n", serde_json::to_string_pretty(value)?),
    )
    .await?;
    fs::rename(temporary_path, path).await?;
    Ok(())
}

fn is_text_extension(extension: &str) -> bool {
    matches!(
        extension,
        "md" | "txt"
            | "json"
            | "csv"
            | "tsv"
            | "xml"
            | "html"
            | "htm"
            | "css"
            | "js"
            | "jsx"
            | "ts"
            | "tsx"
            | "yml"
            | "yaml"
            | "toml"
    )
}

fn can_markitdown(extension: &str) -> bool {
    is_text_extension(extension)
        || matches!(
            extension,
            "pdf" | "docx" | "pptx" | "xlsx" | "xls" | "epub" | "msg" | "zip"
        )
}

fn truncate_extracted(value: String) -> String {
    if value.len() > MAX_EXTRACTED_LENGTH {
        format!("{}\n\n...正文已截断", &value[..MAX_EXTRACTED_LENGTH])
    } else {
        value
    }
}

async fn run_markitdown(path: &Path) -> CommandResult<String> {
    let output = tokio::process::Command::new("markitdown")
        .arg(path)
        .output()
        .await;
    if let Ok(output) = output {
        if output.status.success() {
            return Ok(String::from_utf8_lossy(&output.stdout).trim().to_string());
        }
        return Err(CommandError::Message(
            String::from_utf8_lossy(&output.stderr).trim().to_string(),
        ));
    }

    let output = tokio::process::Command::new("uvx")
        .args([
            "--from",
            "markitdown[pdf,docx,pptx,xlsx,xls,outlook]",
            "markitdown",
        ])
        .arg(path)
        .output()
        .await
        .map_err(|_| {
            CommandError::Message(
                "未找到 MarkItDown。请安装 `pip install 'markitdown[pdf,docx,pptx,xlsx,xls,outlook]'`，或安装 uv 后重试。".into(),
            )
        })?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        Err(CommandError::Message(
            String::from_utf8_lossy(&output.stderr).trim().to_string(),
        ))
    }
}

async fn extract_local_document(path: &Path) -> CommandResult<Value> {
    let metadata = fs::metadata(path).await?;
    if !metadata.is_file() {
        return Err(CommandError::Message("只能提取本地文件。".into()));
    }
    if metadata.len() as usize > MAX_DOCUMENT_SIZE {
        return Err(CommandError::Message("文档不能超过 25 MB。".into()));
    }

    let extension = path
        .extension()
        .and_then(OsStr::to_str)
        .unwrap_or("")
        .to_lowercase();
    if !can_markitdown(&extension) {
        return Ok(json!({ "warning": "当前文件格式暂不支持正文提取。" }));
    }
    if is_text_extension(&extension) {
        return Ok(json!({
            "contentText": truncate_extracted(fs::read_to_string(path).await?),
            "extractedBy": "native"
        }));
    }

    match run_markitdown(path).await {
        Ok(text) if !text.trim().is_empty() => Ok(json!({
            "contentText": truncate_extracted(text),
            "extractedBy": "markitdown"
        })),
        Ok(_) => Ok(json!({ "warning": "MarkItDown 未从文档中提取到文本。" })),
        Err(error) => Ok(json!({ "warning": error.to_string() })),
    }
}

async fn extract_uploaded_document(request: &DocumentExtractionRequest) -> CommandResult<Value> {
    if request.bytes.len() > MAX_DOCUMENT_SIZE {
        return Err(CommandError::Message("文档不能超过 25 MB。".into()));
    }
    let extension = Path::new(&request.name)
        .extension()
        .and_then(OsStr::to_str)
        .unwrap_or("")
        .to_lowercase();
    if request.mime_type.starts_with("image/") {
        return Ok(json!({
            "contentText": format!("图片文件：{}\n类型：{}\n该图片的原始文件已保存在知识库中，可用于预览和后续多模态处理。", request.name, request.mime_type),
            "extractedBy": "native"
        }));
    }
    if !can_markitdown(&extension) {
        return Ok(json!({ "warning": "当前文件格式暂不支持正文提取。" }));
    }

    let temporary_dir = env::temp_dir().join(format!("emphant-document-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&temporary_dir).await?;
    let safe_file = safe_name(
        Path::new(&request.name)
            .file_name()
            .and_then(OsStr::to_str)
            .unwrap_or("document"),
    );
    let temporary_path = temporary_dir.join(safe_file);
    fs::write(&temporary_path, &request.bytes).await?;
    let result = extract_local_document(&temporary_path).await;
    let _ = fs::remove_dir_all(&temporary_dir).await;
    result
}

fn github_clone_url(source: &str) -> String {
    let trimmed = source.trim().trim_end_matches(".git");
    if trimmed.starts_with("http://")
        || trimmed.starts_with("https://")
        || trimmed.starts_with("git@")
    {
        format!("{}.git", trimmed)
    } else {
        format!("https://github.com/{}.git", trimmed.trim_matches('/'))
    }
}

fn github_repo_name(source: &str) -> String {
    source
        .trim()
        .trim_end_matches(".git")
        .trim_end_matches('/')
        .rsplit(['/', ':'])
        .next()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("skill-repo")
        .to_string()
}

async fn clone_skill_repo(app: &AppHandle, source: &str) -> CommandResult<PathBuf> {
    let imports_root = app_data_directory(app)?.join("imported-skills");
    fs::create_dir_all(&imports_root).await?;
    let repo_dir = imports_root.join(format!(
        "{}-{}",
        safe_name(&github_repo_name(source)),
        uuid::Uuid::new_v4()
            .to_string()
            .chars()
            .take(8)
            .collect::<String>()
    ));
    let output = tokio::process::Command::new("git")
        .args(["clone", "--depth", "1", &github_clone_url(source)])
        .arg(&repo_dir)
        .output()
        .await
        .map_err(|error| CommandError::Message(format!("无法执行 git clone：{}", error)))?;
    if !output.status.success() {
        return Err(CommandError::Message(format!(
            "GitHub Skill 导入失败：{}",
            String::from_utf8_lossy(&output.stderr).trim()
        )));
    }
    Ok(repo_dir)
}

fn first_existing_skill_markdown(root: &Path) -> Option<PathBuf> {
    ["SKILL.md", "skill.md", "README.md", "readme.md"]
        .iter()
        .map(|name| root.join(name))
        .find(|path| path.exists())
}

fn infer_code_skill(root: &Path) -> Option<Value> {
    let candidates = [
        ("node", "package.json", "npm start"),
        ("python", "main.py", "python main.py"),
        ("python", "skill.py", "python skill.py"),
        ("rust", "Cargo.toml", "cargo run"),
        ("shell", "run.sh", "sh run.sh"),
    ];
    candidates
        .iter()
        .find_map(|(runtime, entrypoint, command)| {
            root.join(entrypoint).exists().then(|| {
                json!({
                    "runtime": runtime,
                    "entrypoint": entrypoint,
                    "command": command,
                    "localPath": root.to_string_lossy()
                })
            })
        })
}

fn manifest_to_skill(
    root: &Path,
    manifest: SkillManifest,
    fallback_source: &str,
) -> CommandResult<Value> {
    let name = manifest.name.unwrap_or_else(|| {
        root.file_name()
            .and_then(OsStr::to_str)
            .unwrap_or("Imported Skill")
            .to_string()
    });
    let code = manifest.code.or_else(|| infer_code_skill(root));
    let kind = manifest.kind.unwrap_or_else(|| {
        if code.is_some() {
            "code".into()
        } else {
            "prompt".into()
        }
    });
    let instructions = manifest.instructions.unwrap_or_else(|| {
        first_existing_skill_markdown(root)
            .and_then(|path| std::fs::read_to_string(path).ok())
            .unwrap_or_default()
    });
    Ok(json!({
        "id": manifest.id.unwrap_or_else(|| skill_id_from_name(&name)),
        "name": name,
        "description": manifest.description.unwrap_or_default(),
        "kind": if kind == "code" { "code" } else { "prompt" },
        "instructions": instructions,
        "tags": manifest.tags.unwrap_or_default(),
        "enabled": true,
        "version": manifest.version.unwrap_or_else(|| "1.0.0".into()),
        "source": manifest.source.unwrap_or_else(|| fallback_source.into()),
        "importUrl": fallback_source,
        "localPath": root.to_string_lossy(),
        "code": code.unwrap_or(Value::Null),
        "requiredToolIds": manifest.required_tool_ids.unwrap_or_default(),
        "permissions": manifest.permissions.unwrap_or_default(),
        "triggers": manifest.triggers.unwrap_or_default()
    }))
}

fn parse_skill_directory(root: &Path, source: &str) -> CommandResult<Vec<Value>> {
    let manifest_path = root.join("skill.json");
    if manifest_path.exists() {
        let manifest: SkillManifest =
            serde_json::from_str(&std::fs::read_to_string(&manifest_path)?)?;
        return Ok(vec![manifest_to_skill(root, manifest, source)?]);
    }

    let mut nested_skills = Vec::new();
    for entry in std::fs::read_dir(root)? {
        let entry = entry?;
        let path = entry.path();
        let hidden = path
            .file_name()
            .and_then(OsStr::to_str)
            .is_some_and(|name| name.starts_with('.'));
        if !path.is_dir() || hidden {
            continue;
        }
        let has_skill_files =
            path.join("skill.json").exists() || first_existing_skill_markdown(&path).is_some();
        if has_skill_files {
            nested_skills.extend(parse_skill_directory(&path, source)?);
        }
    }
    if !nested_skills.is_empty() {
        return Ok(nested_skills);
    }

    let markdown = first_existing_skill_markdown(root).ok_or_else(|| {
        CommandError::Message("未找到 skill.json、SKILL.md 或 README.md。".into())
    })?;
    let markdown_text = std::fs::read_to_string(markdown)?;
    let name = root
        .file_name()
        .and_then(OsStr::to_str)
        .unwrap_or("Imported Skill")
        .to_string();
    let code = infer_code_skill(root);
    Ok(vec![json!({
        "id": skill_id_from_name(&name),
        "name": name,
        "description": markdown_text.lines().find(|line| !line.trim().is_empty()).unwrap_or("").chars().take(160).collect::<String>(),
        "kind": if code.is_some() { "code" } else { "prompt" },
        "instructions": markdown_text,
        "tags": [],
        "enabled": true,
        "version": "1.0.0",
        "source": source,
        "importUrl": source,
        "localPath": root.to_string_lossy(),
        "code": code.unwrap_or(Value::Null),
        "requiredToolIds": [],
        "permissions": [],
        "triggers": []
    })])
}

fn credential_key(scope: &str, id: &str) -> String {
    format!("{}:{}", scope.trim(), id.trim())
}

fn get_credential(scope: &str, id: &str) -> CommandResult<Option<String>> {
    let entry = keyring::Entry::new(APP_NAME, &credential_key(scope, id))?;
    match entry.get_password() {
        Ok(value) if !value.is_empty() => Ok(Some(value)),
        Ok(_) | Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(error.into()),
    }
}

async fn load_from_root(root: &Path) -> CommandResult<Option<Value>> {
    let notes_index_path = root.join(NOTES_DIRECTORY).join("index.json");
    if fs::metadata(&notes_index_path).await.is_err() {
        return Ok(None);
    }

    let mut system_notes: Vec<Value> =
        serde_json::from_str(&fs::read_to_string(&notes_index_path).await?)?;
    for note in &mut system_notes {
        let primary_note_path = note_path(&root.join(NOTES_DIRECTORY), note);
        let fallback_note_path = root.join(NOTES_DIRECTORY).join(format!(
            "{}.md",
            safe_name(value_str(note, "id").unwrap_or("unknown"))
        ));
        let content = match fs::read_to_string(primary_note_path).await {
            Ok(content) => content,
            Err(_) => fs::read_to_string(fallback_note_path)
                .await
                .unwrap_or_default(),
        };
        if let Some(object) = note.as_object_mut() {
            object.insert("content".into(), Value::String(content));
        }
    }

    let todo_items: Value = fs::read_to_string(root.join(TODOS_DIRECTORY).join("index.json"))
        .await
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_else(|| json!([]));
    let todo_groups: Value = fs::read_to_string(root.join(TODOS_DIRECTORY).join("groups.json"))
        .await
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_else(|| json!([]));

    let mut knowledge_bases = Vec::new();
    let mut files = Vec::new();
    let knowledge_root = root.join(KNOWLEDGE_DIRECTORY);
    if let Ok(mut entries) = fs::read_dir(&knowledge_root).await {
        while let Some(entry) = entries.next_entry().await? {
            if !entry.metadata().await?.is_dir() {
                continue;
            }
            let base_root = entry.path();
            let metadata_text = match fs::read_to_string(base_root.join("metadata.json")).await {
                Ok(text) => text,
                Err(_) => continue,
            };
            let metadata: Value = serde_json::from_str(&metadata_text)?;
            if let Some(base) = metadata.get("base") {
                knowledge_bases.push(base.clone());
            }
            for file in metadata
                .get("files")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
            {
                let mut file = file;
                let primary_source_path = source_path(&base_root.join("sources"), &file);
                let fallback_source_path = base_root.join("sources").join(format!(
                    "{}.md",
                    safe_name(value_str(&file, "id").unwrap_or("unknown"))
                ));
                let content_text = match fs::read_to_string(primary_source_path).await {
                    Ok(content) => Some(content),
                    Err(_) => fs::read_to_string(fallback_source_path).await.ok(),
                }
                .or_else(|| value_str(&file, "contentText").map(ToOwned::to_owned));
                let mime_type = value_str(&file, "mimeType")
                    .unwrap_or("application/octet-stream")
                    .to_string();
                let original_relative_path =
                    value_str(&file, "originalRelativePath").map(ToOwned::to_owned);
                if let Some(object) = file.as_object_mut() {
                    if let Some(content_text) = content_text {
                        object.insert("contentText".into(), Value::String(content_text));
                    }
                    if mime_type.starts_with("image/") {
                        if let Some(relative_path) = original_relative_path {
                            if let Ok(bytes) = fs::read(root.join(relative_path)).await {
                                object.insert(
                                    "preview".into(),
                                    Value::String(format!(
                                        "data:{};base64,{}",
                                        mime_type,
                                        general_purpose::STANDARD.encode(bytes)
                                    )),
                                );
                            }
                        }
                    }
                }
                files.push(file);
            }
        }
    }

    Ok(Some(json!({
        "systemNotes": system_notes,
        "knowledgeBases": knowledge_bases,
        "files": files,
        "todoGroups": todo_groups,
        "todoItems": todo_items
    })))
}

async fn save_workspace_snapshot(
    workspace_directory: &Path,
    snapshot: &Value,
) -> CommandResult<()> {
    let root = workspace_directory.join(DATA_DIRECTORY);
    let notes_root = root.join(NOTES_DIRECTORY);
    let knowledge_root = root.join(KNOWLEDGE_DIRECTORY);
    let todos_root = root.join(TODOS_DIRECTORY);
    fs::create_dir_all(&notes_root).await?;
    fs::create_dir_all(&knowledge_root).await?;
    fs::create_dir_all(&todos_root).await?;

    let notes = snapshot
        .get("systemNotes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let note_index: Vec<Value> = notes
        .iter()
        .map(|note| {
            json!({
                "id": value_str(note, "id").unwrap_or(""),
                "title": value_str(note, "title").unwrap_or("未命名笔记"),
                "sourceMessageId": note.get("sourceMessageId").cloned().unwrap_or(Value::Null),
                "sourceTopicId": note.get("sourceTopicId").cloned().unwrap_or(Value::Null),
                "assistantName": note.get("assistantName").cloned().unwrap_or(Value::Null),
                "createdAt": note.get("createdAt").cloned().unwrap_or(Value::Null),
                "updatedAt": note.get("updatedAt").cloned().unwrap_or(Value::Null)
            })
        })
        .collect();
    write_json(&notes_root.join("index.json"), &Value::Array(note_index)).await?;
    let mut expected_notes = HashSet::from(["index.json".to_string()]);
    for note in notes {
        let path = note_path(&notes_root, &note);
        expected_notes.insert(
            path.file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string(),
        );
        fs::write(path, value_str(&note, "content").unwrap_or("")).await?;
    }
    prune_unexpected_files(&notes_root, &expected_notes).await?;

    write_json(
        &todos_root.join("index.json"),
        snapshot.get("todoItems").unwrap_or(&json!([])),
    )
    .await?;
    write_json(
        &todos_root.join("groups.json"),
        snapshot.get("todoGroups").unwrap_or(&json!([])),
    )
    .await?;

    let files_by_id: HashMap<String, Value> = snapshot
        .get("files")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|file| value_str(&file, "id").map(|id| (id.to_string(), file.clone())))
        .collect();
    let mut expected_bases = HashSet::new();
    for base in snapshot
        .get("knowledgeBases")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
    {
        let base_id = value_str(&base, "id").unwrap_or("unknown");
        let base_name = value_str(&base, "name").unwrap_or("知识库");
        let base_directory = base_directory_name(base_name, base_id);
        expected_bases.insert(base_directory.clone());
        let base_root = knowledge_root.join(&base_directory);
        let sources_root = base_root.join("sources");
        let originals_root = base_root.join("originals");
        fs::create_dir_all(&sources_root).await?;
        fs::create_dir_all(&originals_root).await?;
        let files: Vec<Value> = base
            .get("sourceFileIds")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .filter_map(|id| files_by_id.get(id).cloned())
            .collect();
        let metadata_files = files
            .iter()
            .map(|file| {
                let mut object = Map::new();
                for key in [
                    "id",
                    "name",
                    "mimeType",
                    "size",
                    "uploadedAt",
                    "extractedBy",
                    "extractionWarning",
                    "originalRelativePath",
                    "knowledgeStatus",
                    "knowledgeProgress",
                    "knowledgeError",
                    "knowledgeStartedAt",
                    "knowledgeCompletedAt",
                ] {
                    if let Some(value) = file.get(key) {
                        object.insert(key.into(), value.clone());
                    }
                }
                Value::Object(object)
            })
            .collect::<Vec<_>>();
        write_json(
            &base_root.join("metadata.json"),
            &json!({ "base": base, "files": metadata_files }),
        )
        .await?;
        let mut expected_sources = HashSet::new();
        let mut expected_originals = HashSet::new();
        for file in files {
            let path = source_path(&sources_root, &file);
            expected_sources.insert(
                path.file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_string(),
            );
            fs::write(path, value_str(&file, "contentText").unwrap_or("")).await?;
            if let Some(relative) = value_str(&file, "originalRelativePath") {
                if let Some(name) = Path::new(relative).file_name().and_then(OsStr::to_str) {
                    expected_originals.insert(name.to_string());
                }
            }
        }
        prune_unexpected_files(&sources_root, &expected_sources).await?;
        prune_unexpected_files(&originals_root, &expected_originals).await?;
    }
    prune_unexpected_dirs(&knowledge_root, &expected_bases).await?;
    Ok(())
}

async fn prune_unexpected_files(root: &Path, expected: &HashSet<String>) -> CommandResult<()> {
    let mut entries = fs::read_dir(root).await?;
    while let Some(entry) = entries.next_entry().await? {
        if entry.metadata().await?.is_file()
            && !expected.contains(&entry.file_name().to_string_lossy().to_string())
        {
            let _ = fs::remove_file(entry.path()).await;
        }
    }
    Ok(())
}

async fn prune_unexpected_dirs(root: &Path, expected: &HashSet<String>) -> CommandResult<()> {
    let mut entries = fs::read_dir(root).await?;
    while let Some(entry) = entries.next_entry().await? {
        if entry.metadata().await?.is_dir()
            && !expected.contains(&entry.file_name().to_string_lossy().to_string())
        {
            let _ = fs::remove_dir_all(entry.path()).await;
        }
    }
    Ok(())
}

async fn provider_models(provider: &Value) -> CommandResult<Vec<String>> {
    let provider_id = value_str(provider, "id").unwrap_or("");
    let base_url = value_str(provider, "baseUrl")
        .unwrap_or("")
        .trim_end_matches('/');
    let client = reqwest::Client::new();
    let mut models = Vec::new();

    if provider_id == "provider-ollama" {
        let data: Value = client
            .get(format!("{}/api/tags", base_url))
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        models.extend(
            data.get("models")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|model| value_str(model, "name").or_else(|| value_str(model, "model")))
                .map(ToOwned::to_owned),
        );
    } else {
        let api_key = get_credential("provider", provider_id)?.ok_or_else(|| {
            CommandError::Message(format!(
                "{} 尚未配置 API Key。",
                value_str(provider, "name").unwrap_or("Provider")
            ))
        })?;
        let request = if provider_id == "provider-anthropic" {
            client
                .get(format!("{}/v1/models", base_url))
                .header("x-api-key", api_key)
                .header("anthropic-version", "2023-06-01")
        } else {
            client
                .get(format!("{}/models", base_url))
                .bearer_auth(api_key)
        };
        let data: Value = request.send().await?.error_for_status()?.json().await?;
        models.extend(
            data.get("data")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|model| value_str(model, "id").or_else(|| value_str(model, "name")))
                .map(ToOwned::to_owned),
        );
    }
    models.sort();
    models.dedup();
    Ok(models)
}

fn model_messages(request: &Value, include_answer: bool) -> Vec<Value> {
    let mut messages = Vec::new();
    if let Some(history) = request.get("history").and_then(Value::as_array) {
        let limit = request
            .get("assistant")
            .and_then(|assistant| assistant.get("contextLimit"))
            .and_then(Value::as_u64)
            .unwrap_or(8) as usize;
        for message in history
            .iter()
            .rev()
            .take(limit)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
        {
            let role = value_str(message, "role").unwrap_or("user");
            let content = message
                .get("blocks")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter(|block| value_str(block, "type") == Some("text"))
                .filter_map(|block| value_str(block, "content"))
                .collect::<Vec<_>>()
                .join("\n\n");
            if !content.trim().is_empty() {
                messages.push(json!({ "role": role, "content": content }));
            }
        }
    }
    if !include_answer {
        let prompt = [
            value_str(request, "prompt").unwrap_or("").to_string(),
            value_str(request, "knowledgeContext")
                .map(|context| {
                    format!(
                        "以下是经过检索的工作区知识和知识图谱线索，仅在相关时引用：\n{}",
                        context
                    )
                })
                .unwrap_or_default(),
        ]
        .into_iter()
        .filter(|part| !part.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n\n");
        if !prompt.trim().is_empty() {
            messages.push(json!({ "role": "user", "content": prompt }));
        }
    }
    messages
}

async fn chat_completion(
    provider: &Value,
    model: &str,
    system: &str,
    messages: Vec<Value>,
) -> CommandResult<String> {
    let provider_id = value_str(provider, "id").unwrap_or("");
    let base_url = value_str(provider, "baseUrl")
        .unwrap_or("")
        .trim_end_matches('/');
    let client = reqwest::Client::new();

    if provider_id == "provider-ollama" {
        let data: Value = client
            .post(format!("{}/api/chat", base_url))
            .json(&json!({
                "model": model,
                "stream": false,
                "messages": std::iter::once(json!({ "role": "system", "content": system }))
                    .chain(messages.into_iter())
                    .collect::<Vec<_>>()
            }))
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        return Ok(data
            .get("message")
            .and_then(|message| value_str(message, "content"))
            .unwrap_or("")
            .to_string());
    }

    let api_key = get_credential("provider", provider_id)?.ok_or_else(|| {
        CommandError::Message(format!(
            "{} 尚未配置安全凭据。",
            value_str(provider, "name").unwrap_or("Provider")
        ))
    })?;

    if provider_id == "provider-anthropic" {
        let data: Value = client
            .post(format!("{}/v1/messages", base_url))
            .header("x-api-key", api_key)
            .header("anthropic-version", "2023-06-01")
            .json(&json!({
                "model": model,
                "system": system,
                "messages": messages,
                "max_tokens": 4096,
                "temperature": 0.4
            }))
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        return Ok(data
            .get("content")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|item| value_str(item, "text"))
            .collect::<Vec<_>>()
            .join(""));
    }

    let data: Value = client
        .post(format!("{}/chat/completions", base_url))
        .bearer_auth(api_key)
        .json(&json!({
            "model": model,
            "messages": std::iter::once(json!({ "role": "system", "content": system }))
                .chain(messages.into_iter())
                .collect::<Vec<_>>(),
            "temperature": 0.4
        }))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    Ok(data
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .and_then(|choice| choice.get("message"))
        .and_then(|message| value_str(message, "content"))
        .unwrap_or("")
        .to_string())
}

fn emit_agent_text_delta(app: &AppHandle, run_id: &str, delta: &str) {
    if !delta.is_empty() {
        let _ = app.emit(
            "agent:event",
            json!({ "runId": run_id, "type": "text-delta", "delta": delta }),
        );
    }
}

fn parse_openai_stream_delta(value: &Value) -> String {
    value
        .get("choices")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|choice| {
            choice
                .get("delta")
                .and_then(|delta| value_str(delta, "content"))
                .or_else(|| {
                    choice
                        .get("message")
                        .and_then(|message| value_str(message, "content"))
                })
        })
        .collect::<Vec<_>>()
        .join("")
}

fn parse_anthropic_stream_delta(value: &Value) -> String {
    match value_str(value, "type") {
        Some("content_block_delta") => value
            .get("delta")
            .and_then(|delta| value_str(delta, "text"))
            .unwrap_or("")
            .to_string(),
        Some("content_block_start") => value
            .get("content_block")
            .and_then(|content_block| value_str(content_block, "text"))
            .unwrap_or("")
            .to_string(),
        _ => String::new(),
    }
}

fn parse_ollama_stream_delta(value: &Value) -> String {
    value
        .get("message")
        .and_then(|message| value_str(message, "content"))
        .unwrap_or("")
        .to_string()
}

async fn stream_json_lines(
    app: &AppHandle,
    run_id: &str,
    response: reqwest::Response,
    parse_delta: fn(&Value) -> String,
) -> CommandResult<String> {
    let mut stream = response.bytes_stream();
    let mut buffer = String::new();
    let mut received_text = String::new();

    while let Some(chunk) = stream.next().await {
        buffer.push_str(&String::from_utf8_lossy(&chunk?));

        while let Some(newline_index) = buffer.find('\n') {
            let line = buffer[..newline_index].trim().to_string();
            buffer = buffer[newline_index + 1..].to_string();
            if line.is_empty() {
                continue;
            }

            let payload = line
                .strip_prefix("data:")
                .map(str::trim)
                .unwrap_or(line.as_str());
            if payload == "[DONE]" {
                return Ok(received_text);
            }

            let Ok(value) = serde_json::from_str::<Value>(payload) else {
                continue;
            };
            let delta = parse_delta(&value);
            if !delta.is_empty() {
                received_text.push_str(&delta);
                emit_agent_text_delta(app, run_id, &delta);
            }
        }
    }

    let payload = buffer.trim();
    if !payload.is_empty() && payload != "[DONE]" {
        let payload = payload
            .strip_prefix("data:")
            .map(str::trim)
            .unwrap_or(payload);
        if let Ok(value) = serde_json::from_str::<Value>(payload) {
            let delta = parse_delta(&value);
            if !delta.is_empty() {
                received_text.push_str(&delta);
                emit_agent_text_delta(app, run_id, &delta);
            }
        }
    }

    Ok(received_text)
}

async fn ensure_success_response(response: reqwest::Response) -> CommandResult<reqwest::Response> {
    if response.status().is_success() {
        return Ok(response);
    }

    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    Err(CommandError::Message(format!(
        "Provider 请求失败：HTTP {}{}",
        status,
        if body.trim().is_empty() {
            String::new()
        } else {
            format!("，{}", body.trim())
        }
    )))
}

async fn chat_completion_stream(
    app: &AppHandle,
    run_id: &str,
    provider: &Value,
    model: &str,
    system: &str,
    messages: Vec<Value>,
) -> CommandResult<String> {
    let provider_id = value_str(provider, "id").unwrap_or("");
    let base_url = value_str(provider, "baseUrl")
        .unwrap_or("")
        .trim_end_matches('/');
    let client = reqwest::Client::new();

    if provider_id == "provider-ollama" {
        let response = client
            .post(format!("{}/api/chat", base_url))
            .json(&json!({
                "model": model,
                "stream": true,
                "messages": std::iter::once(json!({ "role": "system", "content": system }))
                    .chain(messages.into_iter())
                    .collect::<Vec<_>>()
            }))
            .send()
            .await?;
        return stream_json_lines(
            app,
            run_id,
            ensure_success_response(response).await?,
            parse_ollama_stream_delta,
        )
        .await;
    }

    let api_key = get_credential("provider", provider_id)?.ok_or_else(|| {
        CommandError::Message(format!(
            "{} 尚未配置安全凭据。",
            value_str(provider, "name").unwrap_or("Provider")
        ))
    })?;

    if provider_id == "provider-anthropic" {
        let response = client
            .post(format!("{}/v1/messages", base_url))
            .header("x-api-key", api_key)
            .header("anthropic-version", "2023-06-01")
            .json(&json!({
                "model": model,
                "system": system,
                "messages": messages,
                "max_tokens": 4096,
                "temperature": 0.4,
                "stream": true
            }))
            .send()
            .await?;
        return stream_json_lines(
            app,
            run_id,
            ensure_success_response(response).await?,
            parse_anthropic_stream_delta,
        )
        .await;
    }

    let response = client
        .post(format!("{}/chat/completions", base_url))
        .bearer_auth(api_key)
        .json(&json!({
            "model": model,
            "messages": std::iter::once(json!({ "role": "system", "content": system }))
                .chain(messages.into_iter())
                .collect::<Vec<_>>(),
            "temperature": 0.4,
            "stream": true
        }))
        .send()
        .await?;
    stream_json_lines(
        app,
        run_id,
        ensure_success_response(response).await?,
        parse_openai_stream_delta,
    )
    .await
}

fn openclaw_core_enabled(request: &Value) -> bool {
    request
        .get("openClawCore")
        .and_then(|config| config.get("enabled"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn openclaw_max_delegated_agents(request: &Value) -> usize {
    request
        .get("openClawCore")
        .and_then(|config| config.get("maxDelegatedAgents"))
        .and_then(Value::as_u64)
        .unwrap_or(3)
        .clamp(1, 5) as usize
}

fn openclaw_audit_enabled(request: &Value) -> bool {
    request
        .get("openClawCore")
        .and_then(|config| config.get("auditLogEnabled"))
        .and_then(Value::as_bool)
        .unwrap_or(true)
}

fn emit_openclaw_audit(app: &AppHandle, run_id: &str, message: impl Into<String>) {
    let _ = app.emit(
        "agent:event",
        json!({
            "runId": run_id,
            "type": "tool-output",
            "toolCallId": format!("openclaw-audit-{}", now_millis_string()),
            "output": message.into(),
            "preliminary": false
        }),
    );
}

fn assistant_id(assistant: &Value) -> String {
    value_str(assistant, "id").unwrap_or("").to_string()
}

fn assistant_name(assistant: &Value) -> String {
    value_str(assistant, "name").unwrap_or("Agent").to_string()
}

fn assistant_system_prompt(assistant: &Value) -> String {
    value_str(assistant, "systemPrompt")
        .unwrap_or("你是 Emphant Studio 中的 AI 助手。")
        .to_string()
}

fn provider_for_assistant(request: &Value, assistant: &Value) -> Option<Value> {
    let provider_id = value_str(assistant, "providerId")?;
    request
        .get("availableProviders")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .find(|provider| value_str(provider, "id") == Some(provider_id))
        .cloned()
        .or_else(|| {
            let current = request.get("provider")?;
            (value_str(current, "id") == Some(provider_id)).then(|| current.clone())
        })
}

fn candidate_assistants(request: &Value, main_assistant_id: &str) -> Vec<Value> {
    request
        .get("candidateAssistants")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|assistant| assistant_id(assistant) != main_assistant_id)
        .cloned()
        .collect()
}

fn find_assistant_by_id(candidates: &[Value], id: &str) -> Option<Value> {
    candidates
        .iter()
        .find(|assistant| assistant_id(assistant) == id)
        .cloned()
}

fn extract_json_array_text(text: &str) -> Option<&str> {
    let start = text.find('[')?;
    let end = text.rfind(']')?;
    (end > start).then(|| &text[start..=end])
}

fn fallback_route_assistants(prompt: &str, candidates: &[Value], limit: usize) -> Vec<Value> {
    let lower_prompt = prompt.to_lowercase();
    let mut scored = candidates
        .iter()
        .map(|assistant| {
            let signals = [
                value_str(assistant, "name").unwrap_or(""),
                value_str(assistant, "description").unwrap_or(""),
            ]
            .join(" ")
            .to_lowercase();
            let score = signals
                .split(|ch: char| !ch.is_alphanumeric() && ch != '_' && ch != '-')
                .filter(|token| token.chars().count() >= 2)
                .filter(|token| lower_prompt.contains(token))
                .count();
            (score, assistant.clone())
        })
        .collect::<Vec<_>>();
    scored.sort_by(|left, right| right.0.cmp(&left.0));
    let selected = scored
        .into_iter()
        .filter(|(score, _)| *score > 0)
        .map(|(_, assistant)| assistant)
        .take(limit)
        .collect::<Vec<_>>();

    if selected.is_empty() {
        candidates.iter().take(1).cloned().collect()
    } else {
        selected
    }
}

async fn route_openclaw_agents(
    request: &Value,
    provider: &Value,
    main_assistant: &Value,
    candidates: &[Value],
) -> Vec<Value> {
    let limit = openclaw_max_delegated_agents(request);
    let prompt = value_str(request, "prompt").unwrap_or("");
    if candidates.is_empty() {
        return Vec::new();
    }

    let roster = candidates
        .iter()
        .map(|assistant| {
            format!(
                "- id: {}\n  name: {}\n  description: {}\n  capabilities: {}",
                assistant_id(assistant),
                assistant_name(assistant),
                value_str(assistant, "description").unwrap_or(""),
                assistant
                    .get("capabilities")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join("、")
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    let system = [
        assistant_system_prompt(main_assistant),
        "你是内嵌 OpenClaw Core 的 Router。只选择真正需要参与的子 Agent。".to_string(),
        "只输出 JSON 数组，不要解释。格式：[{\"agentId\":\"assistant-id\",\"reason\":\"简短原因\"}]。"
            .to_string(),
    ]
    .join("\n\n");
    let route_prompt = format!(
        "用户任务：\n{}\n\n可用子 Agent：\n{}\n\n最多选择 {} 个。若一个专业 Agent 足够，只选择一个。",
        prompt, roster, limit
    );

    let model = value_str(main_assistant, "model")
        .or_else(|| value_str(request, "model"))
        .unwrap_or("");
    let routed = chat_completion(
        provider,
        model,
        &system,
        vec![json!({ "role": "user", "content": route_prompt })],
    )
    .await
    .ok()
    .and_then(|text| extract_json_array_text(&text).map(str::to_string))
    .and_then(|json_text| serde_json::from_str::<Value>(&json_text).ok())
    .and_then(|value| value.as_array().cloned())
    .map(|items| {
        items
            .into_iter()
            .filter_map(|item| value_str(&item, "agentId").map(str::to_string))
            .filter_map(|id| find_assistant_by_id(candidates, &id))
            .take(limit)
            .collect::<Vec<_>>()
    })
    .unwrap_or_default();

    if routed.is_empty() {
        fallback_route_assistants(prompt, candidates, limit)
    } else {
        routed
    }
}

fn sub_agent_request(
    request: &Value,
    assistant: &Value,
    sub_answer_context: Option<&str>,
) -> Value {
    let assistant_id = assistant_id(assistant);
    let candidate_context = request
        .get("candidateKnowledgeContexts")
        .and_then(|contexts| contexts.get(&assistant_id))
        .and_then(Value::as_str)
        .unwrap_or("");
    let knowledge_context = [candidate_context, sub_answer_context.unwrap_or("")]
        .into_iter()
        .filter(|part| !part.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n\n");
    let mut next = request.clone();
    if let Some(object) = next.as_object_mut() {
        object.insert("assistant".into(), assistant.clone());
        if knowledge_context.trim().is_empty() {
            object.remove("knowledgeContext");
        } else {
            object.insert("knowledgeContext".into(), Value::String(knowledge_context));
        }
    }
    next
}

async fn run_openclaw_embedded_agent(
    app: AppHandle,
    request: Value,
    run_id: String,
    provider: Value,
    main_assistant: Value,
    model: String,
    system: String,
) -> CommandResult<Value> {
    let main_assistant_id = assistant_id(&main_assistant);
    let candidates = candidate_assistants(&request, &main_assistant_id);
    let selected_agents =
        route_openclaw_agents(&request, &provider, &main_assistant, &candidates).await;

    if selected_agents.is_empty() {
        let answer = chat_completion_stream(
            &app,
            &run_id,
            &provider,
            &model,
            &system,
            model_messages(&request, false),
        )
        .await?;
        emit_generated_files_saved(&app, &run_id, &request, &answer).await?;
        let _ = app.emit(
            "agent:event",
            json!({ "runId": run_id, "type": "finish", "finishReason": "stop" }),
        );
        return Ok(json!({ "runId": run_id, "status": "completed" }));
    }

    if openclaw_audit_enabled(&request) {
        emit_openclaw_audit(
            &app,
            &run_id,
            format!(
                "OpenClaw Core 正在委派专业 Agent：{}",
                selected_agents
                    .iter()
                    .map(assistant_name)
                    .collect::<Vec<_>>()
                    .join("、")
            ),
        );
    }

    emit_agent_text_delta(
        &app,
        &run_id,
        &format!(
            "我将委派给 {}。\n\n",
            selected_agents
                .iter()
                .map(assistant_name)
                .collect::<Vec<_>>()
                .join("、")
        ),
    );

    let mut sub_answers = Vec::new();
    for assistant in selected_agents {
        let name = assistant_name(&assistant);
        let Some(sub_provider) = provider_for_assistant(&request, &assistant) else {
            emit_agent_text_delta(
                &app,
                &run_id,
                &format!("### {}\nProvider 不可用，已跳过。\n\n", name),
            );
            continue;
        };
        let sub_model = value_str(&assistant, "model").unwrap_or("").to_string();
        let sub_system = [
            assistant_system_prompt(&assistant),
            "你是内嵌 OpenClaw Core 中被 Router 委派的专业 Agent。只完成自己职责范围内的分析或执行建议。"
                .to_string(),
        ]
        .join("\n\n");
        let before = chat_completion(
            &sub_provider,
            &sub_model,
            &sub_system,
            model_messages(&sub_agent_request(&request, &assistant, None), false),
        )
        .await?;
        emit_agent_text_delta(&app, &run_id, &format!("### {}\n{}\n\n", name, before));
        sub_answers.push(format!("## {}\n{}", name, before));
    }

    if !sub_answers.is_empty() {
        emit_agent_text_delta(&app, &run_id, "### 汇总\n");
        let summary_context = format!(
            "以下是 OpenClaw Core 子 Agent 的执行结果，请整合为一个简洁、可执行的最终答复：\n\n{}",
            sub_answers.join("\n\n")
        );
        let summary_request = sub_agent_request(&request, &main_assistant, Some(&summary_context));
        let answer = chat_completion_stream(
            &app,
            &run_id,
            &provider,
            &model,
            &system,
            model_messages(&summary_request, false),
        )
        .await?;
        emit_generated_files_saved(&app, &run_id, &request, &answer).await?;
    }

    let _ = app.emit(
        "agent:event",
        json!({ "runId": run_id, "type": "finish", "finishReason": "stop" }),
    );
    Ok(json!({ "runId": run_id, "status": "completed" }))
}

async fn emit_generated_files_saved(
    app: &AppHandle,
    run_id: &str,
    request: &Value,
    answer: &str,
) -> CommandResult<()> {
    let workspace =
        resolve_workspace_directory(value_str(request, "workspaceDirectory").map(str::to_string))?;
    let prompt = value_str(request, "prompt").unwrap_or("");
    let saved_paths = save_generated_files(&workspace, prompt, answer).await?;
    if saved_paths.is_empty() {
        return Ok(());
    }

    let relative_paths = saved_paths
        .iter()
        .map(|path| {
            Path::new(path)
                .strip_prefix(&workspace)
                .map(|relative| relative.to_string_lossy().to_string())
                .unwrap_or_else(|_| path.to_string())
        })
        .collect::<Vec<_>>();

    let _ = app.emit(
        "agent:event",
        json!({
            "runId": run_id,
            "type": "tool-output",
            "toolCallId": format!("generated-files-{}", now_millis_string()),
            "output": format!(
                "已保存生成文件到工作目录：\n{}",
                relative_paths
                    .iter()
                    .map(|path| format!("- {}", path))
                    .collect::<Vec<_>>()
                    .join("\n")
            ),
            "preliminary": false
        }),
    );

    Ok(())
}

fn simple_knowledge_index(request: &Value) -> Value {
    let content = value_str(request, "contentText").unwrap_or("");
    let file_id = value_str(request, "fileId").unwrap_or("file");
    let file_name = value_str(request, "fileName").unwrap_or("文档");
    let mut chunks = Vec::new();
    for (index, chunk) in content
        .as_bytes()
        .chunks(6000)
        .take(12)
        .enumerate()
        .map(|(index, bytes)| (index, String::from_utf8_lossy(bytes).to_string()))
    {
        let trimmed = chunk.trim().to_string();
        if trimmed.is_empty() {
            continue;
        }
        chunks.push(json!({
            "id": uuid::Uuid::new_v4().to_string(),
            "sourceFileId": file_id,
            "content": trimmed,
            "tokenCount": chunk.chars().count() / 2 + 1,
            "title": if index == 0 { file_name.to_string() } else { format!("{} 片段 {}", file_name, index + 1) },
            "summary": chunk.lines().find(|line| !line.trim().is_empty()).unwrap_or("").chars().take(180).collect::<String>(),
            "keywords": [],
            "entityIds": []
        }));
    }
    if chunks.is_empty() {
        chunks.push(json!({
            "id": uuid::Uuid::new_v4().to_string(),
            "sourceFileId": file_id,
            "content": content,
            "tokenCount": 1,
            "title": file_name,
            "summary": "",
            "keywords": [],
            "entityIds": []
        }));
    }
    json!({
        "chunks": chunks,
        "graph": request.get("existingGraph").cloned().unwrap_or_else(|| json!({ "nodes": [], "edges": [], "facts": [] }))
    })
}

async fn memory_path(app: &AppHandle) -> CommandResult<PathBuf> {
    let path = app_data_directory(app)?.join("memory-profile.json");
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).await?;
    }
    Ok(path)
}

async fn load_memory(app: &AppHandle) -> CommandResult<Value> {
    let path = memory_path(app).await?;
    let mut profile = fs::read_to_string(&path)
        .await
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .unwrap_or_else(|| json!({ "facts": [], "relations": [], "emails": [] }));
    if let Some(emails) = profile.get_mut("emails").and_then(Value::as_array_mut) {
        for email in emails {
            let address = value_str(email, "address").unwrap_or("").to_string();
            let configured = get_credential("email", &address)?.is_some();
            if let Some(object) = email.as_object_mut() {
                object.insert("credentialConfigured".into(), Value::Bool(configured));
            }
        }
    }
    Ok(profile)
}

async fn save_memory(app: &AppHandle, profile: &Value) -> CommandResult<()> {
    let path = memory_path(app).await?;
    fs::write(
        path,
        format!("{}\n", serde_json::to_string_pretty(profile)?),
    )
    .await?;
    Ok(())
}

#[tauri::command]
async fn get_app_info(app: AppHandle) -> CommandResult<Value> {
    Ok(json!({
      "name": APP_NAME,
      "platform": env::consts::OS,
      "version": app.package_info().version.to_string()
    }))
}

#[tauri::command]
async fn get_default_workspace_directory() -> CommandResult<String> {
    let path = default_workspace_directory()?;
    fs::create_dir_all(&path).await?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
async fn select_workspace_directory(
    payload: SelectDirectoryPayload,
) -> CommandResult<Option<String>> {
    let mut dialog = rfd::AsyncFileDialog::new().set_title("选择工作目录");
    if let Some(default_path) = payload.default_path.filter(|path| !path.trim().is_empty()) {
        dialog = dialog.set_directory(default_path);
    } else {
        dialog = dialog.set_directory(default_workspace_directory()?);
    }
    Ok(dialog
        .pick_folder()
        .await
        .map(|folder| folder.path().to_string_lossy().to_string()))
}

#[tauri::command]
async fn select_skill_directory() -> CommandResult<Option<String>> {
    Ok(rfd::AsyncFileDialog::new()
        .set_title("选择 Skill 目录")
        .pick_folder()
        .await
        .map(|folder| folder.path().to_string_lossy().to_string()))
}

#[tauri::command]
async fn import_skill_source(app: AppHandle, request: SkillImportRequest) -> CommandResult<Value> {
    let source = request.source.trim();
    if source.is_empty() {
        return Err(CommandError::Message("请输入 Skill 来源。".into()));
    }
    let root = if request.kind == "github" {
        clone_skill_repo(&app, source).await?
    } else {
        PathBuf::from(source)
    };
    if !root.is_dir() {
        return Err(CommandError::Message("Skill 来源必须是一个目录。".into()));
    }
    let source_label = if request.kind == "github" {
        source.to_string()
    } else {
        root.to_string_lossy().to_string()
    };
    let skills = parse_skill_directory(&root, &source_label)?;
    Ok(json!({
        "skills": skills,
        "importedPath": root.to_string_lossy()
    }))
}

#[tauri::command]
async fn scan_workspace_files(
    payload: WorkspaceScanPayload,
) -> CommandResult<Vec<WorkspaceFileMatch>> {
    let root = env::current_dir()?;
    let query = payload.query;
    let limit = payload.limit.unwrap_or(5);
    tokio::task::spawn_blocking(move || scan_workspace_with_walkdir(&root, &query, limit))
        .await
        .map_err(|error| CommandError::Message(error.to_string()))?
}

#[tauri::command]
async fn read_workspace_file(payload: PathPayload) -> CommandResult<Value> {
    let root = env::current_dir()?;
    let requested = PathBuf::from(&payload.path);
    let target = ensure_inside(
        &root,
        &if requested.is_absolute() {
            requested
        } else {
            root.join(requested)
        },
    )?;
    let metadata = fs::metadata(&target).await?;
    let mime_type = mime_guess::from_path(&target)
        .first_or_octet_stream()
        .essence_str()
        .to_string();
    let extraction = extract_local_document(&target).await?;
    Ok(json!({
      "path": target.to_string_lossy(),
      "name": target.file_name().and_then(OsStr::to_str).unwrap_or_default(),
      "size": metadata.len(),
      "mimeType": mime_type,
      "contentText": extraction.get("contentText").cloned().unwrap_or(Value::Null),
      "extractedBy": extraction.get("extractedBy").cloned().unwrap_or(Value::Null),
      "extractionWarning": extraction.get("warning").cloned().unwrap_or(Value::Null)
    }))
}

#[tauri::command]
async fn extract_document(request: DocumentExtractionRequest) -> CommandResult<Value> {
    extract_uploaded_document(&request).await
}

#[tauri::command]
async fn load_workspace_content(
    payload: WorkspaceDirectoryPayload,
) -> CommandResult<Option<Value>> {
    let directory = resolve_workspace_directory(payload.workspace_directory)?;
    fs::create_dir_all(&directory).await?;
    let root = workspace_data_root(&directory);
    init_workspace_database(&root).await?;
    load_from_root(&root)
        .await?
        .or(load_from_root(&directory.join(LEGACY_DATA_DIRECTORY)).await?)
        .pipe(Ok)
}

trait Pipe: Sized {
    fn pipe<T>(self, f: impl FnOnce(Self) -> T) -> T {
        f(self)
    }
}
impl<T> Pipe for T {}

#[tauri::command]
async fn save_workspace_content(payload: WorkspaceSavePayload) -> CommandResult<()> {
    let directory = resolve_workspace_directory(payload.workspace_directory)?;
    fs::create_dir_all(&directory).await?;
    save_workspace_snapshot(&directory, &payload.snapshot).await?;
    let root = workspace_data_root(&directory);
    sync_snapshot_to_database(&root, &payload.snapshot).await?;
    index_workspace_files(&root, &directory).await
}

#[tauri::command]
async fn save_knowledge_source(request: KnowledgeSourceSaveRequest) -> CommandResult<String> {
    if request.bytes.len() > 100 * 1024 * 1024 {
        return Err(CommandError::Message("知识库文件不能超过 100 MB。".into()));
    }
    let workspace = PathBuf::from(&request.workspace_directory);
    let base_directory = base_directory_name(
        request.knowledge_base_name.as_deref().unwrap_or("知识库"),
        &request.knowledge_base_id,
    );
    let extension = Path::new(&request.file_name)
        .extension()
        .and_then(OsStr::to_str)
        .map(|ext| format!(".{}", ext.to_lowercase()))
        .unwrap_or_default();
    let stem = request
        .file_name
        .strip_suffix(&extension)
        .unwrap_or(&request.file_name);
    let stored_name = format!(
        "{}--{}{}",
        safe_name(stem),
        safe_name(&request.file_id),
        extension
    );
    let relative = PathBuf::from(KNOWLEDGE_DIRECTORY)
        .join(base_directory)
        .join("originals")
        .join(stored_name);
    let full_path = workspace.join(DATA_DIRECTORY).join(&relative);
    if let Some(parent) = full_path.parent() {
        fs::create_dir_all(parent).await?;
    }
    fs::write(full_path, request.bytes).await?;
    Ok(relative.to_string_lossy().to_string())
}

#[tauri::command]
async fn read_knowledge_source(request: KnowledgeSourceReadRequest) -> CommandResult<Vec<u8>> {
    let root = PathBuf::from(&request.workspace_directory).join(DATA_DIRECTORY);
    let target = ensure_inside(&root, &root.join(request.relative_path))?;
    Ok(fs::read(target).await?)
}

#[tauri::command]
async fn index_knowledge_source(request: Value) -> CommandResult<Value> {
    Ok(simple_knowledge_index(&request))
}

#[tauri::command]
async fn start_knowledge_extraction(app: AppHandle, request: Value) -> CommandResult<()> {
    let job_id = value_str(&request, "jobId").unwrap_or("job").to_string();
    let knowledge_base_id = value_str(&request, "knowledgeBaseId")
        .unwrap_or("kb")
        .to_string();
    let file_id = value_str(&request, "fileId").unwrap_or("file").to_string();
    let started_at = now_iso();
    let _ = app.emit(
        "knowledge:extraction-event",
        json!({
            "jobId": job_id, "knowledgeBaseId": knowledge_base_id, "fileId": file_id,
            "status": "extracting", "progress": 15, "startedAt": started_at
        }),
    );
    let bytes = request
        .get("bytes")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_u64)
                .map(|n| n as u8)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let extraction = extract_uploaded_document(&DocumentExtractionRequest {
        name: value_str(&request, "fileName").unwrap_or("document").into(),
        mime_type: value_str(&request, "mimeType")
            .unwrap_or("application/octet-stream")
            .into(),
        bytes,
    })
    .await?;
    let content_text = value_str(&extraction, "contentText")
        .unwrap_or("")
        .to_string();
    let _ = app.emit(
        "knowledge:extraction-event",
        json!({
            "jobId": job_id, "knowledgeBaseId": knowledge_base_id, "fileId": file_id,
            "status": "indexing", "progress": 50, "contentText": content_text,
            "extractedBy": extraction.get("extractedBy").cloned().unwrap_or(Value::Null),
            "extractionWarning": extraction.get("warning").cloned().unwrap_or(Value::Null),
            "startedAt": started_at
        }),
    );
    let mut index_request = request.clone();
    if let Some(object) = index_request.as_object_mut() {
        object.insert("contentText".into(), Value::String(content_text.clone()));
    }
    let index_result = simple_knowledge_index(&index_request);
    let _ = app.emit(
        "knowledge:extraction-event",
        json!({
            "jobId": job_id, "knowledgeBaseId": knowledge_base_id, "fileId": file_id,
            "status": "ready", "progress": 100, "contentText": content_text,
            "extractedBy": extraction.get("extractedBy").cloned().unwrap_or(Value::Null),
            "extractionWarning": extraction.get("warning").cloned().unwrap_or(Value::Null),
            "indexResult": index_result, "startedAt": started_at, "completedAt": now_iso()
        }),
    );
    Ok(())
}

#[tauri::command]
async fn copy_text(text: String) -> CommandResult<()> {
    #[cfg(target_os = "macos")]
    {
        let mut child = tokio::process::Command::new("pbcopy")
            .stdin(std::process::Stdio::piped())
            .spawn()?;
        if let Some(mut stdin) = child.stdin.take() {
            stdin.write_all(text.as_bytes()).await?;
        }
        child.wait().await?;
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = text;
        Err(CommandError::Message("当前平台剪贴板实现待补齐。".into()))
    }
}

#[tauri::command]
async fn set_credential(request: CredentialSetRequest) -> CommandResult<()> {
    if request.secret.trim().is_empty() {
        return Err(CommandError::Message("凭据不能为空。".into()));
    }
    let entry = keyring::Entry::new(APP_NAME, &credential_key(&request.scope, &request.id))?;
    entry.set_password(request.secret.trim())?;
    Ok(())
}

#[tauri::command]
async fn delete_credential(request: CredentialStatusRequest) -> CommandResult<()> {
    let entry = keyring::Entry::new(APP_NAME, &credential_key(&request.scope, &request.id))?;
    match entry.delete_credential() {
        Ok(_) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(error.into()),
    }
}

#[tauri::command]
async fn has_credential(request: CredentialStatusRequest) -> CommandResult<bool> {
    Ok(get_credential(&request.scope, &request.id)?.is_some())
}

#[tauri::command]
async fn list_provider_models(provider: Value) -> CommandResult<Vec<String>> {
    provider_models(&provider).await
}

#[tauri::command]
async fn run_agent(app: AppHandle, request: Value) -> CommandResult<Value> {
    let run_id = value_str(&request, "runId")
        .unwrap_or("unknown-run")
        .to_string();
    let provider = request
        .get("provider")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let assistant = request
        .get("assistant")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let model = value_str(&assistant, "model")
        .or_else(|| value_str(&request, "model"))
        .unwrap_or("")
        .to_string();
    let workspace =
        resolve_workspace_directory(value_str(&request, "workspaceDirectory").map(str::to_string))?;
    let generated_directory = workspace.join(GENERATED_DIRECTORY);
    let system = [
        value_str(&assistant, "systemPrompt").unwrap_or("你是 Emphant Studio 中的 AI 助手。"),
        "你运行在 Emphant Studio 的受控工作区中。回答应直接、可靠，必要时说明限制。",
        &format!(
            "当用户要求生成代码、文档或其他可保存文件时，请把每个文件作为独立 fenced code block 输出，并在代码块信息中写明相对路径，例如 ```ts path=src/example.ts 或 ```markdown path=docs/report.md。系统会自动保存到工作目录的 {} 文件夹中。",
            generated_directory.to_string_lossy()
        ),
    ]
    .join("\n\n");
    if openclaw_core_enabled(&request) && value_str(&request, "routingMode") == Some("main") {
        return run_openclaw_embedded_agent(
            app, request, run_id, provider, assistant, model, system,
        )
        .await;
    }
    let result = chat_completion_stream(
        &app,
        &run_id,
        &provider,
        &model,
        &system,
        model_messages(&request, false),
    )
    .await;
    match result {
        Ok(answer) => {
            emit_generated_files_saved(&app, &run_id, &request, &answer).await?;
            let _ = app.emit(
                "agent:event",
                json!({ "runId": run_id, "type": "finish", "finishReason": "stop" }),
            );
            Ok(json!({ "runId": run_id, "status": "completed" }))
        }
        Err(error) => {
            let _ = app.emit(
                "agent:event",
                json!({ "runId": run_id, "type": "error", "message": error.to_string() }),
            );
            Ok(json!({ "runId": run_id, "status": "error" }))
        }
    }
}

#[tauri::command]
async fn approve_agent(response: Value) -> CommandResult<Value> {
    Ok(json!({
      "runId": value_str(&response, "runId").unwrap_or("unknown-run"),
      "status": "cancelled"
    }))
}

#[tauri::command]
async fn cancel_agent(payload: AgentRunIdPayload) -> CommandResult<()> {
    let _ = payload.run_id;
    Ok(())
}

#[tauri::command]
async fn generate_topic_title(request: Value) -> CommandResult<String> {
    let provider = request
        .get("provider")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let model = value_str(&request, "model").unwrap_or("").to_string();
    let prompt = format!(
        "用户问题：\n{}\n\n助手回答：\n{}",
        value_str(&request, "prompt")
            .unwrap_or("")
            .chars()
            .take(2000)
            .collect::<String>(),
        value_str(&request, "answer")
            .unwrap_or("")
            .chars()
            .take(4000)
            .collect::<String>()
    );
    let title = chat_completion(
        &provider,
        &model,
        "你负责为 AI 工作台生成 6 到 18 个汉字的简短中文标题。只输出标题，不要解释。",
        vec![json!({ "role": "user", "content": prompt })],
    )
    .await?;
    Ok(title
        .trim()
        .trim_matches(['"', '\'', '“', '”', '。', '.', ':', '：'])
        .chars()
        .take(24)
        .collect::<String>())
}

#[tauri::command]
async fn get_memory_greeting(app: AppHandle) -> CommandResult<Value> {
    let profile = load_memory(&app).await?;
    let user_name = value_str(&profile, "userName").map(ToOwned::to_owned);
    Ok(json!({
        "userName": user_name,
        "message": user_name
            .as_ref()
            .map(|name| format!("{}，欢迎回来。", name))
            .unwrap_or_else(|| "你好，我是 Emphant Studio。".into())
    }))
}

#[tauri::command]
async fn get_memory_profile(app: AppHandle) -> CommandResult<Value> {
    load_memory(&app).await
}

#[tauri::command]
async fn update_memory_profile_fact(app: AppHandle, request: Value) -> CommandResult<String> {
    let mut profile = load_memory(&app).await?;
    let id = value_str(&request, "id")
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let fact = json!({
        "id": id,
        "category": value_str(&request, "category").unwrap_or("profile"),
        "predicate": value_str(&request, "predicate").unwrap_or("note"),
        "value": value_str(&request, "value").unwrap_or(""),
        "confidence": 1,
        "importance": 0.8,
        "updatedAt": now_iso()
    });
    let facts = profile
        .as_object_mut()
        .unwrap()
        .entry("facts")
        .or_insert_with(|| json!([]))
        .as_array_mut()
        .unwrap();
    if let Some(existing) = facts
        .iter_mut()
        .find(|item| value_str(item, "id") == Some(id.as_str()))
    {
        *existing = fact;
    } else {
        facts.push(fact);
    }
    save_memory(&app, &profile).await?;
    Ok(id)
}

#[tauri::command]
async fn delete_memory_profile_fact(app: AppHandle, payload: Value) -> CommandResult<()> {
    let mut profile = load_memory(&app).await?;
    let id = value_str(&payload, "id").unwrap_or("");
    if let Some(facts) = profile.get_mut("facts").and_then(Value::as_array_mut) {
        facts.retain(|fact| value_str(fact, "id") != Some(id));
    }
    if let Some(emails) = profile.get_mut("emails").and_then(Value::as_array_mut) {
        emails.retain(|email| value_str(email, "sourceFactId") != Some(id));
    }
    save_memory(&app, &profile).await
}

#[tauri::command]
async fn update_memory_profile_relation(app: AppHandle, request: Value) -> CommandResult<String> {
    let mut profile = load_memory(&app).await?;
    let id = value_str(&request, "id")
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let relation = json!({
        "id": id,
        "targetEntityId": value_str(&request, "targetEntityId").unwrap_or(&id),
        "sourceName": value_str(&profile, "userName").unwrap_or("我"),
        "relationType": value_str(&request, "relationType").unwrap_or("related_to"),
        "targetName": value_str(&request, "targetName").unwrap_or(""),
        "confidence": 1
    });
    let relations = profile
        .as_object_mut()
        .unwrap()
        .entry("relations")
        .or_insert_with(|| json!([]))
        .as_array_mut()
        .unwrap();
    if let Some(existing) = relations
        .iter_mut()
        .find(|item| value_str(item, "id") == Some(id.as_str()))
    {
        *existing = relation;
    } else {
        relations.push(relation);
    }
    save_memory(&app, &profile).await?;
    Ok(id)
}

#[tauri::command]
async fn delete_memory_profile_relation(app: AppHandle, payload: Value) -> CommandResult<()> {
    let mut profile = load_memory(&app).await?;
    let id = value_str(&payload, "id").unwrap_or("");
    if let Some(relations) = profile.get_mut("relations").and_then(Value::as_array_mut) {
        relations.retain(|relation| value_str(relation, "id") != Some(id));
    }
    save_memory(&app, &profile).await
}

#[tauri::command]
async fn update_memory_avatar(app: AppHandle, request: Value) -> CommandResult<()> {
    let mut profile = load_memory(&app).await?;
    let mime_type = value_str(&request, "mimeType").unwrap_or("image/png");
    let bytes = request
        .get("bytes")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_u64)
                .map(|n| n as u8)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    profile.as_object_mut().unwrap().insert(
        "avatarDataUrl".into(),
        Value::String(format!(
            "data:{};base64,{}",
            mime_type,
            general_purpose::STANDARD.encode(bytes)
        )),
    );
    save_memory(&app, &profile).await
}

#[tauri::command]
async fn delete_memory_avatar(app: AppHandle) -> CommandResult<()> {
    let mut profile = load_memory(&app).await?;
    if let Some(object) = profile.as_object_mut() {
        object.remove("avatarDataUrl");
    }
    save_memory(&app, &profile).await
}

fn email_credential_value(address: &str) -> CommandResult<Option<Value>> {
    let Some(stored) = get_credential("email", &address.trim().to_lowercase())? else {
        return Ok(None);
    };
    match serde_json::from_str::<Value>(&stored) {
        Ok(value) => Ok(Some(value)),
        Err(_) => Ok(Some(json!({ "secret": stored }))),
    }
}

fn parsed_mail_text(parsed: &mailparse::ParsedMail<'_>) -> String {
    if parsed.subparts.is_empty() {
        return parsed.get_body().unwrap_or_default();
    }
    parsed
        .subparts
        .iter()
        .map(parsed_mail_text)
        .find(|text| !text.trim().is_empty())
        .unwrap_or_default()
}

async fn check_email_account(profile: Value) -> Value {
    let address = value_str(&profile, "address").unwrap_or("").to_string();
    let credential = match email_credential_value(&address) {
        Ok(Some(value)) => value,
        _ => {
            return json!({
                "account": address,
                "messages": [],
                "error": "长期记忆中缺少完整的 IMAP/SMTP 安全凭据"
            });
        }
    };
    let address_for_task = address.clone();
    let account_type = value_str(&profile, "type").unwrap_or("unknown").to_string();
    match tokio::task::spawn_blocking(move || -> Result<Vec<Value>, String> {
        let host = value_str(&credential, "imapHost")
            .ok_or("缺少 IMAP Host")?
            .to_string();
        let port = credential
            .get("imapPort")
            .and_then(Value::as_u64)
            .unwrap_or(993) as u16;
        let username = value_str(&credential, "username")
            .unwrap_or(&address_for_task)
            .to_string();
        let secret = value_str(&credential, "secret")
            .ok_or("缺少邮箱密钥")?
            .to_string();
        let tls = native_tls::TlsConnector::builder()
            .build()
            .map_err(|error| error.to_string())?;
        let client = imap::connect((host.as_str(), port), host.as_str(), &tls)
            .map_err(|error| error.to_string())?;
        let mut session = client
            .login(username, secret)
            .map_err(|(error, _)| error.to_string())?;
        session.select("INBOX").map_err(|error| error.to_string())?;
        let unseen = session
            .search("UNSEEN")
            .map_err(|error| error.to_string())?;
        let mut sequence_numbers = unseen.iter().copied().collect::<Vec<_>>();
        sequence_numbers.sort_unstable();
        let sequence_numbers = sequence_numbers
            .into_iter()
            .rev()
            .take(50)
            .map(|uid| uid.to_string())
            .collect::<Vec<_>>();
        if sequence_numbers.is_empty() {
            let _ = session.logout();
            return Ok(Vec::new());
        }
        let fetches = session
            .fetch(sequence_numbers.join(","), "RFC822")
            .map_err(|error| error.to_string())?;
        let mut messages = Vec::new();
        for fetch in fetches.iter() {
            let Some(body) = fetch.body() else {
                continue;
            };
            let parsed = mailparse::parse_mail(body).map_err(|error| error.to_string())?;
            let headers = parsed.get_headers();
            let subject = headers
                .get_first_value("Subject")
                .unwrap_or_else(|| "(无主题)".into());
            let from = headers
                .get_first_value("From")
                .unwrap_or_else(|| "未知发件人".into());
            let message_id = headers
                .get_first_value("Message-ID")
                .unwrap_or_else(|| format!("{}:{}", address_for_task, fetch.message));
            let text = parsed_mail_text(&parsed).replace(char::is_whitespace, " ");
            messages.push(json!({
                "id": format!("{}:{}", address_for_task, message_id),
                "accountAddress": address_for_task,
                "accountType": account_type,
                "sender": from,
                "senderEmail": "",
                "messageId": message_id,
                "subject": subject.trim(),
                "preview": text.chars().take(300).collect::<String>(),
                "content": text.chars().take(4000).collect::<String>(),
                "receivedAt": now_iso(),
                "unread": true,
                "processed": false
            }));
        }
        let _ = session.logout();
        Ok(messages)
    })
    .await
    {
        Ok(Ok(messages)) => json!({ "account": address, "messages": messages }),
        Ok(Err(error)) => json!({ "account": address, "messages": [], "error": error }),
        Err(error) => json!({ "account": address, "messages": [], "error": error.to_string() }),
    }
}

#[tauri::command]
async fn set_email_credential(app: AppHandle, request: Value) -> CommandResult<()> {
    let email = value_str(&request, "email")
        .ok_or_else(|| CommandError::Message("缺少邮箱地址。".into()))?
        .trim()
        .to_lowercase();
    if let Some(secret) = value_str(&request, "secret") {
        let stored = json!({
            "secret": secret,
            "username": value_str(&request, "username").unwrap_or(&email),
            "imapHost": value_str(&request, "imapHost").unwrap_or(""),
            "imapPort": request.get("imapPort").and_then(Value::as_u64).unwrap_or(993),
            "imapSecure": request.get("imapSecure").and_then(Value::as_bool).unwrap_or(true),
            "smtpHost": value_str(&request, "smtpHost").unwrap_or(""),
            "smtpPort": request.get("smtpPort").and_then(Value::as_u64).unwrap_or(465),
            "smtpSecure": request.get("smtpSecure").and_then(Value::as_bool).unwrap_or(true)
        });
        set_credential(CredentialSetRequest {
            scope: "email".into(),
            id: email.clone(),
            secret: stored.to_string(),
        })
        .await?;
    }
    let mut profile = load_memory(&app).await?;
    let email_record = json!({
        "address": email,
        "type": "unknown",
        "credentialConfigured": get_credential("email", &email)?.is_some(),
        "credentialType": value_str(&request, "credentialType").unwrap_or("password"),
        "username": value_str(&request, "username").unwrap_or(&email),
        "imapHost": value_str(&request, "imapHost").unwrap_or(""),
        "imapPort": request.get("imapPort").and_then(Value::as_u64).unwrap_or(993),
        "imapSecure": request.get("imapSecure").and_then(Value::as_bool).unwrap_or(true),
        "smtpHost": value_str(&request, "smtpHost").unwrap_or(""),
        "smtpPort": request.get("smtpPort").and_then(Value::as_u64).unwrap_or(465),
        "smtpSecure": request.get("smtpSecure").and_then(Value::as_bool).unwrap_or(true)
    });
    let emails = profile
        .as_object_mut()
        .unwrap()
        .entry("emails")
        .or_insert_with(|| json!([]))
        .as_array_mut()
        .unwrap();
    emails.retain(|item| value_str(item, "address") != Some(email.as_str()));
    emails.push(email_record);
    save_memory(&app, &profile).await
}

#[tauri::command]
async fn delete_email_credential(app: AppHandle, payload: Value) -> CommandResult<()> {
    let email = value_str(&payload, "email")
        .ok_or_else(|| CommandError::Message("缺少邮箱地址。".into()))?
        .trim()
        .to_lowercase();
    delete_credential(CredentialStatusRequest {
        scope: "email".into(),
        id: email.clone(),
    })
    .await?;
    let mut profile = load_memory(&app).await?;
    if let Some(emails) = profile.get_mut("emails").and_then(Value::as_array_mut) {
        emails.retain(|item| value_str(item, "address") != Some(email.as_str()));
    }
    save_memory(&app, &profile).await
}

#[tauri::command]
async fn check_all_email_accounts(app: AppHandle) -> CommandResult<Value> {
    let profile = load_memory(&app).await?;
    let accounts = profile
        .get("emails")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .cloned()
        .collect::<Vec<_>>();
    let checked_accounts = accounts
        .iter()
        .filter_map(|email| value_str(email, "address"))
        .map(ToOwned::to_owned)
        .collect::<Vec<_>>();
    let mut messages = Vec::new();
    let mut errors = Vec::new();
    for account in accounts {
        let result = check_email_account(account).await;
        messages.extend(
            result
                .get("messages")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default(),
        );
        if let Some(error) = value_str(&result, "error") {
            errors.push(json!({
                "accountAddress": value_str(&result, "account").unwrap_or(""),
                "message": error
            }));
        }
    }
    Ok(json!({
      "messages": messages,
      "checkedAccounts": checked_accounts,
      "errors": errors,
      "checkedAt": now_iso()
    }))
}

#[tauri::command]
async fn send_email(request: Value) -> CommandResult<Value> {
    let account = value_str(&request, "accountAddress")
        .unwrap_or("")
        .to_string();
    let credential = email_credential_value(&account)?.ok_or_else(|| {
        CommandError::Message(format!("邮箱 {} 未配置完整的 SMTP 凭据。", account))
    })?;
    let to = value_str(&request, "to").unwrap_or("").to_string();
    let subject = value_str(&request, "subject").unwrap_or("").to_string();
    let text = value_str(&request, "text").unwrap_or("").to_string();
    let message_id = tokio::task::spawn_blocking(move || -> Result<String, String> {
        use lettre::{
            message::Mailbox, transport::smtp::authentication::Credentials, Message, SmtpTransport,
            Transport,
        };
        let smtp_host = value_str(&credential, "smtpHost")
            .ok_or("缺少 SMTP Host")?
            .to_string();
        let smtp_port = credential
            .get("smtpPort")
            .and_then(Value::as_u64)
            .unwrap_or(465) as u16;
        let username = value_str(&credential, "username")
            .unwrap_or(&account)
            .to_string();
        let secret = value_str(&credential, "secret")
            .ok_or("缺少邮箱密钥")?
            .to_string();
        let email = Message::builder()
            .from(
                account
                    .parse::<Mailbox>()
                    .map_err(|error| error.to_string())?,
            )
            .to(to.parse::<Mailbox>().map_err(|error| error.to_string())?)
            .subject(subject)
            .body(text)
            .map_err(|error| error.to_string())?;
        let credentials = Credentials::new(username, secret);
        let mailer = SmtpTransport::relay(&smtp_host)
            .map_err(|error| error.to_string())?
            .port(smtp_port)
            .credentials(credentials)
            .build();
        let response = mailer.send(&email).map_err(|error| error.to_string())?;
        Ok(response.message().collect::<Vec<_>>().join(" "))
    })
    .await
    .map_err(|error| CommandError::Message(error.to_string()))?
    .map_err(CommandError::Message)?;
    Ok(json!({
        "messageId": if message_id.trim().is_empty() { format!("smtp-{}", now_millis_string()) } else { message_id },
        "accepted": [value_str(&request, "to").unwrap_or("")]
    }))
}

#[tauri::command]
async fn test_mcp_server(server: Value) -> CommandResult<Value> {
    let url = value_str(&server, "url")
        .ok_or_else(|| CommandError::Message("缺少 MCP Server URL。".into()))?;
    let response = reqwest::Client::new().get(url).send().await;
    match response {
        Ok(response) => Ok(json!({
            "serverInfo": { "name": value_str(&server, "name").unwrap_or("MCP Server"), "version": response.status().as_u16().to_string() },
            "tools": server.get("discoveredTools").cloned().unwrap_or_else(|| json!([]))
        })),
        Err(error) => Err(CommandError::Message(format!(
            "MCP Server 连接失败：{}",
            error
        ))),
    }
}

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            get_app_info,
            scan_workspace_files,
            read_workspace_file,
            extract_document,
            select_workspace_directory,
            select_skill_directory,
            import_skill_source,
            get_default_workspace_directory,
            load_workspace_content,
            save_workspace_content,
            save_knowledge_source,
            read_knowledge_source,
            index_knowledge_source,
            start_knowledge_extraction,
            copy_text,
            run_agent,
            approve_agent,
            cancel_agent,
            generate_topic_title,
            get_memory_greeting,
            get_memory_profile,
            update_memory_profile_fact,
            delete_memory_profile_fact,
            update_memory_profile_relation,
            delete_memory_profile_relation,
            update_memory_avatar,
            delete_memory_avatar,
            set_email_credential,
            delete_email_credential,
            check_all_email_accounts,
            send_email,
            set_credential,
            delete_credential,
            has_credential,
            list_provider_models,
            test_mcp_server
        ])
        .setup(|app| {
            let data_dir = app_data_directory(&app.handle())?;
            std::fs::create_dir_all(data_dir)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Emphant Studio Tauri application");
}
