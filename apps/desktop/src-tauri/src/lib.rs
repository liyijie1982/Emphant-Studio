use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use argon2::Argon2;
use base64::{engine::general_purpose, Engine as _};
use calamine::{open_workbook_auto_from_rs, Data, Reader};
use chrono::{Datelike, Local, Utc, Weekday};
use csv::ReaderBuilder;
use futures_util::StreamExt;
use mailparse::MailHeaderMap;
use rand::{rngs::OsRng, RngCore};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::{
    collections::{HashMap, HashSet},
    env,
    ffi::OsStr,
    io::Cursor,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager};
use thiserror::Error;
use tokio::{fs, io::AsyncWriteExt};
use tokio::{process::Command, time::timeout};
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
const MAX_EXTRACTED_LENGTH: usize = 1_000_000;
const MAX_COMMAND_OUTPUT_LENGTH: usize = 20_000;
const KNOWLEDGE_INDEX_SEGMENT_CHARS: usize = 10_000;
const KNOWLEDGE_INDEX_MAX_SEGMENTS: usize = 10;
const KNOWLEDGE_FALLBACK_CHUNK_CHARS: usize = 3_200;
const KNOWLEDGE_TABLE_MAX_ROWS: usize = 500;
const KNOWLEDGE_TABLE_MAX_COLUMNS: usize = 80;
const SECRET_VAULT_FILE: &str = "secrets.vault";
const SECRET_VAULT_VERSION: u8 = 1;

#[derive(Debug, Error)]
enum CommandError {
    #[error("{0}")]
    Message(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error("{0}")]
    Crypto(String),
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

struct PendingApproval {
    approved: bool,
    reason: Option<String>,
}

static PENDING_APPROVALS: OnceLock<
    Mutex<HashMap<String, tokio::sync::oneshot::Sender<PendingApproval>>>,
> = OnceLock::new();

fn pending_approvals(
) -> &'static Mutex<HashMap<String, tokio::sync::oneshot::Sender<PendingApproval>>> {
    PENDING_APPROVALS.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceScanPayload {
    query: String,
    limit: Option<usize>,
    workspace_directory: Option<String>,
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
#[serde(rename_all = "camelCase")]
struct SecretVaultUnlockRequest {
    password: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SecretVaultStatus {
    exists: bool,
    unlocked: bool,
    item_count: usize,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SecretVaultFile {
    version: u8,
    kdf: String,
    cipher: String,
    salt: String,
    nonce: String,
    ciphertext: String,
    item_keys: Vec<String>,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SecretVaultPlaintext {
    items: HashMap<String, SecretVaultItem>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SecretVaultItem {
    secret: String,
    updated_at: String,
}

#[derive(Clone)]
struct SecretVaultSession {
    key: [u8; 32],
    salt: String,
}

struct SecretVaultRuntime {
    path: PathBuf,
    session: Mutex<Option<SecretVaultSession>>,
}

static SECRET_VAULT_RUNTIME: OnceLock<SecretVaultRuntime> = OnceLock::new();

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

fn current_datetime_context() -> String {
    let local_now = Local::now();
    let weekday = match local_now.weekday() {
        Weekday::Mon => "星期一",
        Weekday::Tue => "星期二",
        Weekday::Wed => "星期三",
        Weekday::Thu => "星期四",
        Weekday::Fri => "星期五",
        Weekday::Sat => "星期六",
        Weekday::Sun => "星期日",
    };
    format!(
        "当前日期时间：{}（本机时区，UTC 偏移 {}）。今天是 {}，{}。当用户提到“今天”“明天”“昨天”“最近”“当前”“最新”等相对时间时，必须以这个日期和星期为基准；不要自行推算或改写星期几。如果问题依赖实时变化的信息，应明确需要联网或工具验证。",
        local_now.format("%Y-%m-%d %H:%M:%S"),
        local_now.format("%:z"),
        local_now.format("%Y-%m-%d"),
        weekday
    )
}

fn system_with_current_datetime(system: &str) -> String {
    [system, &current_datetime_context()]
        .into_iter()
        .filter(|part| !part.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n\n")
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

fn provider_access_type<'a>(provider: &'a Value) -> &'a str {
    value_str(provider, "accessType").unwrap_or_else(|| {
        match value_str(provider, "id").unwrap_or("") {
            "provider-ollama" => "ollama",
            "provider-anthropic" => "anthropic",
            _ => "openai-compatible",
        }
    })
}

fn truncate_log_text(text: &str, max_chars: usize) -> String {
    let mut truncated = text.chars().take(max_chars).collect::<String>();
    if text.chars().count() > max_chars {
        truncated.push_str("...");
    }
    truncated
}

fn log_agent_failure(
    run_id: &str,
    request: &Value,
    assistant: &Value,
    provider: &Value,
    model: &str,
    error: &CommandError,
) {
    eprintln!(
        "[agent-runtime] run failed run_id={} topic_id={} assistant_id={} assistant_name={} provider_id={} provider_name={} model={} error={}",
        run_id,
        value_str(request, "topicId").unwrap_or("unknown-topic"),
        value_str(assistant, "id").unwrap_or("unknown-assistant"),
        value_str(assistant, "name").unwrap_or("unknown-assistant"),
        value_str(provider, "id").unwrap_or("unknown-provider"),
        value_str(provider, "name").unwrap_or("unknown-provider"),
        if model.trim().is_empty() { "unknown-model" } else { model },
        error
    );
}

fn validate_agent_configuration(
    provider: &Value,
    assistant: &Value,
    model: &str,
) -> CommandResult<()> {
    let assistant_name = value_str(assistant, "name").unwrap_or("当前 Agent");
    if value_str(provider, "id").is_none() {
        return Err(CommandError::Message(format!(
            "{} 的模型配置不完整：未选择可用 Provider。",
            assistant_name
        )));
    }
    if model.trim().is_empty() {
        return Err(CommandError::Message(format!(
            "{} 的模型配置不完整：未选择模型。",
            assistant_name
        )));
    }
    if value_str(provider, "baseUrl").is_none() {
        return Err(CommandError::Message(format!(
            "{} 的 Provider 配置不完整：未填写 Base URL。",
            value_str(provider, "name").unwrap_or("当前 Provider")
        )));
    }
    Ok(())
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

fn should_autosave_generated_content(prompt: &str) -> bool {
    let text = prompt.to_ascii_lowercase();
    let explicit_phrases = [
        "生成文件",
        "创建文件",
        "保存文件",
        "写入文件",
        "落盘",
        "另存为",
        "保存为",
        "导出",
        "生成脚本",
        "写个脚本",
        "写一个脚本",
        "创建脚本",
        "生成文档",
        "创建文档",
        "生成报告",
        "创建报告",
        "save as",
        "save to",
        "write to",
        "create file",
        "generate file",
        "export",
        "create a script",
        "generate a script",
        "write a script",
        "create a document",
        "generate a document",
        "create a report",
        "generate a report",
    ];
    if explicit_phrases.iter().any(|needle| text.contains(needle)) {
        return true;
    }

    let has_artifact_action = [
        "生成", "创建", "保存", "写入", "导出", "generate", "create", "save", "export",
    ]
    .iter()
    .any(|needle| text.contains(needle));
    let has_artifact_noun = [
        ".sh",
        ".py",
        ".js",
        ".ts",
        ".tsx",
        ".md",
        ".json",
        ".yaml",
        ".yml",
        ".sql",
        ".html",
        ".css",
        "脚本文件",
        "文档文件",
        "报告文件",
        "markdown 文件",
        "json 文件",
        "yaml 文件",
        "shell script",
        "markdown file",
        "json file",
        "yaml file",
    ]
    .iter()
    .any(|needle| text.contains(needle));

    has_artifact_action && has_artifact_noun
}

fn extract_generated_files(prompt: &str, answer: &str) -> Vec<(PathBuf, String)> {
    let autosave = should_autosave_generated_content(prompt);
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
        let mut end = MAX_EXTRACTED_LENGTH;
        while !value.is_char_boundary(end) {
            end -= 1;
        }
        format!("{}\n\n...正文已截断", &value[..end])
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

fn secret_vault_runtime() -> CommandResult<&'static SecretVaultRuntime> {
    SECRET_VAULT_RUNTIME
        .get()
        .ok_or_else(|| CommandError::Message("安全保险箱尚未初始化。".into()))
}

fn read_secret_vault_file() -> CommandResult<Option<SecretVaultFile>> {
    let runtime = secret_vault_runtime()?;
    if !runtime.path.exists() {
        return Ok(None);
    }
    let text = std::fs::read_to_string(&runtime.path)?;
    Ok(Some(serde_json::from_str(&text)?))
}

fn write_secret_vault_file(file: &SecretVaultFile) -> CommandResult<()> {
    let runtime = secret_vault_runtime()?;
    if let Some(parent) = runtime.path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(
        &runtime.path,
        format!("{}\n", serde_json::to_string_pretty(file)?),
    )?;
    Ok(())
}

fn random_bytes<const N: usize>() -> [u8; N] {
    let mut bytes = [0_u8; N];
    OsRng.fill_bytes(&mut bytes);
    bytes
}

fn decode_base64(value: &str) -> CommandResult<Vec<u8>> {
    general_purpose::STANDARD
        .decode(value)
        .map_err(|error| CommandError::Crypto(error.to_string()))
}

fn derive_secret_vault_key(password: &str, salt: &[u8]) -> CommandResult<[u8; 32]> {
    let mut key = [0_u8; 32];
    Argon2::default()
        .hash_password_into(password.as_bytes(), salt, &mut key)
        .map_err(|error| CommandError::Crypto(error.to_string()))?;
    Ok(key)
}

fn encrypt_secret_vault_plaintext(
    key: &[u8; 32],
    salt: &str,
    plaintext: &SecretVaultPlaintext,
    existing: Option<&SecretVaultFile>,
) -> CommandResult<SecretVaultFile> {
    let nonce = random_bytes::<12>();
    let cipher =
        Aes256Gcm::new_from_slice(key).map_err(|error| CommandError::Crypto(error.to_string()))?;
    let bytes = serde_json::to_vec(plaintext)?;
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(&nonce), bytes.as_ref())
        .map_err(|error| CommandError::Crypto(error.to_string()))?;
    let now = now_iso();
    let mut item_keys = plaintext.items.keys().cloned().collect::<Vec<_>>();
    item_keys.sort();
    Ok(SecretVaultFile {
        version: SECRET_VAULT_VERSION,
        kdf: "argon2id".into(),
        cipher: "aes-256-gcm".into(),
        salt: existing
            .map(|file| file.salt.clone())
            .unwrap_or_else(|| salt.to_string()),
        nonce: general_purpose::STANDARD.encode(nonce),
        ciphertext: general_purpose::STANDARD.encode(ciphertext),
        item_keys,
        created_at: existing
            .map(|file| file.created_at.clone())
            .unwrap_or_else(|| now.clone()),
        updated_at: now,
    })
}

fn decrypt_secret_vault_plaintext(
    file: &SecretVaultFile,
    key: &[u8; 32],
) -> CommandResult<SecretVaultPlaintext> {
    if file.version != SECRET_VAULT_VERSION {
        return Err(CommandError::Crypto("不支持的安全保险箱版本。".into()));
    }
    let nonce = decode_base64(&file.nonce)?;
    let ciphertext = decode_base64(&file.ciphertext)?;
    let cipher =
        Aes256Gcm::new_from_slice(key).map_err(|error| CommandError::Crypto(error.to_string()))?;
    let plaintext = cipher
        .decrypt(Nonce::from_slice(&nonce), ciphertext.as_ref())
        .map_err(|_| CommandError::Crypto("主密码不正确或安全保险箱已损坏。".into()))?;
    Ok(serde_json::from_slice(&plaintext)?)
}

fn current_secret_vault_session() -> CommandResult<SecretVaultSession> {
    let runtime = secret_vault_runtime()?;
    let guard = runtime
        .session
        .lock()
        .map_err(|_| CommandError::Message("安全保险箱状态锁定失败。".into()))?;
    guard
        .clone()
        .ok_or_else(|| CommandError::Message("请先输入主密码解锁安全保险箱。".into()))
}

fn save_secret_vault_plaintext(plaintext: &SecretVaultPlaintext) -> CommandResult<()> {
    let session = current_secret_vault_session()?;
    let existing = read_secret_vault_file()?;
    let file =
        encrypt_secret_vault_plaintext(&session.key, &session.salt, plaintext, existing.as_ref())?;
    write_secret_vault_file(&file)
}

fn load_secret_vault_plaintext() -> CommandResult<SecretVaultPlaintext> {
    let session = current_secret_vault_session()?;
    let Some(file) = read_secret_vault_file()? else {
        return Ok(SecretVaultPlaintext {
            items: HashMap::new(),
        });
    };
    decrypt_secret_vault_plaintext(&file, &session.key)
}

fn get_credential(scope: &str, id: &str) -> CommandResult<Option<String>> {
    let plaintext = load_secret_vault_plaintext()?;
    Ok(plaintext
        .items
        .get(&credential_key(scope, id))
        .map(|item| item.secret.clone())
        .filter(|value| !value.is_empty()))
}

fn has_credential_marker(scope: &str, id: &str) -> CommandResult<bool> {
    let key = credential_key(scope, id);
    if let Some(file) = read_secret_vault_file()? {
        return Ok(file.item_keys.iter().any(|item| item == &key));
    }
    Ok(false)
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
    let access_type = provider_access_type(provider);
    let base_url = value_str(provider, "baseUrl")
        .unwrap_or("")
        .trim_end_matches('/');
    let client = reqwest::Client::new();
    let mut models = Vec::new();

    if access_type == "ollama" {
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
        let request = if access_type == "anthropic" {
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
                        "以下是当前助手已挂载知识库中检索到的原文证据和知识图谱线索。请优先依据这些内容回答；如果证据不足，请明确说明哪些结论缺少知识库支持，不要忽略这些上下文：\n{}",
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

fn assistant_tool_enabled(assistant: &Value, tool_id: &str) -> bool {
    assistant
        .get("enabledToolIds")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .any(|id| id.as_str() == Some(tool_id))
}

fn request_tool_enabled(request: &Value, assistant: &Value, tool_id: &str) -> bool {
    if !assistant_tool_enabled(assistant, tool_id) {
        return false;
    }
    request
        .get("enabledTools")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .any(|tool| value_str(tool, "id") == Some(tool_id))
}

fn runtime_tool_enabled(request: &Value, assistant: &Value) -> bool {
    request_tool_enabled(request, assistant, "tool-shell-command")
        || request_tool_enabled(request, assistant, "tool-search")
}

fn shell_command_tool_definition() -> Value {
    json!({
        "type": "function",
        "function": {
            "name": "run_command",
            "description": "在当前 Emphant Studio 工作区内执行低风险、非交互的 shell 命令，并返回 stdout、stderr 和退出码。适合 pwd、ls、rg、git status、docker ps、df -h 等检查命令。",
            "parameters": {
                "type": "object",
                "properties": {
                    "command": {
                        "type": "string",
                        "description": "要执行的完整 shell 命令。命令会通过 sh -lc 在工作区目录中运行。"
                    },
                    "timeoutSeconds": {
                        "type": "integer",
                        "description": "超时时间，1 到 30 秒，默认 30 秒。",
                        "minimum": 1,
                        "maximum": 30
                    }
                },
                "required": ["command"],
                "additionalProperties": false
            }
        }
    })
}

fn web_search_tool_definition() -> Value {
    json!({
        "type": "function",
        "function": {
            "name": "web_search",
            "description": "联网检索实时网页或新闻信息，返回标题、摘要、链接、来源和发布时间。适合今日新闻、最新政策、版本、价格、赛事、实时资料等问题。",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "搜索关键词。需要包含用户关心的主题，例如“今日新闻 中国 科技”。"
                    },
                    "limit": {
                        "type": "integer",
                        "description": "返回结果数量，1 到 10，默认 6。",
                        "minimum": 1,
                        "maximum": 10
                    },
                    "scope": {
                        "type": "string",
                        "description": "搜索范围。news 用于新闻，web 用于通用网页；默认 news。",
                        "enum": ["news", "web"]
                    }
                },
                "required": ["query"],
                "additionalProperties": false
            }
        }
    })
}

fn ssh_command_tool_definition() -> Value {
    json!({
        "type": "function",
        "function": {
            "name": "run_ssh_command",
            "description": "通过本机 ssh/sshpass 对远程 Linux 主机执行低风险、只读的非交互命令，并返回 stdout、stderr 和退出码。适合 df -h、uptime、docker ps、systemctl status 等巡检命令。密码只作为进程环境变量传递，不会展示给用户或写入结果。",
            "parameters": {
                "type": "object",
                "properties": {
                    "host": {
                        "type": "string",
                        "description": "远程主机 IP 或域名。"
                    },
                    "user": {
                        "type": "string",
                        "description": "SSH 用户名。"
                    },
                    "password": {
                        "type": "string",
                        "description": "SSH 密码。仅用于本次连接，工具事件会脱敏。"
                    },
                    "command": {
                        "type": "string",
                        "description": "要在远程主机执行的低风险只读命令，例如 df -h。"
                    },
                    "timeoutSeconds": {
                        "type": "integer",
                        "description": "超时时间，1 到 60 秒，默认 60 秒。",
                        "minimum": 1,
                        "maximum": 60
                    }
                },
                "required": ["host", "user", "command"],
                "additionalProperties": false
            }
        }
    })
}

fn truncate_output(text: &str, limit: usize) -> String {
    if text.len() <= limit {
        return text.to_string();
    }
    let mut truncated = text
        .chars()
        .take(limit.saturating_sub(80))
        .collect::<String>();
    truncated.push_str("\n\n[输出已截断]");
    truncated
}

fn command_risk_reason(command: &str) -> Option<String> {
    let lower = command.to_lowercase();
    let blocked_fragments = [
        "sudo ",
        " su ",
        "rm ",
        "rm\t",
        "rm -",
        "rmdir ",
        "mv ",
        "cp ",
        "chmod ",
        "chown ",
        "dd ",
        "mkfs",
        "mount ",
        "umount ",
        "kill ",
        "pkill ",
        "reboot",
        "shutdown",
        "launchctl ",
        "systemctl restart",
        "systemctl stop",
        "brew install",
        "apt install",
        "apt-get install",
        "yum install",
        "dnf install",
        "pip install",
        "npm install",
        "pnpm install",
        "yarn add",
        "git push",
        "git commit",
        ">",
        ">>",
        "| tee ",
    ];
    blocked_fragments
        .iter()
        .find(|fragment| lower.contains(**fragment))
        .map(|fragment| format!("命令包含需要用户确认的高风险片段：{}", fragment.trim()))
}

fn tool_approval_reason(tool_name: &str, arguments: &Value) -> Option<String> {
    let normalized_name = tool_name.to_lowercase();
    if matches!(tool_name, "run_command" | "run_ssh_command") {
        return Some("工具将执行本地或远程命令。出于安全考虑，需要用户明确授权后才能继续。".into());
    }

    let high_risk_name_fragments = [
        "write",
        "edit",
        "delete",
        "remove",
        "send_mail",
        "send_email",
        "database",
        "sql",
        "insert",
        "update",
        "upsert",
        "drop",
        "truncate",
    ];
    if let Some(fragment) = high_risk_name_fragments
        .iter()
        .find(|fragment| normalized_name.contains(**fragment))
    {
        return Some(format!(
            "工具名称包含高风险动作“{}”，执行前需要用户确认目标资源和参数。",
            fragment
        ));
    }

    let argument_text = arguments.to_string().to_lowercase();
    let high_risk_argument_fragments = [
        "\"delete\"",
        "\"remove\"",
        "\"write\"",
        "\"update\"",
        "\"insert\"",
        "\"drop\"",
        "\"truncate\"",
        " rm ",
        " rm -",
        "sudo ",
        "chmod ",
        "chown ",
        "git push",
    ];
    high_risk_argument_fragments
        .iter()
        .find(|fragment| argument_text.contains(**fragment))
        .map(|fragment| {
            format!(
                "工具参数包含需要确认的高风险动作片段：{}。",
                fragment.trim_matches('"').trim()
            )
        })
}

fn approval_key(run_id: &str, approval_id: &str) -> String {
    format!("{}:{}", run_id, approval_id)
}

async fn request_tool_approval(
    app: &AppHandle,
    run_id: &str,
    tool_call_id: &str,
    tool_name: &str,
    input: &Value,
    reason: &str,
) -> CommandResult<PendingApproval> {
    let approval_id = format!("approval-{}", uuid::Uuid::new_v4());
    let key = approval_key(run_id, &approval_id);
    let (sender, receiver) = tokio::sync::oneshot::channel();
    {
        let mut pending = pending_approvals()
            .lock()
            .map_err(|_| CommandError::Message("工具审批状态锁定失败。".into()))?;
        pending.insert(key.clone(), sender);
    }

    let _ = app.emit(
        "agent:event",
        json!({
            "runId": run_id,
            "type": "approval-request",
            "approvalId": approval_id,
            "toolCallId": tool_call_id,
            "toolName": tool_name,
            "input": redact_sensitive_json(input),
            "evaluation": {
                "decision": "ask",
                "risk": "high",
                "reason": reason
            }
        }),
    );

    match timeout(std::time::Duration::from_secs(300), receiver).await {
        Ok(Ok(decision)) => Ok(decision),
        Ok(Err(_)) => Err(CommandError::Message("工具审批通道已关闭。".into())),
        Err(_) => {
            if let Ok(mut pending) = pending_approvals().lock() {
                pending.remove(&key);
            }
            Err(CommandError::Message("工具审批超时，已取消执行。".into()))
        }
    }
}

fn redact_sensitive_text(text: &str) -> String {
    let mut redacted = text.to_string();
    for marker in ["sshpass -p ", "SSHPASS=", "password=", "PASSWORD="] {
        while let Some(start) = redacted.find(marker) {
            let value_start = start + marker.len();
            let value_end = redacted[value_start..]
                .find(char::is_whitespace)
                .map(|index| value_start + index)
                .unwrap_or(redacted.len());
            redacted.replace_range(value_start..value_end, "******");
        }
    }
    redacted
}

fn redact_sensitive_json(value: &Value) -> Value {
    match value {
        Value::Object(object) => Value::Object(
            object
                .iter()
                .map(|(key, value)| {
                    let lower_key = key.to_ascii_lowercase();
                    let redacted_value = if lower_key.contains("password")
                        || lower_key.contains("passwd")
                        || lower_key.contains("secret")
                        || lower_key.contains("token")
                        || lower_key.contains("key")
                    {
                        Value::String("******".into())
                    } else {
                        redact_sensitive_json(value)
                    };
                    (key.clone(), redacted_value)
                })
                .collect(),
        ),
        Value::Array(items) => Value::Array(items.iter().map(redact_sensitive_json).collect()),
        Value::String(text) => Value::String(redact_sensitive_text(text)),
        _ => value.clone(),
    }
}

async fn execute_workspace_command(workspace: &Path, input: &Value) -> Value {
    let command = value_str(input, "command").unwrap_or("").trim();
    if command.is_empty() {
        return json!({
            "ok": false,
            "error": "缺少 command 参数。"
        });
    }
    if let Some(reason) = command_risk_reason(command) {
        return json!({
            "ok": false,
            "blocked": true,
            "risk": "high",
            "reason": reason,
            "command": command
        });
    }
    let timeout_seconds = input
        .get("timeoutSeconds")
        .and_then(Value::as_u64)
        .unwrap_or(30)
        .clamp(1, 30);

    let mut child = Command::new("sh");
    child
        .arg("-lc")
        .arg(command)
        .current_dir(workspace)
        .kill_on_drop(true);

    match timeout(
        std::time::Duration::from_secs(timeout_seconds),
        child.output(),
    )
    .await
    {
        Ok(Ok(output)) => {
            let stdout = String::from_utf8_lossy(&output.stdout).to_string();
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
            json!({
                "ok": output.status.success(),
                "command": command,
                "cwd": workspace.to_string_lossy(),
                "exitCode": output.status.code(),
                "stdout": truncate_output(&stdout, MAX_COMMAND_OUTPUT_LENGTH),
                "stderr": truncate_output(&stderr, MAX_COMMAND_OUTPUT_LENGTH),
                "timedOut": false
            })
        }
        Ok(Err(error)) => json!({
            "ok": false,
            "command": command,
            "cwd": workspace.to_string_lossy(),
            "error": error.to_string(),
            "timedOut": false
        }),
        Err(_) => json!({
            "ok": false,
            "command": command,
            "cwd": workspace.to_string_lossy(),
            "error": format!("命令执行超过 {} 秒，已终止。", timeout_seconds),
            "timedOut": true
        }),
    }
}

async fn execute_ssh_command(input: &Value) -> Value {
    let host = value_str(input, "host").unwrap_or("").trim();
    let user = value_str(input, "user").unwrap_or("").trim();
    let password = value_str(input, "password").unwrap_or("");
    let remote_command = value_str(input, "command").unwrap_or("").trim();
    if host.is_empty() || user.is_empty() || remote_command.is_empty() {
        return json!({
            "ok": false,
            "error": "缺少 host、user 或 command 参数。"
        });
    }
    if let Some(reason) = command_risk_reason(remote_command) {
        return json!({
            "ok": false,
            "blocked": true,
            "risk": "high",
            "reason": reason,
            "host": host,
            "user": user,
            "command": remote_command
        });
    }
    let timeout_seconds = input
        .get("timeoutSeconds")
        .and_then(Value::as_u64)
        .unwrap_or(60)
        .clamp(1, 60);

    let output_result = if password.is_empty() {
        let mut command = Command::new("ssh");
        command.arg("-o").arg("BatchMode=yes");
        command
            .arg("-o")
            .arg("ConnectTimeout=10")
            .arg("-o")
            .arg("StrictHostKeyChecking=accept-new")
            .arg("-o")
            .arg("UserKnownHostsFile=/dev/null")
            .arg("-o")
            .arg("LogLevel=ERROR")
            .arg(format!("{}@{}", user, host))
            .arg("sh")
            .arg("-lc")
            .arg(remote_command)
            .kill_on_drop(true);
        timeout(
            std::time::Duration::from_secs(timeout_seconds),
            command.output(),
        )
        .await
    } else {
        let mut command = Command::new("sshpass");
        command
            .arg("-e")
            .arg("ssh")
            .env("SSHPASS", password)
            .arg("-o")
            .arg("ConnectTimeout=10")
            .arg("-o")
            .arg("StrictHostKeyChecking=accept-new")
            .arg("-o")
            .arg("UserKnownHostsFile=/dev/null")
            .arg("-o")
            .arg("LogLevel=ERROR")
            .arg(format!("{}@{}", user, host))
            .arg("sh")
            .arg("-lc")
            .arg(remote_command)
            .kill_on_drop(true);
        let sshpass_result = timeout(
            std::time::Duration::from_secs(timeout_seconds),
            command.output(),
        )
        .await;
        match sshpass_result {
            Ok(Err(error)) if error.kind() == std::io::ErrorKind::NotFound => {
                run_expect_ssh_command(host, user, password, remote_command, timeout_seconds).await
            }
            other => other,
        }
    };

    match output_result {
        Ok(Ok(output)) => {
            let stdout = String::from_utf8_lossy(&output.stdout).to_string();
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
            json!({
                "ok": output.status.success(),
                "host": host,
                "user": user,
                "command": remote_command,
                "exitCode": output.status.code(),
                "stdout": truncate_output(&stdout, MAX_COMMAND_OUTPUT_LENGTH),
                "stderr": truncate_output(&stderr, MAX_COMMAND_OUTPUT_LENGTH),
                "timedOut": false
            })
        }
        Ok(Err(error)) => json!({
            "ok": false,
            "host": host,
            "user": user,
            "command": remote_command,
            "error": error.to_string(),
            "timedOut": false
        }),
        Err(_) => json!({
            "ok": false,
            "host": host,
            "user": user,
            "command": remote_command,
            "error": format!("SSH 命令执行超过 {} 秒，已终止。", timeout_seconds),
            "timedOut": true
        }),
    }
}

async fn run_expect_ssh_command(
    host: &str,
    user: &str,
    password: &str,
    remote_command: &str,
    timeout_seconds: u64,
) -> Result<Result<std::process::Output, std::io::Error>, tokio::time::error::Elapsed> {
    let script = r#"
set timeout $env(SSH_TIMEOUT)
spawn -noecho ssh -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR $env(SSH_TARGET) sh -lc $env(SSH_REMOTE_COMMAND)
expect {
    -re "(?i)yes/no" {
        send -- "yes\r"
        exp_continue
    }
    -re "(?i)password:" {
        send -- "$env(SSH_PASSWORD)\r"
        exp_continue
    }
    timeout {
        exit 124
    }
    eof
}
catch wait result
exit [lindex $result 3]
"#;
    let mut command = Command::new("expect");
    command
        .arg("-f")
        .arg("-")
        .env("SSH_TARGET", format!("{}@{}", user, host))
        .env("SSH_PASSWORD", password)
        .env("SSH_REMOTE_COMMAND", remote_command)
        .env("SSH_TIMEOUT", timeout_seconds.to_string())
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    match command.spawn() {
        Ok(mut child) => {
            if let Some(mut stdin) = child.stdin.take() {
                if let Err(error) = stdin.write_all(script.as_bytes()).await {
                    return Ok(Err(error));
                }
            }
            timeout(
                std::time::Duration::from_secs(timeout_seconds),
                child.wait_with_output(),
            )
            .await
        }
        Err(error) => Ok(Err(error)),
    }
}

fn percent_encode_query(value: &str) -> String {
    value
        .bytes()
        .flat_map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                vec![byte as char]
            }
            b' ' => vec!['+'],
            _ => format!("%{:02X}", byte).chars().collect::<Vec<_>>(),
        })
        .collect()
}

fn xml_unescape(value: &str) -> String {
    value
        .replace("<![CDATA[", "")
        .replace("]]>", "")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .trim()
        .to_string()
}

fn strip_html_tags(value: &str) -> String {
    let mut output = String::new();
    let mut in_tag = false;
    for ch in value.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => output.push(ch),
            _ => {}
        }
    }
    output.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn xml_tag_text(item: &str, tag: &str) -> String {
    let close = format!("</{}>", tag);
    let open_exact = format!("<{}>", tag);
    let open_with_attrs = format!("<{} ", tag);
    item.find(&open_exact)
        .or_else(|| item.find(&open_with_attrs))
        .and_then(|start| {
            let open_end = item[start..].find('>')?;
            let content_start = start + open_end + 1;
            item[content_start..]
                .find(&close)
                .map(|end| &item[content_start..content_start + end])
        })
        .map(xml_unescape)
        .unwrap_or_default()
}

fn parse_search_rss(xml: &str, limit: usize) -> Vec<Value> {
    xml.split("<item>")
        .skip(1)
        .filter_map(|part| part.split("</item>").next())
        .filter_map(|item| {
            let title = xml_tag_text(item, "title");
            let url = xml_tag_text(item, "link");
            if title.trim().is_empty() || url.trim().is_empty() {
                return None;
            }
            let description = strip_html_tags(&xml_tag_text(item, "description"));
            let published_at = xml_tag_text(item, "pubDate");
            let source = xml_tag_text(item, "source");
            Some(json!({
                "title": title,
                "url": url,
                "snippet": description,
                "source": if source.is_empty() { "Bing" } else { source.as_str() },
                "publishedAt": published_at
            }))
        })
        .take(limit)
        .collect()
}

async fn execute_web_search(arguments: &Value) -> Value {
    let query = value_str(arguments, "query").unwrap_or("").trim();
    if query.is_empty() {
        return json!({
            "ok": false,
            "error": "缺少搜索关键词。"
        });
    }

    let limit = arguments
        .get("limit")
        .and_then(Value::as_u64)
        .unwrap_or(6)
        .clamp(1, 10) as usize;
    let scope = value_str(arguments, "scope").unwrap_or("news");
    let endpoint = if scope == "web" {
        format!(
            "https://www.bing.com/search?q={}&format=rss&setlang=zh-CN&cc=CN",
            percent_encode_query(query)
        )
    } else {
        format!(
            "https://news.google.com/rss/search?q={}&hl=zh-CN&gl=CN&ceid=CN:zh-Hans",
            percent_encode_query(query)
        )
    };

    let response = reqwest::Client::new()
        .get(&endpoint)
        .header(
            reqwest::header::USER_AGENT,
            "Emphant Studio/0.1 (+https://emphant.local)",
        )
        .send()
        .await;
    let Ok(response) = response else {
        return json!({
            "ok": false,
            "query": query,
            "error": "联网搜索请求失败。"
        });
    };
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return json!({
            "ok": false,
            "query": query,
            "error": format!("联网搜索请求失败：HTTP {}", status),
            "responsePreview": truncate_log_text(&text, 500)
        });
    }

    json!({
        "ok": true,
        "query": query,
        "scope": scope,
        "searchedAt": current_datetime_context(),
        "results": parse_search_rss(&text, limit)
    })
}

async fn run_agent_tool_call(
    app: &AppHandle,
    run_id: &str,
    workspace: &Path,
    tool_call: &Value,
) -> Value {
    let tool_call_id = value_str(tool_call, "id").unwrap_or("tool-call");
    let function = tool_call.get("function").unwrap_or(&Value::Null);
    let tool_name = value_str(function, "name").unwrap_or("tool");
    let arguments_text = value_str(function, "arguments").unwrap_or("{}");
    let arguments = serde_json::from_str::<Value>(arguments_text).unwrap_or_else(|_| json!({}));
    let safe_arguments = redact_sensitive_json(&arguments);
    let _ = app.emit(
        "agent:event",
        json!({
            "runId": run_id,
            "type": "tool-input",
            "toolCallId": tool_call_id,
            "toolName": tool_name,
            "input": safe_arguments
        }),
    );

    if let Some(approval_reason) = tool_approval_reason(tool_name, &arguments) {
        let approval = request_tool_approval(
            app,
            run_id,
            tool_call_id,
            tool_name,
            &arguments,
            &approval_reason,
        )
        .await;

        match approval {
            Ok(decision) if decision.approved => {}
            Ok(decision) => {
                let output = json!({
                    "ok": false,
                    "denied": true,
                    "error": decision.reason.unwrap_or_else(|| "用户拒绝执行该工具调用。".into())
                });
                let _ = app.emit(
                    "agent:event",
                    json!({
                        "runId": run_id,
                        "type": "tool-output",
                        "toolCallId": tool_call_id,
                        "output": output
                    }),
                );
                return output;
            }
            Err(error) => {
                let output = json!({
                    "ok": false,
                    "denied": true,
                    "error": error.to_string()
                });
                let _ = app.emit(
                    "agent:event",
                    json!({
                        "runId": run_id,
                        "type": "tool-output",
                        "toolCallId": tool_call_id,
                        "output": output
                    }),
                );
                return output;
            }
        }
    }

    let output = match tool_name {
        "run_command" => execute_workspace_command(workspace, &arguments).await,
        "run_ssh_command" => execute_ssh_command(&arguments).await,
        "web_search" => execute_web_search(&arguments).await,
        _ => json!({
            "ok": false,
            "error": format!("未知工具：{}", tool_name)
        }),
    };
    let safe_output = redact_sensitive_json(&output);
    let _ = app.emit(
        "agent:event",
        json!({
            "runId": run_id,
            "type": "tool-output",
            "toolCallId": tool_call_id,
            "output": safe_output
        }),
    );
    output
}

async fn chat_completion(
    provider: &Value,
    model: &str,
    system: &str,
    messages: Vec<Value>,
) -> CommandResult<String> {
    let system = system_with_current_datetime(system);
    let provider_id = value_str(provider, "id").unwrap_or("");
    let access_type = provider_access_type(provider);
    let base_url = value_str(provider, "baseUrl")
        .unwrap_or("")
        .trim_end_matches('/');
    let client = reqwest::Client::new();

    if access_type == "ollama" {
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

    if access_type == "anthropic" {
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

fn number_array(value: Option<&Value>) -> Vec<f64> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_f64)
        .collect()
}

async fn embedding_vectors(
    provider: &Value,
    model: &str,
    texts: Vec<String>,
) -> CommandResult<Vec<Vec<f64>>> {
    if texts.is_empty() {
        return Ok(Vec::new());
    }
    let provider_id = value_str(provider, "id").unwrap_or("");
    let access_type = provider_access_type(provider);
    let base_url = value_str(provider, "baseUrl")
        .unwrap_or("")
        .trim_end_matches('/');
    let client = reqwest::Client::new();

    if access_type == "ollama" {
        let data: Value = client
            .post(format!("{}/api/embed", base_url))
            .json(&json!({ "model": model, "input": texts }))
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        let embeddings = data
            .get("embeddings")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .map(|item| number_array(Some(item)))
            .filter(|embedding| !embedding.is_empty())
            .collect::<Vec<_>>();
        if !embeddings.is_empty() {
            return Ok(embeddings);
        }
        return Ok(vec![number_array(data.get("embedding"))]);
    }

    let api_key = get_credential("provider", provider_id)?.ok_or_else(|| {
        CommandError::Message(format!(
            "{} 尚未配置安全凭据。",
            value_str(provider, "name").unwrap_or("Provider")
        ))
    })?;
    let data: Value = client
        .post(format!("{}/embeddings", base_url))
        .bearer_auth(api_key)
        .json(&json!({ "model": model, "input": texts }))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    Ok(data
        .get("data")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|item| number_array(item.get("embedding")))
        .collect())
}

async fn rerank_scores(
    provider: &Value,
    model: &str,
    query: &str,
    documents: Vec<String>,
) -> CommandResult<Vec<f64>> {
    if documents.is_empty() {
        return Ok(Vec::new());
    }
    let provider_id = value_str(provider, "id").unwrap_or("");
    let access_type = provider_access_type(provider);
    if access_type == "ollama" {
        return Err(CommandError::Message(
            "Ollama 暂未提供通用 rerank 接口。".into(),
        ));
    }
    let base_url = value_str(provider, "baseUrl")
        .unwrap_or("")
        .trim_end_matches('/');
    let api_key = get_credential("provider", provider_id)?.ok_or_else(|| {
        CommandError::Message(format!(
            "{} 尚未配置安全凭据。",
            value_str(provider, "name").unwrap_or("Provider")
        ))
    })?;
    let data: Value = reqwest::Client::new()
        .post(format!("{}/rerank", base_url))
        .bearer_auth(api_key)
        .json(&json!({
            "model": model,
            "query": query,
            "documents": documents,
            "top_n": documents.len()
        }))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    let mut scores = vec![0.0; documents.len()];
    for (fallback_index, item) in data
        .get("results")
        .or_else(|| data.get("data"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .enumerate()
    {
        let index = item
            .get("index")
            .and_then(Value::as_u64)
            .map(|value| value as usize)
            .unwrap_or(fallback_index);
        let score = item
            .get("relevance_score")
            .or_else(|| item.get("score"))
            .and_then(Value::as_f64)
            .unwrap_or(0.0);
        if let Some(slot) = scores.get_mut(index) {
            *slot = score;
        }
    }
    Ok(scores)
}

fn is_dashscope_provider(provider: &Value) -> bool {
    let provider_id = value_str(provider, "id").unwrap_or("");
    let base_url = value_str(provider, "baseUrl").unwrap_or("").to_lowercase();
    provider_id == "provider-qwen"
        || base_url.contains("dashscope.aliyuncs.com")
        || base_url.contains("maas.aliyuncs.com")
}

fn is_dashscope_inline_audio_model(model: &str) -> bool {
    let normalized = model.to_lowercase();
    normalized.starts_with("fun-asr-flash") || normalized.starts_with("fun-asr-realtime")
}

fn is_dashscope_tts_model(model: &str) -> bool {
    let normalized = model.to_lowercase();
    normalized.contains("tts")
        || normalized.starts_with("cosyvoice")
        || normalized.starts_with("minimax/speech")
}

fn dashscope_generation_endpoint(base_url: &str) -> String {
    let mut root = base_url.trim_end_matches('/').to_string();
    for suffix in ["/compatible-mode/v1", "/compatible-mode", "/api/v1"] {
        if root.ends_with(suffix) {
            let end = root.len() - suffix.len();
            root.truncate(end);
            break;
        }
    }
    if root.ends_with("/api/v1/services/aigc/multimodal-generation/generation") {
        return root;
    }
    format!(
        "{}/api/v1/services/aigc/multimodal-generation/generation",
        root
    )
}

fn dashscope_tts_voice(provider: &Value, requested_voice: Option<&str>) -> String {
    let voice = requested_voice.unwrap_or("Cherry").trim();
    if is_dashscope_provider(provider) && (voice.is_empty() || voice.eq_ignore_ascii_case("alloy"))
    {
        "Cherry".into()
    } else {
        voice.to_string()
    }
}

fn guess_tts_language_type(text: &str) -> &'static str {
    if text
        .chars()
        .any(|ch| ('\u{4e00}'..='\u{9fff}').contains(&ch))
    {
        "Chinese"
    } else {
        "Auto"
    }
}

fn audio_format_from_mime_type(mime_type: &str) -> &str {
    let normalized = mime_type.to_lowercase();
    if normalized.contains("wav") {
        "wav"
    } else if normalized.contains("mpeg") || normalized.contains("mp3") {
        "mp3"
    } else if normalized.contains("opus") {
        "opus"
    } else if normalized.contains("aac") {
        "aac"
    } else if normalized.contains("mp4") || normalized.contains("m4a") {
        "mp4"
    } else {
        "wav"
    }
}

fn clean_mime_type(mime_type: &str) -> &str {
    mime_type
        .split(';')
        .next()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(mime_type)
}

async fn transcribe_dashscope_inline_audio(
    provider: &Value,
    model: &str,
    bytes: &[u8],
    mime_type: &str,
    sample_rate: Option<u64>,
    api_key: &str,
    base_url: &str,
) -> CommandResult<String> {
    let provider_id = value_str(provider, "id").unwrap_or("");
    let endpoint = dashscope_generation_endpoint(base_url);
    let audio_format = audio_format_from_mime_type(mime_type);
    let data_uri = format!(
        "data:{};base64,{}",
        clean_mime_type(mime_type),
        general_purpose::STANDARD.encode(bytes)
    );
    let mut parameters = json!({
        "format": audio_format
    });
    if let Some(sample_rate) = sample_rate {
        parameters["sample_rate"] = sample_rate.to_string().into();
    }
    let request_body = json!({
        "model": model,
        "input": {
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "input_audio",
                            "input_audio": {
                                "data": data_uri
                            }
                        }
                    ]
                }
            ]
        },
        "parameters": parameters,
        "resources": []
    });
    let response = reqwest::Client::new()
        .post(&endpoint)
        .bearer_auth(api_key)
        .header("Content-Type", "application/json")
        .header("X-DashScope-SSE", "disable")
        .json(&request_body)
        .send()
        .await
        .map_err(|error| {
            eprintln!(
                "[workbench-audio] DashScope ASR request failed provider_id={} provider_name={} model={} endpoint={} mime_type={} format={} sample_rate={} audio_bytes={} error={:?}",
                provider_id,
                value_str(provider, "name").unwrap_or("unknown-provider"),
                model,
                endpoint,
                mime_type,
                audio_format,
                sample_rate.map(|value| value.to_string()).unwrap_or_else(|| "unknown".into()),
                bytes.len(),
                error
            );
            CommandError::Http(error)
        })?;
    let status = response.status();
    let response_text = response.text().await.map_err(|error| {
        eprintln!(
            "[workbench-audio] DashScope ASR response read failed provider_id={} provider_name={} model={} endpoint={} status={} error={:?}",
            provider_id,
            value_str(provider, "name").unwrap_or("unknown-provider"),
            model,
            endpoint,
            status,
            error
        );
        CommandError::Http(error)
    })?;
    if !status.is_success() {
        eprintln!(
            "[workbench-audio] DashScope ASR request returned error provider_id={} provider_name={} model={} endpoint={} status={} mime_type={} format={} sample_rate={} audio_bytes={} response_body={}",
            provider_id,
            value_str(provider, "name").unwrap_or("unknown-provider"),
            model,
            endpoint,
            status,
            mime_type,
            audio_format,
            sample_rate.map(|value| value.to_string()).unwrap_or_else(|| "unknown".into()),
            bytes.len(),
            truncate_log_text(&response_text, 4000)
        );
        return Err(CommandError::Message(format!(
            "语音识别请求失败：HTTP {}",
            status
        )));
    }
    let data: Value = serde_json::from_str(&response_text).map_err(|error| {
        eprintln!(
            "[workbench-audio] DashScope ASR response parse failed provider_id={} provider_name={} model={} endpoint={} status={} response_body={} error={}",
            provider_id,
            value_str(provider, "name").unwrap_or("unknown-provider"),
            model,
            endpoint,
            status,
            truncate_log_text(&response_text, 4000),
            error
        );
        CommandError::Json(error)
    })?;
    Ok(data
        .get("output")
        .and_then(|output| value_str(output, "text"))
        .or_else(|| {
            data.get("output")
                .and_then(|output| output.get("sentence"))
                .and_then(|sentence| value_str(sentence, "text"))
        })
        .unwrap_or("")
        .trim()
        .to_string())
}

async fn transcribe_audio_with_provider(request: &Value) -> CommandResult<String> {
    let provider = request
        .get("provider")
        .ok_or_else(|| CommandError::Message("缺少 ASR Provider。".into()))?;
    let provider_id = value_str(provider, "id").unwrap_or("");
    let access_type = provider_access_type(provider);
    if access_type == "ollama" || access_type == "anthropic" {
        return Err(CommandError::Message(
            "当前 Provider 暂未提供通用 ASR 接口。".into(),
        ));
    }
    let model = value_str(request, "model").unwrap_or("");
    if model.is_empty() {
        return Err(CommandError::Message("请先选择 ASR 模型。".into()));
    }
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
    if bytes.is_empty() {
        return Err(CommandError::Message("没有可识别的录音数据。".into()));
    }
    let audio_bytes = bytes.len();
    let api_key = get_credential("provider", provider_id)?.ok_or_else(|| {
        CommandError::Message(format!(
            "{} 尚未配置安全凭据。",
            value_str(provider, "name").unwrap_or("Provider")
        ))
    })?;
    let base_url = value_str(provider, "baseUrl")
        .unwrap_or("")
        .trim_end_matches('/');
    let file_name = value_str(request, "fileName").unwrap_or("voice-input.webm");
    let mime_type = value_str(request, "mimeType").unwrap_or("audio/webm");
    if is_dashscope_provider(provider) && is_dashscope_inline_audio_model(model) {
        return transcribe_dashscope_inline_audio(
            provider,
            model,
            &bytes,
            mime_type,
            request.get("sampleRate").and_then(Value::as_u64),
            &api_key,
            base_url,
        )
        .await;
    }
    let endpoint = format!("{}/audio/transcriptions", base_url);
    let mut form = reqwest::multipart::Form::new()
        .text("model", model.to_string())
        .part(
            "file",
            reqwest::multipart::Part::bytes(bytes)
                .file_name(file_name.to_string())
                .mime_str(mime_type)
                .map_err(|error| {
                    eprintln!(
                        "[workbench-audio] ASR multipart build failed provider_id={} provider_name={} model={} file_name={} mime_type={} audio_bytes={} error={}",
                        provider_id,
                        value_str(provider, "name").unwrap_or("unknown-provider"),
                        model,
                        file_name,
                        mime_type,
                        audio_bytes,
                        error
                    );
                    CommandError::Message(error.to_string())
                })?,
        );
    if let Some(language) = value_str(request, "language") {
        form = form.text("language", language.to_string());
    }
    let response = reqwest::Client::new()
        .post(&endpoint)
        .bearer_auth(api_key)
        .multipart(form)
        .send()
        .await
        .map_err(|error| {
            eprintln!(
                "[workbench-audio] ASR request failed provider_id={} provider_name={} model={} endpoint={} file_name={} mime_type={} audio_bytes={} error={:?}",
                provider_id,
                value_str(provider, "name").unwrap_or("unknown-provider"),
                model,
                endpoint,
                file_name,
                mime_type,
                audio_bytes,
                error
            );
            CommandError::Http(error)
        })?;
    let status = response.status();
    let response_text = response.text().await.map_err(|error| {
        eprintln!(
            "[workbench-audio] ASR response read failed provider_id={} provider_name={} model={} endpoint={} status={} error={:?}",
            provider_id,
            value_str(provider, "name").unwrap_or("unknown-provider"),
            model,
            endpoint,
            status,
            error
        );
        CommandError::Http(error)
    })?;
    if !status.is_success() {
        eprintln!(
            "[workbench-audio] ASR request returned error provider_id={} provider_name={} model={} endpoint={} status={} file_name={} mime_type={} audio_bytes={} response_body={}",
            provider_id,
            value_str(provider, "name").unwrap_or("unknown-provider"),
            model,
            endpoint,
            status,
            file_name,
            mime_type,
            audio_bytes,
            truncate_log_text(&response_text, 4000)
        );
        return Err(CommandError::Message(format!(
            "语音识别请求失败：HTTP {}",
            status
        )));
    }
    let data: Value = serde_json::from_str(&response_text).map_err(|error| {
        eprintln!(
            "[workbench-audio] ASR response parse failed provider_id={} provider_name={} model={} endpoint={} status={} response_body={} error={}",
            provider_id,
            value_str(provider, "name").unwrap_or("unknown-provider"),
            model,
            endpoint,
            status,
            truncate_log_text(&response_text, 4000),
            error
        );
        CommandError::Json(error)
    })?;
    Ok(value_str(&data, "text").unwrap_or("").trim().to_string())
}

async fn synthesize_dashscope_speech(
    provider: &Value,
    model: &str,
    text: &str,
    voice: &str,
    api_key: &str,
    base_url: &str,
) -> CommandResult<Vec<u8>> {
    let provider_id = value_str(provider, "id").unwrap_or("");
    let endpoint = dashscope_generation_endpoint(base_url);
    let input_text = text.chars().take(1800).collect::<String>();
    let request_body = json!({
        "model": model,
        "input": {
            "text": input_text,
            "voice": voice,
            "language_type": guess_tts_language_type(text)
        }
    });
    let response = reqwest::Client::new()
        .post(&endpoint)
        .bearer_auth(api_key)
        .header("Content-Type", "application/json")
        .json(&request_body)
        .send()
        .await
        .map_err(|error| {
            eprintln!(
                "[workbench-audio] DashScope TTS request failed provider_id={} provider_name={} model={} endpoint={} voice={} text_chars={} error={:?}",
                provider_id,
                value_str(provider, "name").unwrap_or("unknown-provider"),
                model,
                endpoint,
                voice,
                text.chars().count(),
                error
            );
            CommandError::Http(error)
        })?;
    let status = response.status();
    let response_text = response.text().await.map_err(|error| {
        eprintln!(
            "[workbench-audio] DashScope TTS response read failed provider_id={} provider_name={} model={} endpoint={} status={} error={:?}",
            provider_id,
            value_str(provider, "name").unwrap_or("unknown-provider"),
            model,
            endpoint,
            status,
            error
        );
        CommandError::Http(error)
    })?;
    if !status.is_success() {
        eprintln!(
            "[workbench-audio] DashScope TTS request returned error provider_id={} provider_name={} model={} endpoint={} status={} voice={} text_chars={} response_body={}",
            provider_id,
            value_str(provider, "name").unwrap_or("unknown-provider"),
            model,
            endpoint,
            status,
            voice,
            text.chars().count(),
            truncate_log_text(&response_text, 4000)
        );
        return Err(CommandError::Message(format!(
            "语音合成请求失败：HTTP {}",
            status
        )));
    }
    let data: Value = serde_json::from_str(&response_text).map_err(|error| {
        eprintln!(
            "[workbench-audio] DashScope TTS response parse failed provider_id={} provider_name={} model={} endpoint={} status={} response_body={} error={}",
            provider_id,
            value_str(provider, "name").unwrap_or("unknown-provider"),
            model,
            endpoint,
            status,
            truncate_log_text(&response_text, 4000),
            error
        );
        CommandError::Json(error)
    })?;
    if let Some(audio_data) = data
        .get("output")
        .and_then(|output| output.get("audio"))
        .and_then(|audio| value_str(audio, "data"))
    {
        return general_purpose::STANDARD
            .decode(audio_data)
            .map_err(|error| CommandError::Crypto(error.to_string()));
    }
    let audio_url = data
        .get("output")
        .and_then(|output| output.get("audio"))
        .and_then(|audio| value_str(audio, "url"))
        .or_else(|| data.get("output").and_then(|output| value_str(output, "url")))
        .ok_or_else(|| {
            eprintln!(
                "[workbench-audio] DashScope TTS response missing audio URL provider_id={} provider_name={} model={} endpoint={} response_body={}",
                provider_id,
                value_str(provider, "name").unwrap_or("unknown-provider"),
                model,
                endpoint,
                truncate_log_text(&response_text, 4000)
            );
            CommandError::Message("语音合成响应中没有音频地址。".into())
        })?;
    let audio_response = reqwest::Client::new()
        .get(audio_url)
        .send()
        .await
        .map_err(|error| {
            eprintln!(
                "[workbench-audio] DashScope TTS audio download failed provider_id={} provider_name={} model={} audio_url={} error={:?}",
                provider_id,
                value_str(provider, "name").unwrap_or("unknown-provider"),
                model,
                audio_url,
                error
            );
            CommandError::Http(error)
        })?;
    let audio_status = audio_response.status();
    let audio_bytes = audio_response.bytes().await.map_err(|error| {
        eprintln!(
            "[workbench-audio] DashScope TTS audio read failed provider_id={} provider_name={} model={} audio_url={} status={} error={:?}",
            provider_id,
            value_str(provider, "name").unwrap_or("unknown-provider"),
            model,
            audio_url,
            audio_status,
            error
        );
        CommandError::Http(error)
    })?;
    if !audio_status.is_success() {
        eprintln!(
            "[workbench-audio] DashScope TTS audio download returned error provider_id={} provider_name={} model={} audio_url={} status={} body={}",
            provider_id,
            value_str(provider, "name").unwrap_or("unknown-provider"),
            model,
            audio_url,
            audio_status,
            truncate_log_text(&String::from_utf8_lossy(&audio_bytes), 2000)
        );
        return Err(CommandError::Message(format!(
            "语音音频下载失败：HTTP {}",
            audio_status
        )));
    }
    Ok(audio_bytes.to_vec())
}

async fn synthesize_speech_with_provider(request: &Value) -> CommandResult<Vec<u8>> {
    let provider = request
        .get("provider")
        .ok_or_else(|| CommandError::Message("缺少 TTS Provider。".into()))?;
    let provider_id = value_str(provider, "id").unwrap_or("");
    let access_type = provider_access_type(provider);
    if access_type == "ollama" || access_type == "anthropic" {
        return Err(CommandError::Message(
            "当前 Provider 暂未提供通用 TTS 接口。".into(),
        ));
    }
    let model = value_str(request, "model").unwrap_or("");
    let text = value_str(request, "text").unwrap_or("");
    if model.is_empty() {
        return Err(CommandError::Message("请先选择 TTS 模型。".into()));
    }
    if text.trim().is_empty() {
        return Err(CommandError::Message("没有可朗读的内容。".into()));
    }
    let api_key = get_credential("provider", provider_id)?.ok_or_else(|| {
        CommandError::Message(format!(
            "{} 尚未配置安全凭据。",
            value_str(provider, "name").unwrap_or("Provider")
        ))
    })?;
    let base_url = value_str(provider, "baseUrl")
        .unwrap_or("")
        .trim_end_matches('/');
    let voice = dashscope_tts_voice(provider, value_str(request, "voice"));
    if is_dashscope_provider(provider) && is_dashscope_tts_model(model) {
        return synthesize_dashscope_speech(provider, model, text, &voice, &api_key, base_url)
            .await;
    }
    let endpoint = format!("{}/audio/speech", base_url);
    let request_body = json!({
        "model": model,
        "input": text.chars().take(4000).collect::<String>(),
        "voice": voice,
        "response_format": value_str(request, "format").unwrap_or("mp3")
    });
    let response = reqwest::Client::new()
        .post(&endpoint)
        .bearer_auth(api_key)
        .json(&request_body)
        .send()
        .await
        .map_err(|error| {
            eprintln!(
                "[workbench-audio] TTS request failed provider_id={} provider_name={} model={} endpoint={} voice={} format={} text_chars={} error={:?}",
                provider_id,
                value_str(provider, "name").unwrap_or("unknown-provider"),
                model,
                endpoint,
                value_str(request, "voice").unwrap_or("alloy"),
                value_str(request, "format").unwrap_or("mp3"),
                text.chars().count(),
                error
            );
            CommandError::Http(error)
        })?;
    let status = response.status();
    let data = response.bytes().await.map_err(|error| {
        eprintln!(
            "[workbench-audio] TTS response read failed provider_id={} provider_name={} model={} endpoint={} status={} error={:?}",
            provider_id,
            value_str(provider, "name").unwrap_or("unknown-provider"),
            model,
            endpoint,
            status,
            error
        );
        CommandError::Http(error)
    })?;
    if !status.is_success() {
        let response_body = String::from_utf8_lossy(&data);
        eprintln!(
            "[workbench-audio] TTS request returned error provider_id={} provider_name={} model={} endpoint={} status={} voice={} format={} text_chars={} response_body={}",
            provider_id,
            value_str(provider, "name").unwrap_or("unknown-provider"),
            model,
            endpoint,
            status,
            value_str(request, "voice").unwrap_or("alloy"),
            value_str(request, "format").unwrap_or("mp3"),
            text.chars().count(),
            truncate_log_text(&response_body, 4000)
        );
        return Err(CommandError::Message(format!(
            "语音合成请求失败：HTTP {}",
            status
        )));
    }
    Ok(data.to_vec())
}

async fn chat_completion_with_workspace_tools(
    app: &AppHandle,
    run_id: &str,
    request: &Value,
    assistant: &Value,
    provider: &Value,
    model: &str,
    system: &str,
    mut messages: Vec<Value>,
    workspace: &Path,
) -> CommandResult<String> {
    let provider_id = value_str(provider, "id").unwrap_or("");
    let access_type = provider_access_type(provider);
    if access_type == "ollama" || access_type == "anthropic" {
        return chat_completion_stream(app, run_id, provider, model, system, messages).await;
    }
    let system = system_with_current_datetime(system);

    let base_url = value_str(provider, "baseUrl")
        .unwrap_or("")
        .trim_end_matches('/');
    let api_key = get_credential("provider", provider_id)?.ok_or_else(|| {
        CommandError::Message(format!(
            "{} 尚未配置安全凭据。",
            value_str(provider, "name").unwrap_or("Provider")
        ))
    })?;
    let client = reqwest::Client::new();
    let mut tools = Vec::new();
    if request_tool_enabled(request, assistant, "tool-shell-command") {
        tools.push(shell_command_tool_definition());
        tools.push(ssh_command_tool_definition());
    }
    if request_tool_enabled(request, assistant, "tool-search") {
        tools.push(web_search_tool_definition());
    }
    let mut received_answer = String::new();

    for _ in 0..4 {
        let response = client
            .post(format!("{}/chat/completions", base_url))
            .bearer_auth(&api_key)
            .json(&json!({
                "model": model,
                "messages": std::iter::once(json!({ "role": "system", "content": system }))
                    .chain(messages.clone().into_iter())
                    .collect::<Vec<_>>(),
                "tools": tools,
                "tool_choice": "auto",
                "temperature": 0.4,
                "stream": true
            }))
            .send()
            .await?;
        let (content, message, tool_calls) =
            stream_openai_tool_message(app, run_id, ensure_success_response(response).await?)
                .await?;
        received_answer.push_str(&content);

        if tool_calls.is_empty() {
            return Ok(received_answer);
        }

        messages.push(message);
        for tool_call in tool_calls {
            let output = run_agent_tool_call(app, run_id, workspace, &tool_call).await;
            messages.push(json!({
                "role": "tool",
                "tool_call_id": value_str(&tool_call, "id").unwrap_or("tool-call"),
                "content": output.to_string()
            }));
        }
    }

    Err(CommandError::Message(
        "工具调用轮次过多，已停止以避免循环执行。".into(),
    ))
}

#[derive(Default)]
struct OpenAiToolCallPart {
    id: String,
    name: String,
    arguments: String,
}

async fn stream_openai_tool_message(
    app: &AppHandle,
    run_id: &str,
    response: reqwest::Response,
) -> CommandResult<(String, Value, Vec<Value>)> {
    let mut stream = response.bytes_stream();
    let mut buffer = String::new();
    let mut content = String::new();
    let mut tool_parts: Vec<OpenAiToolCallPart> = Vec::new();

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
                return Ok(build_openai_tool_stream_result(content, tool_parts));
            }

            let Ok(value) = serde_json::from_str::<Value>(payload) else {
                continue;
            };
            apply_openai_tool_stream_delta(app, run_id, &value, &mut content, &mut tool_parts);
        }
    }

    let payload = buffer.trim();
    if !payload.is_empty() && payload != "[DONE]" {
        let payload = payload
            .strip_prefix("data:")
            .map(str::trim)
            .unwrap_or(payload);
        if let Ok(value) = serde_json::from_str::<Value>(payload) {
            apply_openai_tool_stream_delta(app, run_id, &value, &mut content, &mut tool_parts);
        }
    }

    Ok(build_openai_tool_stream_result(content, tool_parts))
}

fn apply_openai_tool_stream_delta(
    app: &AppHandle,
    run_id: &str,
    value: &Value,
    content: &mut String,
    tool_parts: &mut Vec<OpenAiToolCallPart>,
) {
    for choice in value
        .get("choices")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some(delta) = choice.get("delta") else {
            continue;
        };
        if let Some(text) = value_str(delta, "content").filter(|text| !text.is_empty()) {
            content.push_str(text);
            emit_agent_text_delta(app, run_id, text);
        }
        for tool_call in delta
            .get("tool_calls")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let index = tool_call.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
            while tool_parts.len() <= index {
                tool_parts.push(OpenAiToolCallPart::default());
            }
            let part = &mut tool_parts[index];
            if let Some(id) = value_str(tool_call, "id") {
                part.id.push_str(id);
            }
            if let Some(function) = tool_call.get("function") {
                if let Some(name) = value_str(function, "name") {
                    part.name.push_str(name);
                }
                if let Some(arguments) = value_str(function, "arguments") {
                    part.arguments.push_str(arguments);
                }
            }
        }
    }
}

fn build_openai_tool_stream_result(
    content: String,
    tool_parts: Vec<OpenAiToolCallPart>,
) -> (String, Value, Vec<Value>) {
    let tool_calls = tool_parts
        .into_iter()
        .filter(|part| !part.id.is_empty() || !part.name.is_empty())
        .map(|part| {
            json!({
                "id": if part.id.is_empty() {
                    format!("tool-call-{}", uuid::Uuid::new_v4())
                } else {
                    part.id
                },
                "type": "function",
                "function": {
                    "name": part.name,
                    "arguments": part.arguments
                }
            })
        })
        .collect::<Vec<_>>();
    let message = if tool_calls.is_empty() {
        json!({ "role": "assistant", "content": content })
    } else {
        json!({
            "role": "assistant",
            "content": if content.is_empty() { Value::Null } else { Value::String(content.clone()) },
            "tool_calls": tool_calls
        })
    };
    (content, message, tool_calls)
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
    let system = system_with_current_datetime(system);
    let provider_id = value_str(provider, "id").unwrap_or("");
    let access_type = provider_access_type(provider);
    let base_url = value_str(provider, "baseUrl")
        .unwrap_or("")
        .trim_end_matches('/');
    let client = reqwest::Client::new();

    if access_type == "ollama" {
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

    if access_type == "anthropic" {
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

fn is_read_only_ops_prompt(prompt: &str) -> bool {
    let lower = prompt.to_lowercase();
    let has_server_target = lower.contains("服务器")
        || lower.contains("主机")
        || lower.contains("linux")
        || lower.contains("ssh")
        || lower.contains("docker")
        || lower.contains("k8s")
        || lower.contains("kubernetes");
    let has_inspection_goal = [
        "看一下",
        "查看",
        "查询",
        "检查",
        "列出",
        "状态",
        "运行了哪些",
        "运行中",
        "ps",
        "status",
        "list",
        "show",
        "check",
        "inspect",
    ]
    .iter()
    .any(|needle| lower.contains(needle));
    let has_change_intent = [
        "重启", "删除", "修改", "安装", "更新", "停止", "启动", "部署", "清理", "restart",
        "delete", "remove", "modify", "install", "update", "stop", "start", "deploy",
    ]
    .iter()
    .any(|needle| lower.contains(needle));

    has_server_target && has_inspection_goal && !has_change_intent
}

fn effective_openclaw_delegate_limit(request: &Value, prompt: &str) -> usize {
    let configured = openclaw_max_delegated_agents(request);
    if is_read_only_ops_prompt(prompt) {
        1
    } else {
        configured
    }
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

    selected
}

struct OpenClawRoute {
    understanding: Option<String>,
    agents: Vec<Value>,
}

async fn route_openclaw_agents(
    request: &Value,
    provider: &Value,
    main_assistant: &Value,
    candidates: &[Value],
) -> OpenClawRoute {
    let prompt = value_str(request, "prompt").unwrap_or("");
    let limit = effective_openclaw_delegate_limit(request, prompt);
    if candidates.is_empty() {
        return OpenClawRoute {
            understanding: None,
            agents: Vec::new(),
        };
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
        "你是内嵌 OpenClaw Core 的 Router。先理解用户任务，再判断是否需要委派子 Agent。".to_string(),
        "简单寒暄、闲聊、通用问答、无需专业能力的问题，必须由主 Agent 直接回答，不要委派。".to_string(),
        "只有任务明显需要某个专业 Agent 的领域能力、工具权限或知识范围时，才选择子 Agent。".to_string(),
        "只读运维检查、服务状态查询、Docker 容器列表等任务最多委派一个最匹配的运维类 Agent，不要同时选择系统操作助手和运维助手。".to_string(),
        "只输出 JSON，不要解释。格式：{\"understanding\":\"一句话理解用户目标\",\"agents\":[{\"agentId\":\"assistant-id\",\"reason\":\"简短原因\"}]}。不需要委派时 agents 必须是空数组。".to_string(),
    ]
    .join("\n\n");
    let route_prompt = format!(
        "用户任务：\n{}\n\n可用子 Agent：\n{}\n\n最多选择 {} 个。若主 Agent 足以回答，返回空 agents。若一个专业 Agent 足够，只选择一个。",
        prompt, roster, limit
    );

    let model = value_str(main_assistant, "model")
        .or_else(|| value_str(request, "model"))
        .unwrap_or("");
    let route_payload = chat_completion(
        provider,
        model,
        &system,
        vec![json!({ "role": "user", "content": route_prompt })],
    )
    .await
    .ok()
    .and_then(|text| {
        serde_json::from_str::<Value>(&text).ok().or_else(|| {
            extract_json_array_text(&text)
                .and_then(|json_text| serde_json::from_str::<Value>(json_text).ok())
        })
    });

    let understanding = route_payload
        .as_ref()
        .and_then(|value| value_str(value, "understanding"))
        .map(str::to_string);

    let routed = route_payload
        .and_then(|value| {
            if let Some(items) = value.get("agents").and_then(Value::as_array) {
                Some(items.clone())
            } else {
                value.as_array().cloned()
            }
        })
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
        OpenClawRoute {
            understanding,
            agents: fallback_route_assistants(prompt, candidates, limit),
        }
    } else {
        OpenClawRoute {
            understanding,
            agents: routed,
        }
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
    workspace: PathBuf,
) -> CommandResult<Value> {
    let main_assistant_id = assistant_id(&main_assistant);
    let candidates = candidate_assistants(&request, &main_assistant_id);
    let route = route_openclaw_agents(&request, &provider, &main_assistant, &candidates).await;
    let selected_agents = route.agents;
    let selected_agent_count = selected_agents.len();

    if selected_agents.is_empty() {
        let answer = if runtime_tool_enabled(&request, &main_assistant) {
            chat_completion_with_workspace_tools(
                &app,
                &run_id,
                &request,
                &main_assistant,
                &provider,
                &model,
                &system,
                model_messages(&request, false),
                &workspace,
            )
            .await?
        } else {
            chat_completion_stream(
                &app,
                &run_id,
                &provider,
                &model,
                &system,
                model_messages(&request, false),
            )
            .await?
        };
        emit_generated_files_saved(&app, &run_id, &request, &answer).await?;
        if !answer.trim().is_empty() {
            let _ =
                extract_memory_from_conversation(&app, &provider, &model, &request, &answer).await;
        }
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
            "{}我将委派给 {}。\n\n",
            route
                .understanding
                .filter(|text| !text.trim().is_empty())
                .map(|text| format!("我理解你的目标是：{}\n\n", text.trim()))
                .unwrap_or_default(),
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
            "你是内嵌 OpenClaw Core 中被 Router 委派的专业 Agent。只完成自己职责范围内的分析或执行建议，不得再委派给其他 Agent，也不要输出“我将委派给……”之类的二次委派措辞。"
                .to_string(),
            "如果你启用了 run_command 或 run_ssh_command 工具，并且用户请求本地或远程系统检查，可以调用工具；运行时会在真正执行前向用户请求授权。不要绕过授权，也不要要求用户复制命令自行运行。用户提供的 SSH 密码可用于本次受控连接，但不得在回复中回显、保存或记录。".to_string(),
            "如果你启用了 web_search 工具，并且用户请求今日新闻、最新、当前、最近、价格、政策、版本、赛事等实时信息，必须先调用 web_search，再基于搜索结果回答并保留关键来源链接。".to_string(),
            "输出必须精简：不要复述用户目标，不要写安全免责声明，不要写执行计划，不要询问是否执行诊断，不要推荐 PDF/脚本/离线指南。工具成功后只给结论、关键数据和必要下一步；通常不超过 8 行。".to_string(),
        ]
        .join("\n\n");
        let sub_request = sub_agent_request(&request, &assistant, None);
        let uses_runtime_tool = runtime_tool_enabled(&sub_request, &assistant);
        if uses_runtime_tool {
            emit_agent_text_delta(&app, &run_id, &format!("### {}\n", name));
        }
        let before = if uses_runtime_tool {
            chat_completion_with_workspace_tools(
                &app,
                &run_id,
                &sub_request,
                &assistant,
                &sub_provider,
                &sub_model,
                &sub_system,
                model_messages(&sub_request, false),
                &workspace,
            )
            .await?
        } else {
            chat_completion(
                &sub_provider,
                &sub_model,
                &sub_system,
                model_messages(&sub_request, false),
            )
            .await?
        };
        if uses_runtime_tool {
            emit_agent_text_delta(&app, &run_id, "\n\n");
        } else {
            emit_agent_text_delta(&app, &run_id, &format!("### {}\n{}\n\n", name, before));
        }
        sub_answers.push(format!("## {}\n{}", name, before));
    }

    if selected_agent_count > 1 && !sub_answers.is_empty() {
        emit_agent_text_delta(&app, &run_id, "### 汇总\n");
        let summary_context = format!(
            "以下是 OpenClaw Core 子 Agent 的执行结果，请只基于这些结果整合为一个极简最终答复。\n重要约束：如果子 Agent 已经调用工具并返回结果，不得声称无法执行、不能使用凭据、无法 SSH 或要求用户复制命令自行运行；只能总结实际结果、失败原因或下一步。不要写安全免责声明、执行计划、确认问题、PDF/脚本/离线指南推荐。最多 8 行。\n\n{}",
            sub_answers.join("\n\n")
        );
        let summary_request = sub_agent_request(&request, &main_assistant, Some(&summary_context));
        let summary_system = [
            system.as_str(),
            "你正在汇总已执行的子 Agent 结果。必须尊重工具结果；不得用通用安全拒绝覆盖已经完成的受控工具调用。不要在回复中回显密码或敏感凭据。输出要短，只保留结论、关键数据和必要下一步。",
        ]
        .join("\n\n");
        let answer = chat_completion_stream(
            &app,
            &run_id,
            &provider,
            &model,
            &summary_system,
            model_messages(&summary_request, false),
        )
        .await?;
        emit_generated_files_saved(&app, &run_id, &request, &answer).await?;
        if !answer.trim().is_empty() {
            let _ =
                extract_memory_from_conversation(&app, &provider, &model, &request, &answer).await;
        }
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

fn split_by_chars(value: &str, max_chars: usize, max_segments: usize) -> Vec<String> {
    let mut segments = Vec::new();
    let mut current = String::new();
    for ch in value.chars() {
        current.push(ch);
        if current.chars().count() >= max_chars {
            segments.push(current.trim().to_string());
            current.clear();
            if segments.len() >= max_segments {
                break;
            }
        }
    }
    if !current.trim().is_empty() && segments.len() < max_segments {
        segments.push(current.trim().to_string());
    }
    segments
}

fn string_array(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(ToOwned::to_owned)
        .collect()
}

fn push_unique_string(items: &mut Vec<Value>, value: &str) {
    if value.trim().is_empty() {
        return;
    }
    if !items.iter().any(|item| item.as_str() == Some(value)) {
        items.push(Value::String(value.to_string()));
    }
}

fn push_unique_json_string(array: &mut Value, value: &str) {
    if !array.is_array() {
        *array = json!([]);
    }
    if let Some(items) = array.as_array_mut() {
        push_unique_string(items, value);
    }
}

fn normalize_graph_key(value: &str) -> String {
    value
        .trim()
        .to_lowercase()
        .chars()
        .filter(|ch| !ch.is_whitespace())
        .collect()
}

fn confidence(value: Option<&Value>) -> f64 {
    value.and_then(Value::as_f64).unwrap_or(0.7).clamp(0.0, 1.0)
}

fn graph_array_mut<'a>(graph: &'a mut Value, key: &str) -> &'a mut Vec<Value> {
    if !graph.is_object() {
        *graph = json!({ "nodes": [], "edges": [], "facts": [] });
    }
    let object = graph.as_object_mut().expect("graph object");
    if !object.get(key).is_some_and(Value::is_array) {
        object.insert(key.to_string(), json!([]));
    }
    object
        .get_mut(key)
        .and_then(Value::as_array_mut)
        .expect("graph array")
}

fn upsert_graph_node(
    graph: &mut Value,
    entity: &Value,
    file_id: &str,
    chunk_id: &str,
) -> Option<String> {
    let name = value_str(entity, "name")
        .or_else(|| value_str(entity, "text"))?
        .trim();
    if name.is_empty() {
        return None;
    }
    let entity_type = value_str(entity, "type").unwrap_or("概念").trim();
    let key = format!(
        "{}|{}",
        normalize_graph_key(name),
        normalize_graph_key(entity_type)
    );
    let nodes = graph_array_mut(graph, "nodes");
    if let Some(node) = nodes.iter_mut().find(|node| {
        let current_key = format!(
            "{}|{}",
            normalize_graph_key(value_str(node, "name").unwrap_or("")),
            normalize_graph_key(value_str(node, "type").unwrap_or("概念"))
        );
        current_key == key
    }) {
        let id = value_str(node, "id").unwrap_or("").to_string();
        let missing_description = value_str(node, "description").unwrap_or("").is_empty();
        if let Some(object) = node.as_object_mut() {
            if missing_description {
                if let Some(description) = value_str(entity, "description") {
                    object.insert("description".into(), Value::String(description.to_string()));
                }
            }
            let aliases = object.entry("aliases").or_insert_with(|| json!([]));
            for alias in string_array(entity.get("aliases")) {
                push_unique_json_string(aliases, &alias);
            }
            push_unique_json_string(
                object.entry("sourceFileIds").or_insert_with(|| json!([])),
                file_id,
            );
            push_unique_json_string(
                object.entry("sourceChunkIds").or_insert_with(|| json!([])),
                chunk_id,
            );
        }
        return Some(id);
    }
    let id = uuid::Uuid::new_v4().to_string();
    nodes.push(json!({
        "id": id,
        "name": name,
        "type": if entity_type.is_empty() { "概念" } else { entity_type },
        "aliases": string_array(entity.get("aliases")),
        "description": value_str(entity, "description").unwrap_or(""),
        "sourceFileIds": [file_id],
        "sourceChunkIds": [chunk_id]
    }));
    Some(id)
}

fn upsert_graph_edge(
    graph: &mut Value,
    relation: &Value,
    entity_ids: &HashMap<String, String>,
    file_id: &str,
    chunk_id: &str,
) {
    let source_name = value_str(relation, "source")
        .or_else(|| value_str(relation, "from"))
        .unwrap_or("");
    let target_name = value_str(relation, "target")
        .or_else(|| value_str(relation, "to"))
        .unwrap_or("");
    let relation_name = value_str(relation, "relation")
        .or_else(|| value_str(relation, "predicate"))
        .unwrap_or("")
        .trim();
    if source_name.trim().is_empty() || target_name.trim().is_empty() || relation_name.is_empty() {
        return;
    }
    let Some(source_id) = entity_ids.get(&normalize_graph_key(source_name)).cloned() else {
        return;
    };
    let Some(target_id) = entity_ids.get(&normalize_graph_key(target_name)).cloned() else {
        return;
    };
    if source_id == target_id {
        return;
    }
    let key = format!(
        "{}|{}|{}",
        source_id,
        target_id,
        normalize_graph_key(relation_name)
    );
    let edges = graph_array_mut(graph, "edges");
    if let Some(edge) = edges.iter_mut().find(|edge| {
        format!(
            "{}|{}|{}",
            value_str(edge, "sourceNodeId").unwrap_or(""),
            value_str(edge, "targetNodeId").unwrap_or(""),
            normalize_graph_key(value_str(edge, "relation").unwrap_or(""))
        ) == key
    }) {
        let missing_description = value_str(edge, "description").unwrap_or("").is_empty();
        if let Some(object) = edge.as_object_mut() {
            let current_confidence = object
                .get("confidence")
                .and_then(Value::as_f64)
                .unwrap_or(0.0);
            object.insert(
                "confidence".into(),
                json!(current_confidence.max(confidence(relation.get("confidence")))),
            );
            if missing_description {
                if let Some(description) = value_str(relation, "description") {
                    object.insert("description".into(), Value::String(description.to_string()));
                }
            }
            push_unique_json_string(
                object.entry("sourceFileIds").or_insert_with(|| json!([])),
                file_id,
            );
            push_unique_json_string(
                object.entry("sourceChunkIds").or_insert_with(|| json!([])),
                chunk_id,
            );
        }
        return;
    }
    edges.push(json!({
        "id": uuid::Uuid::new_v4().to_string(),
        "sourceNodeId": source_id,
        "targetNodeId": target_id,
        "relation": relation_name,
        "description": value_str(relation, "description").unwrap_or(""),
        "confidence": confidence(relation.get("confidence")),
        "sourceFileIds": [file_id],
        "sourceChunkIds": [chunk_id]
    }));
}

fn upsert_graph_edge_by_id(
    graph: &mut Value,
    source_id: &str,
    target_id: &str,
    relation_name: &str,
    description: &str,
    file_id: &str,
    chunk_id: &str,
    confidence_value: f64,
) {
    if source_id.is_empty() || target_id.is_empty() || source_id == target_id {
        return;
    }
    let key = format!(
        "{}|{}|{}",
        source_id,
        target_id,
        normalize_graph_key(relation_name)
    );
    let edges = graph_array_mut(graph, "edges");
    if let Some(edge) = edges.iter_mut().find(|edge| {
        format!(
            "{}|{}|{}",
            value_str(edge, "sourceNodeId").unwrap_or(""),
            value_str(edge, "targetNodeId").unwrap_or(""),
            normalize_graph_key(value_str(edge, "relation").unwrap_or(""))
        ) == key
    }) {
        let missing_description = value_str(edge, "description").unwrap_or("").is_empty();
        if let Some(object) = edge.as_object_mut() {
            let current_confidence = object
                .get("confidence")
                .and_then(Value::as_f64)
                .unwrap_or(0.0);
            object.insert(
                "confidence".into(),
                json!(current_confidence.max(confidence_value.clamp(0.0, 1.0))),
            );
            if missing_description {
                object.insert("description".into(), Value::String(description.to_string()));
            }
            push_unique_json_string(
                object.entry("sourceFileIds").or_insert_with(|| json!([])),
                file_id,
            );
            push_unique_json_string(
                object.entry("sourceChunkIds").or_insert_with(|| json!([])),
                chunk_id,
            );
        }
        return;
    }
    edges.push(json!({
        "id": uuid::Uuid::new_v4().to_string(),
        "sourceNodeId": source_id,
        "targetNodeId": target_id,
        "relation": relation_name,
        "description": description,
        "confidence": confidence_value.clamp(0.0, 1.0),
        "sourceFileIds": [file_id],
        "sourceChunkIds": [chunk_id]
    }));
}

fn upsert_graph_fact(
    graph: &mut Value,
    fact: &Value,
    entity_ids: &HashMap<String, String>,
    file_id: &str,
    chunk_id: &str,
) {
    let subject_name = value_str(fact, "subject").unwrap_or("");
    let predicate = value_str(fact, "predicate").unwrap_or("").trim();
    let fact_value = value_str(fact, "value").unwrap_or("").trim();
    if predicate.is_empty() || fact_value.is_empty() {
        return;
    }
    let subject_id = entity_ids.get(&normalize_graph_key(subject_name)).cloned();
    let key = format!(
        "{}|{}|{}",
        subject_id.as_deref().unwrap_or(""),
        normalize_graph_key(predicate),
        normalize_graph_key(fact_value)
    );
    let facts = graph_array_mut(graph, "facts");
    if let Some(existing) = facts.iter_mut().find(|existing| {
        format!(
            "{}|{}|{}",
            value_str(existing, "subjectNodeId").unwrap_or(""),
            normalize_graph_key(value_str(existing, "predicate").unwrap_or("")),
            normalize_graph_key(value_str(existing, "value").unwrap_or(""))
        ) == key
    }) {
        if let Some(object) = existing.as_object_mut() {
            let current_confidence = object
                .get("confidence")
                .and_then(Value::as_f64)
                .unwrap_or(0.0);
            object.insert(
                "confidence".into(),
                json!(current_confidence.max(confidence(fact.get("confidence")))),
            );
            push_unique_json_string(
                object.entry("sourceFileIds").or_insert_with(|| json!([])),
                file_id,
            );
            push_unique_json_string(
                object.entry("sourceChunkIds").or_insert_with(|| json!([])),
                chunk_id,
            );
        }
        return;
    }
    let mut item = json!({
        "id": uuid::Uuid::new_v4().to_string(),
        "predicate": predicate,
        "value": fact_value,
        "confidence": confidence(fact.get("confidence")),
        "sourceFileIds": [file_id],
        "sourceChunkIds": [chunk_id]
    });
    if let Some(subject_id) = subject_id {
        if let Some(object) = item.as_object_mut() {
            object.insert("subjectNodeId".into(), Value::String(subject_id));
        }
    }
    facts.push(item);
}

fn upsert_graph_fact_by_subject_id(
    graph: &mut Value,
    subject_id: &str,
    predicate: &str,
    fact_value: &str,
    file_id: &str,
    chunk_id: &str,
    confidence_value: f64,
) {
    let predicate = predicate.trim();
    let fact_value = fact_value.trim();
    if subject_id.is_empty() || predicate.is_empty() || fact_value.is_empty() {
        return;
    }
    let key = format!(
        "{}|{}|{}",
        subject_id,
        normalize_graph_key(predicate),
        normalize_graph_key(fact_value)
    );
    let facts = graph_array_mut(graph, "facts");
    if let Some(existing) = facts.iter_mut().find(|existing| {
        format!(
            "{}|{}|{}",
            value_str(existing, "subjectNodeId").unwrap_or(""),
            normalize_graph_key(value_str(existing, "predicate").unwrap_or("")),
            normalize_graph_key(value_str(existing, "value").unwrap_or(""))
        ) == key
    }) {
        if let Some(object) = existing.as_object_mut() {
            let current_confidence = object
                .get("confidence")
                .and_then(Value::as_f64)
                .unwrap_or(0.0);
            object.insert(
                "confidence".into(),
                json!(current_confidence.max(confidence_value.clamp(0.0, 1.0))),
            );
            push_unique_json_string(
                object.entry("sourceFileIds").or_insert_with(|| json!([])),
                file_id,
            );
            push_unique_json_string(
                object.entry("sourceChunkIds").or_insert_with(|| json!([])),
                chunk_id,
            );
        }
        return;
    }
    facts.push(json!({
        "id": uuid::Uuid::new_v4().to_string(),
        "subjectNodeId": subject_id,
        "predicate": predicate,
        "value": fact_value,
        "confidence": confidence_value.clamp(0.0, 1.0),
        "sourceFileIds": [file_id],
        "sourceChunkIds": [chunk_id]
    }));
}

fn heuristic_entities(text: &str, file_name: &str) -> Vec<Value> {
    let mut names = Vec::new();
    names.push(file_name.to_string());
    for token in text.split(|ch: char| {
        ch.is_whitespace()
            || matches!(
                ch,
                ',' | '.'
                    | ';'
                    | ':'
                    | '!'
                    | '?'
                    | '('
                    | ')'
                    | '['
                    | ']'
                    | '{'
                    | '}'
                    | '，'
                    | '。'
                    | '；'
                    | '：'
                    | '！'
                    | '？'
                    | '、'
                    | '（'
                    | '）'
                    | '《'
                    | '》'
            )
    }) {
        let token = token.trim();
        let chars = token.chars().count();
        if (2..=24).contains(&chars)
            && (token.chars().any(|ch| ch.is_ascii_uppercase())
                || token.ends_with("系统")
                || token.ends_with("平台")
                || token.ends_with("模块")
                || token.ends_with("流程")
                || token.ends_with("策略")
                || token.ends_with("规范")
                || token.ends_with("制度"))
            && !names.iter().any(|name| name == token)
        {
            names.push(token.to_string());
        }
        if names.len() >= 8 {
            break;
        }
    }
    names
        .into_iter()
        .map(|name| {
            json!({
                "name": name,
                "type": "概念",
                "aliases": [],
                "description": ""
            })
        })
        .collect()
}

fn fallback_keywords(text: &str, file_name: &str) -> Vec<String> {
    let mut keywords = Vec::new();
    for item in [file_name]
        .into_iter()
        .chain(text.split(|ch: char| !ch.is_alphanumeric() && ch != '_' && ch != '-'))
    {
        let item = item.trim();
        if item.chars().count() >= 2 && item.chars().count() <= 24 {
            let key = item.to_lowercase();
            if !keywords.iter().any(|keyword| keyword == &key) {
                keywords.push(key);
            }
        }
        if keywords.len() >= 12 {
            break;
        }
    }
    keywords
}

#[derive(Debug, Clone)]
struct ExtractedTable {
    name: String,
    headers: Vec<String>,
    rows: Vec<Vec<String>>,
}

fn clean_table_cell(value: &str) -> String {
    value
        .replace('\u{00a0}', " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim_matches('|')
        .trim()
        .to_string()
}

fn normalize_table_headers(headers: &[String], width: usize) -> Vec<String> {
    (0..width)
        .map(|index| {
            let value = headers
                .get(index)
                .map(|header| clean_table_cell(header))
                .unwrap_or_default();
            if value.is_empty() {
                format!("列{}", index + 1)
            } else {
                value
            }
        })
        .collect()
}

fn is_empty_table_row(row: &[String]) -> bool {
    row.iter().all(|cell| clean_table_cell(cell).is_empty())
}

fn data_to_string(value: &Data) -> String {
    match value {
        Data::Empty => String::new(),
        Data::String(value) => clean_table_cell(value),
        Data::Float(value) => {
            if value.fract() == 0.0 {
                format!("{:.0}", value)
            } else {
                value.to_string()
            }
        }
        Data::Int(value) => value.to_string(),
        Data::Bool(value) => value.to_string(),
        Data::DateTime(value) => value.to_string(),
        Data::DateTimeIso(value) => clean_table_cell(value),
        Data::DurationIso(value) => clean_table_cell(value),
        Data::Error(value) => value.to_string(),
    }
}

fn table_row_preview(headers: &[String], row: &[String]) -> String {
    headers
        .iter()
        .zip(row.iter())
        .filter_map(|(header, value)| {
            let value = clean_table_cell(value);
            (!value.is_empty()).then(|| format!("{}={}", header, value))
        })
        .take(6)
        .collect::<Vec<_>>()
        .join("；")
}

fn table_to_content(table: &ExtractedTable) -> String {
    let mut lines = vec![format!("表格：{}", table.name)];
    lines.push(format!("字段：{}", table.headers.join("，")));
    for (index, row) in table.rows.iter().take(20).enumerate() {
        let preview = table_row_preview(&table.headers, row);
        if !preview.is_empty() {
            lines.push(format!("第{}行：{}", index + 1, preview));
        }
    }
    lines.join("\n")
}

fn parse_delimited_table(name: &str, bytes: &[u8], delimiter: u8) -> Vec<ExtractedTable> {
    let mut reader = ReaderBuilder::new()
        .has_headers(false)
        .flexible(true)
        .delimiter(delimiter)
        .from_reader(Cursor::new(bytes));
    let mut raw_rows = Vec::new();
    for record in reader.records().flatten() {
        let row = record.iter().map(clean_table_cell).collect::<Vec<_>>();
        if !is_empty_table_row(&row) {
            raw_rows.push(row);
        }
        if raw_rows.len() > KNOWLEDGE_TABLE_MAX_ROWS {
            break;
        }
    }
    rows_to_table(name, raw_rows).into_iter().collect()
}

fn rows_to_table(name: &str, raw_rows: Vec<Vec<String>>) -> Option<ExtractedTable> {
    if raw_rows.len() < 2 {
        return None;
    }
    let width = raw_rows
        .iter()
        .map(Vec::len)
        .max()
        .unwrap_or(0)
        .min(KNOWLEDGE_TABLE_MAX_COLUMNS);
    if width < 2 {
        return None;
    }
    let headers = normalize_table_headers(&raw_rows[0], width);
    let rows = raw_rows
        .into_iter()
        .skip(1)
        .map(|mut row| {
            row.truncate(width);
            while row.len() < width {
                row.push(String::new());
            }
            row.into_iter()
                .map(|cell| clean_table_cell(&cell))
                .collect::<Vec<_>>()
        })
        .filter(|row| !is_empty_table_row(row))
        .take(KNOWLEDGE_TABLE_MAX_ROWS)
        .collect::<Vec<_>>();
    (!rows.is_empty()).then(|| ExtractedTable {
        name: name.to_string(),
        headers,
        rows,
    })
}

fn extract_excel_tables(file_name: &str, bytes: &[u8]) -> Vec<ExtractedTable> {
    let Ok(mut workbook) = open_workbook_auto_from_rs(Cursor::new(bytes.to_vec())) else {
        return Vec::new();
    };
    let mut tables = Vec::new();
    for sheet_name in workbook.sheet_names().to_owned() {
        let Ok(range) = workbook.worksheet_range(&sheet_name) else {
            continue;
        };
        let raw_rows = range
            .rows()
            .map(|row| {
                row.iter()
                    .take(KNOWLEDGE_TABLE_MAX_COLUMNS)
                    .map(data_to_string)
                    .collect::<Vec<_>>()
            })
            .filter(|row| !is_empty_table_row(row))
            .take(KNOWLEDGE_TABLE_MAX_ROWS + 1)
            .collect::<Vec<_>>();
        if let Some(table) = rows_to_table(&format!("{} / {}", file_name, sheet_name), raw_rows) {
            tables.push(table);
        }
    }
    tables
}

fn is_markdown_table_separator(line: &str) -> bool {
    let trimmed = line.trim().trim_matches('|').trim();
    !trimmed.is_empty()
        && trimmed.split('|').all(|cell| {
            cell.trim()
                .chars()
                .all(|ch| ch == '-' || ch == ':' || ch == ' ')
        })
}

fn parse_markdown_table_row(line: &str) -> Vec<String> {
    line.trim()
        .trim_matches('|')
        .split('|')
        .map(clean_table_cell)
        .collect()
}

fn extract_markdown_tables(content: &str) -> Vec<ExtractedTable> {
    let lines = content.lines().collect::<Vec<_>>();
    let mut tables = Vec::new();
    let mut index = 0;
    while index + 1 < lines.len() {
        if !lines[index].contains('|') || !is_markdown_table_separator(lines[index + 1]) {
            index += 1;
            continue;
        }
        let header = parse_markdown_table_row(lines[index]);
        let mut raw_rows = vec![header];
        index += 2;
        while index < lines.len() && lines[index].contains('|') {
            if is_markdown_table_separator(lines[index]) {
                index += 1;
                continue;
            }
            raw_rows.push(parse_markdown_table_row(lines[index]));
            index += 1;
        }
        if let Some(table) = rows_to_table(&format!("提取表格 {}", tables.len() + 1), raw_rows)
        {
            tables.push(table);
        }
    }
    tables
}

fn extract_structured_tables(request: &Value) -> Vec<ExtractedTable> {
    let file_name = value_str(request, "fileName").unwrap_or("文档");
    let extension = Path::new(file_name)
        .extension()
        .and_then(OsStr::to_str)
        .unwrap_or("")
        .to_lowercase();
    let bytes = request.get("bytes").and_then(Value::as_array).map(|items| {
        items
            .iter()
            .filter_map(Value::as_u64)
            .map(|n| n as u8)
            .collect::<Vec<_>>()
    });
    let mut tables = match (extension.as_str(), bytes.as_deref()) {
        ("csv", Some(bytes)) => parse_delimited_table(file_name, bytes, b','),
        ("tsv", Some(bytes)) => parse_delimited_table(file_name, bytes, b'\t'),
        ("xlsx" | "xls" | "xlsm", Some(bytes)) => extract_excel_tables(file_name, bytes),
        _ => Vec::new(),
    };
    let markdown_tables = extract_markdown_tables(value_str(request, "contentText").unwrap_or(""));
    for table in markdown_tables {
        if !tables.iter().any(|existing| {
            existing.headers == table.headers && existing.rows.first() == table.rows.first()
        }) {
            tables.push(ExtractedTable {
                name: format!("{} / {}", file_name, table.name),
                ..table
            });
        }
    }
    tables
}

fn upsert_structured_table_graph(
    graph: &mut Value,
    table: &ExtractedTable,
    file_id: &str,
    chunk_id: &str,
) -> Vec<String> {
    let mut entity_ids = Vec::new();
    let table_id = upsert_graph_node(
        graph,
        &json!({
            "name": table.name,
            "type": "表格",
            "aliases": [],
            "description": format!("结构化表格，{} 列，{} 行", table.headers.len(), table.rows.len())
        }),
        file_id,
        chunk_id,
    );
    if let Some(id) = table_id.clone() {
        entity_ids.push(id);
    }

    let mut field_ids = Vec::new();
    for header in &table.headers {
        let field_name = format!("{} / {}", table.name, header);
        let field_id = upsert_graph_node(
            graph,
            &json!({
                "name": field_name,
                "type": "字段",
                "aliases": [header],
                "description": format!("表格字段：{}", header)
            }),
            file_id,
            chunk_id,
        );
        if let Some(field_id) = field_id {
            if let Some(table_id) = table_id.as_deref() {
                upsert_graph_edge_by_id(
                    graph,
                    table_id,
                    &field_id,
                    "包含字段",
                    &format!("表格 {} 包含字段 {}", table.name, header),
                    file_id,
                    chunk_id,
                    1.0,
                );
            }
            entity_ids.push(field_id.clone());
            field_ids.push(field_id);
        }
    }

    for (row_index, row) in table.rows.iter().enumerate() {
        let preview = table_row_preview(&table.headers, row);
        let row_name = if preview.is_empty() {
            format!("{} / 第{}行", table.name, row_index + 1)
        } else {
            format!("{} / 第{}行 / {}", table.name, row_index + 1, preview)
                .chars()
                .take(120)
                .collect()
        };
        let Some(record_id) = upsert_graph_node(
            graph,
            &json!({
                "name": row_name,
                "type": "表格记录",
                "aliases": [format!("{} 第{}行", table.name, row_index + 1)],
                "description": preview
            }),
            file_id,
            chunk_id,
        ) else {
            continue;
        };
        entity_ids.push(record_id.clone());
        if let Some(table_id) = table_id.as_deref() {
            upsert_graph_edge_by_id(
                graph,
                table_id,
                &record_id,
                "包含记录",
                &format!("表格 {} 第{}行", table.name, row_index + 1),
                file_id,
                chunk_id,
                1.0,
            );
        }
        for (column_index, header) in table.headers.iter().enumerate() {
            let value = row
                .get(column_index)
                .map(|cell| clean_table_cell(cell))
                .unwrap_or_default();
            if value.is_empty() {
                continue;
            }
            upsert_graph_fact_by_subject_id(
                graph, &record_id, header, &value, file_id, chunk_id, 1.0,
            );
            if let Some(field_id) = field_ids.get(column_index) {
                upsert_graph_edge_by_id(
                    graph,
                    &record_id,
                    field_id,
                    "具有字段",
                    &format!("第{}行字段 {}", row_index + 1, header),
                    file_id,
                    chunk_id,
                    1.0,
                );
            }
        }
    }
    entity_ids
}

fn build_structured_table_index(request: &Value) -> Value {
    let file_id = value_str(request, "fileId").unwrap_or("file");
    let mut graph = request
        .get("existingGraph")
        .cloned()
        .unwrap_or_else(|| json!({ "nodes": [], "edges": [], "facts": [] }));
    let mut chunks = Vec::new();
    for table in extract_structured_tables(request) {
        let chunk_id = uuid::Uuid::new_v4().to_string();
        let entity_ids = upsert_structured_table_graph(&mut graph, &table, file_id, &chunk_id);
        let content = table_to_content(&table);
        chunks.push(json!({
            "id": chunk_id,
            "sourceFileId": file_id,
            "content": content,
            "tokenCount": content.chars().count() / 2 + 1,
            "title": format!("结构化表格：{}", table.name),
            "summary": format!("按行列结构抽取：{} 列，{} 行；每一行作为记录节点，每一列作为字段属性，单元格作为事实值。", table.headers.len(), table.rows.len()),
            "keywords": table.headers,
            "entityIds": entity_ids
        }));
    }
    json!({ "chunks": chunks, "graph": graph })
}

fn simple_knowledge_index(request: &Value) -> Value {
    let content = value_str(request, "contentText").unwrap_or("");
    let file_id = value_str(request, "fileId").unwrap_or("file");
    let file_name = value_str(request, "fileName").unwrap_or("文档");
    let mut graph = request
        .get("existingGraph")
        .cloned()
        .unwrap_or_else(|| json!({ "nodes": [], "edges": [], "facts": [] }));
    let mut chunks = Vec::new();
    for (index, chunk) in split_by_chars(
        content,
        KNOWLEDGE_FALLBACK_CHUNK_CHARS,
        KNOWLEDGE_INDEX_MAX_SEGMENTS * 2,
    )
    .into_iter()
    .enumerate()
    {
        let trimmed = chunk.trim().to_string();
        if trimmed.is_empty() {
            continue;
        }
        let chunk_id = uuid::Uuid::new_v4().to_string();
        let entities = heuristic_entities(&trimmed, file_name);
        let mut entity_ids = HashMap::new();
        for entity in &entities {
            if let Some(id) = upsert_graph_node(&mut graph, entity, file_id, &chunk_id) {
                if let Some(name) = value_str(entity, "name") {
                    entity_ids.insert(normalize_graph_key(name), id);
                }
            }
        }
        let attached_entity_ids = entity_ids.values().cloned().collect::<Vec<_>>();
        chunks.push(json!({
            "id": chunk_id,
            "sourceFileId": file_id,
            "content": trimmed,
            "tokenCount": trimmed.chars().count() / 2 + 1,
            "title": if index == 0 { file_name.to_string() } else { format!("{} 片段 {}", file_name, index + 1) },
            "summary": trimmed.lines().find(|line| !line.trim().is_empty()).unwrap_or("").chars().take(180).collect::<String>(),
            "keywords": fallback_keywords(&trimmed, file_name),
            "entityIds": attached_entity_ids
        }));
    }
    if chunks.is_empty() {
        let chunk_id = uuid::Uuid::new_v4().to_string();
        let entity_id = upsert_graph_node(
            &mut graph,
            &json!({ "name": file_name, "type": "文档", "aliases": [], "description": "" }),
            file_id,
            &chunk_id,
        );
        chunks.push(json!({
            "id": chunk_id,
            "sourceFileId": file_id,
            "content": content,
            "tokenCount": 1,
            "title": file_name,
            "summary": "",
            "keywords": fallback_keywords(content, file_name),
            "entityIds": entity_id.into_iter().collect::<Vec<_>>()
        }));
    }
    json!({
        "chunks": chunks,
        "graph": graph
    })
}

fn extract_json_object_text(text: &str) -> Option<&str> {
    let start = text.find('{')?;
    let end = text.rfind('}')?;
    (end > start).then(|| &text[start..=end])
}

fn parse_knowledge_index_response(text: &str) -> Option<Value> {
    serde_json::from_str::<Value>(strip_json_fence(text))
        .ok()
        .or_else(|| {
            extract_json_object_text(text)
                .and_then(|json_text| serde_json::from_str(json_text).ok())
        })
}

fn merge_knowledge_index_payload(
    payload: &Value,
    request: &Value,
    existing_graph: Value,
    fallback_segments: &[String],
) -> Value {
    let file_id = value_str(request, "fileId").unwrap_or("file");
    let file_name = value_str(request, "fileName").unwrap_or("文档");
    let mut graph = existing_graph;
    let mut chunks = Vec::new();
    let source_chunks = payload
        .get("chunks")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    for (index, source_chunk) in source_chunks.iter().enumerate() {
        let content = value_str(source_chunk, "content")
            .or_else(|| value_str(source_chunk, "text"))
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned)
            .or_else(|| fallback_segments.get(index).cloned())
            .unwrap_or_default();
        if content.trim().is_empty() {
            continue;
        }
        let chunk_id = uuid::Uuid::new_v4().to_string();
        let mut entity_ids_by_name = HashMap::new();
        for entity in source_chunk
            .get("entities")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if let Some(id) = upsert_graph_node(&mut graph, entity, file_id, &chunk_id) {
                if let Some(name) = value_str(entity, "name").or_else(|| value_str(entity, "text"))
                {
                    entity_ids_by_name.insert(normalize_graph_key(name), id);
                }
            }
        }
        for relation in source_chunk
            .get("relations")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            upsert_graph_edge(
                &mut graph,
                relation,
                &entity_ids_by_name,
                file_id,
                &chunk_id,
            );
        }
        for fact in source_chunk
            .get("facts")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            upsert_graph_fact(&mut graph, fact, &entity_ids_by_name, file_id, &chunk_id);
        }
        let keywords = string_array(source_chunk.get("keywords"));
        chunks.push(json!({
            "id": chunk_id,
            "sourceFileId": file_id,
            "content": content,
            "tokenCount": content.chars().count() / 2 + 1,
            "title": value_str(source_chunk, "title")
                .map(ToOwned::to_owned)
                .unwrap_or_else(|| if index == 0 { file_name.to_string() } else { format!("{} 片段 {}", file_name, index + 1) }),
            "summary": value_str(source_chunk, "summary").unwrap_or("").chars().take(260).collect::<String>(),
            "keywords": if keywords.is_empty() { fallback_keywords(&content, file_name) } else { keywords },
            "entityIds": entity_ids_by_name.values().cloned().collect::<Vec<_>>()
        }));
    }

    if chunks.is_empty() {
        return simple_knowledge_index(request);
    }

    json!({ "chunks": chunks, "graph": graph })
}

async fn llm_knowledge_index(request: &Value) -> CommandResult<Value> {
    let provider = request
        .get("provider")
        .cloned()
        .ok_or_else(|| CommandError::Message("缺少知识图谱生成 Provider。".into()))?;
    let model = value_str(request, "model").unwrap_or("");
    let content = value_str(request, "contentText").unwrap_or("");
    let file_name = value_str(request, "fileName").unwrap_or("文档");
    let segments = split_by_chars(
        content,
        KNOWLEDGE_INDEX_SEGMENT_CHARS,
        KNOWLEDGE_INDEX_MAX_SEGMENTS,
    );
    if segments.is_empty() {
        return Ok(simple_knowledge_index(request));
    }

    let mut graph = request
        .get("existingGraph")
        .cloned()
        .unwrap_or_else(|| json!({ "nodes": [], "edges": [], "facts": [] }));
    let mut all_chunks = Vec::new();
    let system = "你是知识库索引器。请只输出 JSON，不要解释。目标是把文档分成可检索知识块，并抽取实体、关系和事实用于知识图谱。所有关系和事实必须来自原文证据，不能臆造。";

    for (index, segment) in segments.iter().enumerate() {
        let prompt = format!(
            r#"文档名：{file_name}
批次：{}/{}

请从下面正文生成结构化索引，返回 JSON：
{{
  "chunks": [
    {{
      "title": "知识块标题",
      "summary": "不超过120字摘要",
      "content": "保留原文证据，可适度整理但不要添加原文没有的信息",
      "keywords": ["关键词"],
      "entities": [{{"name":"实体名","type":"人物/组织/产品/系统/概念/指标/时间/地点/文档","aliases":[],"description":"原文支持的简短说明"}}],
      "relations": [{{"source":"实体名","target":"实体名","relation":"关系动词或短语","description":"证据说明","confidence":0.0}}],
      "facts": [{{"subject":"实体名","predicate":"属性或结论","value":"事实值","confidence":0.0}}]
    }}
  ]
}}

要求：
- 每批生成 2 到 6 个 chunks。
- content 必须是这批正文中的信息，适合回注给 Agent 作为证据。
- entities 中的名称要稳定、短，不要把整句当实体。
- relations/facts 只引用 entities 中出现的实体名。

正文：
{}"#,
            index + 1,
            segments.len(),
            segment
        );
        let answer = chat_completion(
            &provider,
            model,
            system,
            vec![json!({ "role": "user", "content": prompt })],
        )
        .await?;
        let Some(payload) = parse_knowledge_index_response(&answer) else {
            return Err(CommandError::Message(
                "模型没有返回可解析的知识图谱 JSON。".into(),
            ));
        };
        let partial =
            merge_knowledge_index_payload(&payload, request, graph, std::slice::from_ref(segment));
        graph = partial
            .get("graph")
            .cloned()
            .unwrap_or_else(|| json!({ "nodes": [], "edges": [], "facts": [] }));
        all_chunks.extend(
            partial
                .get("chunks")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .cloned(),
        );
    }

    if all_chunks.is_empty() {
        Ok(simple_knowledge_index(request))
    } else {
        Ok(json!({ "chunks": all_chunks, "graph": graph }))
    }
}

async fn enrich_knowledge_index_with_models(mut result: Value, request: &Value) -> Value {
    let Some(chunks) = result.get_mut("chunks").and_then(Value::as_array_mut) else {
        return result;
    };
    let Some(embedding_provider) = request.get("embeddingProvider") else {
        return result;
    };
    let embedding_model = value_str(request, "embeddingModel").unwrap_or("");
    if embedding_model.is_empty() {
        return result;
    }
    let texts = chunks
        .iter()
        .map(|chunk| value_str(chunk, "content").unwrap_or("").to_string())
        .collect::<Vec<_>>();
    match embedding_vectors(embedding_provider, embedding_model, texts).await {
        Ok(embeddings) => {
            let provider_id = value_str(embedding_provider, "id")
                .unwrap_or("")
                .to_string();
            for (chunk, embedding) in chunks.iter_mut().zip(embeddings.into_iter()) {
                if embedding.is_empty() {
                    continue;
                }
                if let Some(object) = chunk.as_object_mut() {
                    object.insert("embedding".into(), json!(embedding));
                    object.insert(
                        "embeddingProviderId".into(),
                        Value::String(provider_id.clone()),
                    );
                    object.insert(
                        "embeddingModel".into(),
                        Value::String(embedding_model.to_string()),
                    );
                    if let Some(rerank_provider) = request.get("rerankProvider") {
                        if let Some(rerank_model) = value_str(request, "rerankModel") {
                            object.insert(
                                "rerankProviderId".into(),
                                Value::String(
                                    value_str(rerank_provider, "id").unwrap_or("").to_string(),
                                ),
                            );
                            object.insert(
                                "rerankModel".into(),
                                Value::String(rerank_model.to_string()),
                            );
                        }
                    }
                }
            }
        }
        Err(error) => {
            if let Some(object) = result.as_object_mut() {
                object.insert(
                    "warning".into(),
                    Value::String(format!("嵌入模型处理失败，已保留知识图谱索引：{}", error)),
                );
            }
        }
    }
    result
}

async fn build_knowledge_index(request: &Value) -> Value {
    let structured = build_structured_table_index(request);
    let structured_chunks = structured
        .get("chunks")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut index_request = request.clone();
    if let Some(object) = index_request.as_object_mut() {
        if let Some(graph) = structured.get("graph") {
            object.insert("existingGraph".into(), graph.clone());
        }
    }

    let mut result = match llm_knowledge_index(&index_request).await {
        Ok(result) => result,
        Err(error) => {
            let mut fallback = simple_knowledge_index(&index_request);
            if let Some(object) = fallback.as_object_mut() {
                object.insert(
                    "warning".into(),
                    Value::String(format!(
                        "LLM 知识图谱生成失败，已使用本地索引兜底：{}",
                        error
                    )),
                );
            }
            fallback
        }
    };
    if !structured_chunks.is_empty() {
        if let Some(chunks) = result.get_mut("chunks").and_then(Value::as_array_mut) {
            let mut merged_chunks = structured_chunks;
            merged_chunks.append(chunks);
            *chunks = merged_chunks;
        } else if let Some(object) = result.as_object_mut() {
            object.insert("chunks".into(), Value::Array(structured_chunks));
        }
    }
    enrich_knowledge_index_with_models(result, request).await
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
    normalize_memory_profile(&mut profile);
    if let Some(emails) = profile.get_mut("emails").and_then(Value::as_array_mut) {
        for email in emails {
            let address = value_str(email, "address").unwrap_or("").to_string();
            let configured = has_credential_marker("email", &address)?;
            if let Some(object) = email.as_object_mut() {
                object.insert("credentialConfigured".into(), Value::Bool(configured));
            }
        }
    }
    Ok(profile)
}

fn fact_value(profile: &Value, predicate: &str) -> Option<String> {
    profile
        .get("facts")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .find(|fact| value_str(fact, "predicate") == Some(predicate))
        .and_then(|fact| value_str(fact, "value"))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn is_ipv4_address(value: &str) -> bool {
    let parts = value.trim().split('.').collect::<Vec<_>>();
    parts.len() == 4
        && parts
            .iter()
            .all(|part| !part.is_empty() && part.parse::<u8>().is_ok())
}

fn should_skip_memory_fact(predicate: &str, value: &str) -> bool {
    let predicate = predicate.trim().to_ascii_lowercase();
    let value = value.trim();
    if value.is_empty() {
        return true;
    }

    let blocked_predicates = [
        "password",
        "passwd",
        "secret",
        "api_key",
        "apikey",
        "access_token",
        "token",
        "filename",
        "file_name",
        "file path",
        "filepath",
        "generated_file",
        "generated_filename",
        "working_directory",
        "workspace_directory",
        "workdir",
        "cwd",
        "pwd",
        "server_ip",
        "host_ip",
        "ip_address",
        "文件名",
        "生成文件",
        "工作目录",
        "工作区目录",
        "服务器ip",
        "服务器 ip",
        "主机ip",
        "主机 ip",
    ];
    if blocked_predicates
        .iter()
        .any(|blocked| predicate.contains(blocked))
    {
        return true;
    }

    let looks_like_server_ip = is_ipv4_address(value)
        && ["server", "host", "服务器", "主机", "ip"]
            .iter()
            .any(|marker| predicate.contains(marker));
    looks_like_server_ip
}

fn normalize_memory_profile(profile: &mut Value) {
    if !profile.is_object() {
        *profile = json!({});
    }
    let object = profile
        .as_object_mut()
        .expect("memory profile is an object");
    if !object.get("facts").is_some_and(Value::is_array) {
        object.insert("facts".into(), json!([]));
    }
    if !object.get("relations").is_some_and(Value::is_array) {
        object.insert("relations".into(), json!([]));
    }
    if let Some(facts) = object.get_mut("facts").and_then(Value::as_array_mut) {
        facts.retain(|fact| {
            let predicate = value_str(fact, "predicate").unwrap_or("");
            let value = value_str(fact, "value").unwrap_or("");
            !should_skip_memory_fact(predicate, value)
        });
    }

    if let Some(name) = fact_value(profile, "name") {
        profile
            .as_object_mut()
            .unwrap()
            .insert("userName".into(), Value::String(name));
    }

    let mut assistant_profile = Map::new();
    for (predicate, key) in [
        ("assistant_name", "name"),
        ("assistant_gender", "gender"),
        ("assistant_personality", "personality"),
        ("assistant_tone", "tone"),
        ("assistant_avatar_data_url", "avatarDataUrl"),
    ] {
        if let Some(value) = fact_value(profile, predicate) {
            assistant_profile.insert(key.into(), Value::String(value));
        }
    }
    if !assistant_profile.is_empty() {
        profile
            .as_object_mut()
            .unwrap()
            .insert("assistantProfile".into(), Value::Object(assistant_profile));
    }

    let existing_emails = profile
        .get("emails")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut email_by_address = Map::new();
    for email in existing_emails {
        let address = value_str(&email, "address")
            .unwrap_or("")
            .trim()
            .to_lowercase();
        if !address.is_empty() {
            email_by_address.insert(address, email);
        }
    }

    for fact in profile
        .get("facts")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let predicate = value_str(fact, "predicate").unwrap_or("");
        if !matches!(predicate, "email" | "personal_email" | "work_email") {
            continue;
        }
        let address = value_str(fact, "value").unwrap_or("").trim().to_lowercase();
        if address.is_empty() {
            continue;
        }
        let email_type = match predicate {
            "personal_email" => "personal",
            "work_email" => "work",
            _ => "unknown",
        };
        let mut email = email_by_address
            .remove(&address)
            .unwrap_or_else(|| json!({}))
            .as_object()
            .cloned()
            .unwrap_or_default();
        email.insert("address".into(), Value::String(address.clone()));
        email.insert("type".into(), Value::String(email_type.into()));
        email.insert(
            "sourceFactId".into(),
            Value::String(value_str(fact, "id").unwrap_or("").into()),
        );
        email.insert("sourcePredicate".into(), Value::String(predicate.into()));
        email
            .entry("credentialConfigured")
            .or_insert(Value::Bool(false));
        email_by_address.insert(address, Value::Object(email));
    }

    let emails = email_by_address
        .into_iter()
        .map(|(_, email)| email)
        .collect::<Vec<_>>();
    profile
        .as_object_mut()
        .unwrap()
        .insert("emails".into(), Value::Array(emails));
}

fn memory_system_context(profile: &Value) -> Option<String> {
    let mut sections = Vec::new();

    if let Some(name) = value_str(profile, "userName") {
        sections.push(format!("用户姓名：{}", name));
    }

    let facts = profile
        .get("facts")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|fact| {
            let predicate = value_str(fact, "predicate")?;
            let value = value_str(fact, "value")?.trim();
            if predicate == "assistant_avatar_data_url" || should_skip_memory_fact(predicate, value)
            {
                return None;
            }
            Some(format!("- {}：{}", predicate, value))
        })
        .collect::<Vec<_>>();
    if !facts.is_empty() {
        sections.push(format!("已知个人信息：\n{}", facts.join("\n")));
    }

    let relations = profile
        .get("relations")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|relation| {
            let target = value_str(relation, "targetName")?;
            let relation_type = value_str(relation, "relationType").unwrap_or("related_to");
            Some(format!("- {}：{}", relation_type, target))
        })
        .collect::<Vec<_>>();
    if !relations.is_empty() {
        sections.push(format!("人物关系：\n{}", relations.join("\n")));
    }

    let emails = profile
        .get("emails")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|email| {
            let address = value_str(email, "address")?;
            let email_type = value_str(email, "type").unwrap_or("unknown");
            Some(format!("- {} ({})", address, email_type))
        })
        .collect::<Vec<_>>();
    if !emails.is_empty() {
        sections.push(format!("邮箱账号（不含凭据）：\n{}", emails.join("\n")));
    }

    let assistant_profile = profile.get("assistantProfile");
    let assistant_parts = [
        (
            "名称",
            assistant_profile.and_then(|item| value_str(item, "name")),
        ),
        (
            "性别",
            assistant_profile.and_then(|item| value_str(item, "gender")),
        ),
        (
            "性格",
            assistant_profile.and_then(|item| value_str(item, "personality")),
        ),
        (
            "语气",
            assistant_profile.and_then(|item| value_str(item, "tone")),
        ),
    ]
    .into_iter()
    .filter_map(|(label, value)| value.map(|value| format!("- {}：{}", label, value)))
    .collect::<Vec<_>>();
    if !assistant_parts.is_empty() {
        sections.push(format!(
            "用户设置的 AI 助理画像：\n{}",
            assistant_parts.join("\n")
        ));
    }

    if sections.is_empty() {
        return None;
    }
    Some(format!(
        "以下是长期记忆。请在相关时主动使用这些信息，保持称呼、语气和偏好一致；不要泄露或臆造未记录的信息。\n{}",
        sections.join("\n\n")
    ))
}

fn strip_json_fence(text: &str) -> &str {
    let trimmed = text.trim();
    if let Some(stripped) = trimmed.strip_prefix("```json") {
        return stripped.trim().trim_end_matches("```").trim();
    }
    if let Some(stripped) = trimmed.strip_prefix("```") {
        return stripped.trim().trim_end_matches("```").trim();
    }
    trimmed
}

fn upsert_extracted_fact(profile: &mut Value, category: &str, predicate: &str, value: &str) {
    let value = value.trim();
    if should_skip_memory_fact(predicate, value) {
        return;
    }
    let facts = profile
        .as_object_mut()
        .unwrap()
        .entry("facts")
        .or_insert_with(|| json!([]))
        .as_array_mut()
        .unwrap();
    if facts.iter().any(|fact| {
        value_str(fact, "predicate") == Some(predicate)
            && value_str(fact, "value")
                .map(|existing| existing.eq_ignore_ascii_case(value))
                .unwrap_or(false)
    }) {
        return;
    }
    if matches!(
        predicate,
        "name"
            | "job"
            | "company"
            | "location"
            | "language"
            | "timezone"
            | "personal_email"
            | "work_email"
            | "email"
    ) {
        if let Some(existing) = facts
            .iter_mut()
            .find(|fact| value_str(fact, "predicate") == Some(predicate))
        {
            *existing = json!({
                "id": value_str(existing, "id").unwrap_or("").to_string(),
                "category": category,
                "predicate": predicate,
                "value": value,
                "confidence": 0.86,
                "importance": 0.72,
                "updatedAt": now_iso()
            });
            return;
        }
    }
    facts.push(json!({
        "id": uuid::Uuid::new_v4().to_string(),
        "category": category,
        "predicate": predicate,
        "value": value,
        "confidence": 0.82,
        "importance": 0.66,
        "updatedAt": now_iso()
    }));
}

fn upsert_extracted_relation(profile: &mut Value, relation_type: &str, target_name: &str) {
    let target_name = target_name.trim();
    if target_name.is_empty() {
        return;
    }
    let source_name = value_str(profile, "userName").unwrap_or("我").to_string();
    let relations = profile
        .as_object_mut()
        .unwrap()
        .entry("relations")
        .or_insert_with(|| json!([]))
        .as_array_mut()
        .unwrap();
    if relations.iter().any(|relation| {
        value_str(relation, "relationType") == Some(relation_type)
            && value_str(relation, "targetName")
                .map(|existing| existing.eq_ignore_ascii_case(target_name))
                .unwrap_or(false)
    }) {
        return;
    }
    relations.push(json!({
        "id": uuid::Uuid::new_v4().to_string(),
        "targetEntityId": uuid::Uuid::new_v4().to_string(),
        "sourceName": source_name,
        "relationType": relation_type,
        "targetName": target_name,
        "confidence": 0.82
    }));
}

async fn extract_memory_from_conversation(
    app: &AppHandle,
    provider: &Value,
    model: &str,
    request: &Value,
    answer: &str,
) -> CommandResult<()> {
    let prompt = value_str(request, "prompt").unwrap_or("").trim();
    if prompt.is_empty() {
        return Ok(());
    }

    let extraction_prompt = format!(
        "请从这轮对话中抽取适合长期记忆的稳定事实。只记录用户明确提供的信息；不要记录临时任务、闲聊、猜测、密码、验证码、API Key、银行卡、访问令牌、生成文件名、服务器 IP、主机 IP、工作目录或工作区路径。\n\n用户消息：\n{}\n\n助手回答：\n{}\n\n只输出 JSON，格式：{{\"facts\":[{{\"category\":\"profile|preference|contact|work\",\"predicate\":\"name|job|company|location|language|timezone|preference|personal_email|work_email|email|custom:<中文标签>\",\"value\":\"...\"}}],\"relations\":[{{\"relationType\":\"friend|family|colleague|manager|partner|related_to\",\"targetName\":\"...\"}}]}}。没有可记忆内容时输出 {{\"facts\":[],\"relations\":[]}}。",
        prompt.chars().take(4000).collect::<String>(),
        answer.chars().take(2000).collect::<String>()
    );
    let extracted = chat_completion(
        provider,
        model,
        "你是长期记忆抽取器。必须只输出严格 JSON，不要解释。",
        vec![json!({ "role": "user", "content": extraction_prompt })],
    )
    .await?;
    let extracted: Value = serde_json::from_str(strip_json_fence(&extracted))?;

    let mut profile = load_memory(app).await?;
    for fact in extracted
        .get("facts")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let category = value_str(fact, "category").unwrap_or("profile");
        let predicate = value_str(fact, "predicate").unwrap_or("custom:备注");
        let value = value_str(fact, "value").unwrap_or("");
        upsert_extracted_fact(&mut profile, category, predicate, value);
    }
    for relation in extracted
        .get("relations")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let relation_type = value_str(relation, "relationType").unwrap_or("related_to");
        let target_name = value_str(relation, "targetName").unwrap_or("");
        upsert_extracted_relation(&mut profile, relation_type, target_name);
    }
    normalize_memory_profile(&mut profile);
    save_memory(app, &profile).await
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
    let root = resolve_workspace_directory(payload.workspace_directory)?;
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
    sync_snapshot_to_database(&root, &payload.snapshot).await
}

#[tauri::command]
async fn reindex_workspace(payload: WorkspaceDirectoryPayload) -> CommandResult<()> {
    let directory = resolve_workspace_directory(payload.workspace_directory)?;
    fs::create_dir_all(&directory).await?;
    let root = workspace_data_root(&directory);
    init_workspace_database(&root).await?;
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
    Ok(build_knowledge_index(&request).await)
}

#[tauri::command]
async fn embed_texts(request: Value) -> CommandResult<Vec<Vec<f64>>> {
    let provider = request
        .get("provider")
        .ok_or_else(|| CommandError::Message("缺少嵌入模型 Provider。".into()))?;
    let model = value_str(&request, "model").unwrap_or("");
    let texts = request
        .get("texts")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(ToOwned::to_owned)
        .collect::<Vec<_>>();
    embedding_vectors(provider, model, texts).await
}

#[tauri::command]
async fn rerank_documents(request: Value) -> CommandResult<Vec<f64>> {
    let provider = request
        .get("provider")
        .ok_or_else(|| CommandError::Message("缺少 rerank 模型 Provider。".into()))?;
    let model = value_str(&request, "model").unwrap_or("");
    let query = value_str(&request, "query").unwrap_or("");
    let documents = request
        .get("documents")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(ToOwned::to_owned)
        .collect::<Vec<_>>();
    rerank_scores(provider, model, query, documents).await
}

#[tauri::command]
async fn transcribe_audio(request: Value) -> CommandResult<String> {
    transcribe_audio_with_provider(&request).await
}

#[tauri::command]
async fn synthesize_speech(request: Value) -> CommandResult<Vec<u8>> {
    synthesize_speech_with_provider(&request).await
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
    let index_result = build_knowledge_index(&index_request).await;
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
    let mut plaintext = load_secret_vault_plaintext()?;
    plaintext.items.insert(
        credential_key(&request.scope, &request.id),
        SecretVaultItem {
            secret: request.secret.trim().to_string(),
            updated_at: now_iso(),
        },
    );
    save_secret_vault_plaintext(&plaintext)
}

#[tauri::command]
async fn delete_credential(request: CredentialStatusRequest) -> CommandResult<()> {
    let mut plaintext = load_secret_vault_plaintext()?;
    plaintext
        .items
        .remove(&credential_key(&request.scope, &request.id));
    save_secret_vault_plaintext(&plaintext)
}

#[tauri::command]
async fn has_credential(request: CredentialStatusRequest) -> CommandResult<bool> {
    has_credential_marker(&request.scope, &request.id)
}

#[tauri::command]
fn secret_vault_status() -> CommandResult<SecretVaultStatus> {
    let runtime = secret_vault_runtime()?;
    let unlocked = runtime
        .session
        .lock()
        .map_err(|_| CommandError::Message("安全保险箱状态锁定失败。".into()))?
        .is_some();
    let file = read_secret_vault_file()?;
    Ok(SecretVaultStatus {
        exists: file.is_some(),
        unlocked,
        item_count: file.map(|file| file.item_keys.len()).unwrap_or_default(),
    })
}

#[tauri::command]
fn unlock_secret_vault(request: SecretVaultUnlockRequest) -> CommandResult<SecretVaultStatus> {
    let password = request.password.trim();
    if password.chars().count() < 8 {
        return Err(CommandError::Message("主密码至少需要 8 个字符。".into()));
    }

    let file = read_secret_vault_file()?;
    let (key, salt, plaintext) = if let Some(file) = file.as_ref() {
        let salt = file.salt.clone();
        let key = derive_secret_vault_key(password, &decode_base64(&salt)?)?;
        let plaintext = decrypt_secret_vault_plaintext(file, &key)?;
        (key, salt, plaintext)
    } else {
        let salt_bytes = random_bytes::<16>();
        let salt = general_purpose::STANDARD.encode(salt_bytes);
        let key = derive_secret_vault_key(password, &salt_bytes)?;
        (
            key,
            salt,
            SecretVaultPlaintext {
                items: HashMap::new(),
            },
        )
    };

    {
        let runtime = secret_vault_runtime()?;
        let mut guard = runtime
            .session
            .lock()
            .map_err(|_| CommandError::Message("安全保险箱状态锁定失败。".into()))?;
        *guard = Some(SecretVaultSession { key, salt });
    }

    if file.is_none() {
        save_secret_vault_plaintext(&plaintext)?;
    }
    secret_vault_status()
}

#[tauri::command]
fn lock_secret_vault() -> CommandResult<SecretVaultStatus> {
    {
        let runtime = secret_vault_runtime()?;
        let mut guard = runtime
            .session
            .lock()
            .map_err(|_| CommandError::Message("安全保险箱状态锁定失败。".into()))?;
        *guard = None;
    }
    secret_vault_status()
}

#[tauri::command]
fn reset_secret_vault() -> CommandResult<SecretVaultStatus> {
    {
        let runtime = secret_vault_runtime()?;
        let mut guard = runtime
            .session
            .lock()
            .map_err(|_| CommandError::Message("安全保险箱状态锁定失败。".into()))?;
        *guard = None;
        if runtime.path.exists() {
            std::fs::remove_file(&runtime.path)?;
        }
    }
    secret_vault_status()
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
    let memory_context = load_memory(&app)
        .await
        .ok()
        .and_then(|profile| memory_system_context(&profile));
    let mut tool_contexts = Vec::new();
    if request_tool_enabled(&request, &assistant, "tool-shell-command") {
        tool_contexts.push("你已启用 run_command 和 run_ssh_command 工具。对于用户要求的本地或远程系统检查，可以调用工具；运行时会在真正执行前向用户请求授权。不要绕过授权，也不要要求用户复制命令自行运行。用户提供的 SSH 密码可用于本次受控连接，但不得在回复中回显、保存或记录。输出必须精简：不要复述用户目标，不要写安全免责声明、执行计划、确认问题、PDF/脚本/离线指南推荐；工具成功后只给结论、关键数据和必要下一步。");
    }
    if request_tool_enabled(&request, &assistant, "tool-search") {
        tool_contexts.push("你已启用 web_search 联网搜索工具。对于今日新闻、最新、当前、最近、价格、政策、版本、赛事等依赖实时信息的问题，必须先调用 web_search，再基于搜索结果回答；回答中保留关键来源链接，并区分搜索结果事实和你的归纳。");
    }
    let tool_context = tool_contexts.join("\n\n");
    let system = [
        value_str(&assistant, "systemPrompt").unwrap_or("你是 Emphant Studio 中的 AI 助手。"),
        memory_context.as_deref().unwrap_or(""),
        tool_context.as_str(),
        "你运行在 Emphant Studio 的受控工作区中。回答应直接、可靠，必要时说明限制。",
        &format!(
            "当用户要求生成代码、文档或其他可保存文件时，请把每个文件作为独立 fenced code block 输出，并在代码块信息中写明相对路径，例如 ```ts path=src/example.ts 或 ```markdown path=docs/report.md。系统会自动保存到工作目录的 {} 文件夹中。",
            generated_directory.to_string_lossy()
        ),
    ]
    .into_iter()
    .filter(|part| !part.trim().is_empty())
    .collect::<Vec<_>>()
    .join("\n\n");
    if let Err(error) = validate_agent_configuration(&provider, &assistant, &model) {
        log_agent_failure(&run_id, &request, &assistant, &provider, &model, &error);
        let error_message = error.to_string();
        let _ = app.emit(
            "agent:event",
            json!({ "runId": run_id, "type": "error", "message": error_message.clone() }),
        );
        return Ok(json!({ "runId": run_id, "status": "error", "errorMessage": error_message }));
    }
    if openclaw_core_enabled(&request) && value_str(&request, "routingMode") == Some("main") {
        let result = run_openclaw_embedded_agent(
            app.clone(),
            request.clone(),
            run_id.clone(),
            provider.clone(),
            assistant.clone(),
            model.clone(),
            system,
            workspace,
        )
        .await;
        if let Err(error) = &result {
            log_agent_failure(&run_id, &request, &assistant, &provider, &model, error);
            let _ = app.emit(
                "agent:event",
                json!({ "runId": run_id, "type": "error", "message": error.to_string() }),
            );
        }
        return result;
    }
    let result = if runtime_tool_enabled(&request, &assistant) {
        chat_completion_with_workspace_tools(
            &app,
            &run_id,
            &request,
            &assistant,
            &provider,
            &model,
            &system,
            model_messages(&request, false),
            &workspace,
        )
        .await
    } else {
        chat_completion_stream(
            &app,
            &run_id,
            &provider,
            &model,
            &system,
            model_messages(&request, false),
        )
        .await
    };
    match result {
        Ok(answer) => {
            emit_generated_files_saved(&app, &run_id, &request, &answer).await?;
            if !answer.trim().is_empty() {
                let _ =
                    extract_memory_from_conversation(&app, &provider, &model, &request, &answer)
                        .await;
            }
            let _ = app.emit(
                "agent:event",
                json!({ "runId": run_id, "type": "finish", "finishReason": "stop" }),
            );
            Ok(json!({ "runId": run_id, "status": "completed" }))
        }
        Err(error) => {
            log_agent_failure(&run_id, &request, &assistant, &provider, &model, &error);
            let error_message = error.to_string();
            let _ = app.emit(
                "agent:event",
                json!({ "runId": run_id, "type": "error", "message": error_message.clone() }),
            );
            Ok(json!({ "runId": run_id, "status": "error", "errorMessage": error_message }))
        }
    }
}

#[tauri::command]
async fn approve_agent(response: Value) -> CommandResult<Value> {
    let run_id = value_str(&response, "runId")
        .ok_or_else(|| CommandError::Message("缺少 runId。".into()))?;
    let approval_id = value_str(&response, "approvalId")
        .ok_or_else(|| CommandError::Message("缺少 approvalId。".into()))?;
    let approved = response
        .get("approved")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let reason = value_str(&response, "reason").map(ToOwned::to_owned);
    let sender = {
        let mut pending = pending_approvals()
            .lock()
            .map_err(|_| CommandError::Message("工具审批状态锁定失败。".into()))?;
        pending.remove(&approval_key(run_id, approval_id))
    };
    let Some(sender) = sender else {
        return Err(CommandError::Message("审批请求不存在或已过期。".into()));
    };
    sender
        .send(PendingApproval { approved, reason })
        .map_err(|_| CommandError::Message("审批请求已结束。".into()))?;
    Ok(json!({
      "runId": run_id,
      "status": "awaiting-approval"
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
            .map(|name| format!("{}，把目标、材料或一个粗略想法发过来，我会沿着当前会话的上下文继续。", name))
            .unwrap_or_else(|| "把目标、材料或一个粗略想法发过来，我会沿着当前会话的上下文继续。".into())
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

fn email_has_credential_marker(address: &str) -> CommandResult<bool> {
    has_credential_marker("email", &address.trim().to_lowercase())
}

fn email_profile_address(profile: &Value) -> Option<String> {
    value_str(profile, "address")
        .map(str::trim)
        .filter(|address| !address.is_empty())
        .map(|address| address.to_lowercase())
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

fn mail_sender_from_headers(headers: &mailparse::headers::Headers<'_>) -> (String, String) {
    let raw_from = headers
        .get_first_value("From")
        .unwrap_or_else(|| "未知发件人".into());
    let Some(header) = headers.get_first_header("From") else {
        return (raw_from, String::new());
    };
    let Some(sender) = mailparse::addrparse_header(header)
        .ok()
        .and_then(|addresses| addresses.extract_single_info())
    else {
        return (raw_from, String::new());
    };
    (
        sender
            .display_name
            .filter(|name| !name.trim().is_empty())
            .unwrap_or_else(|| sender.addr.clone()),
        sender.addr,
    )
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
        let imap_secure = credential
            .get("imapSecure")
            .and_then(Value::as_bool)
            .unwrap_or(true);
        let username = value_str(&credential, "username")
            .unwrap_or(&address_for_task)
            .to_string();
        let secret = value_str(&credential, "secret")
            .ok_or("缺少邮箱密钥")?
            .to_string();
        let tls = native_tls::TlsConnector::builder()
            .build()
            .map_err(|error| error.to_string())?;
        let client = if imap_secure {
            imap::connect((host.as_str(), port), host.as_str(), &tls)
        } else {
            imap::connect_starttls((host.as_str(), port), host.as_str(), &tls)
        }
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
            .fetch(sequence_numbers.join(","), "BODY.PEEK[]")
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
            let (sender, sender_email) = mail_sender_from_headers(&headers);
            let message_id = headers
                .get_first_value("Message-ID")
                .unwrap_or_else(|| format!("{}:{}", address_for_task, fetch.message));
            let text = parsed_mail_text(&parsed).replace(char::is_whitespace, " ");
            messages.push(json!({
                "id": format!("{}:{}", address_for_task, message_id),
                "accountAddress": address_for_task,
                "accountType": account_type,
                "sender": sender,
                "senderEmail": sender_email,
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
    let next_secret = value_str(&request, "secret")
        .map(str::trim)
        .filter(|secret| !secret.is_empty());
    if let Some(secret) = next_secret {
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
    let existing_email = profile
        .get("emails")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .find(|item| value_str(item, "address") == Some(email.as_str()))
        .cloned();
    let credential_configured = next_secret.is_some()
        || existing_email
            .as_ref()
            .and_then(|item| item.get("credentialConfigured"))
            .and_then(Value::as_bool)
            .unwrap_or(false)
        || email_has_credential_marker(&email)?;
    let email_record = json!({
        "address": email,
        "type": value_str(existing_email.as_ref().unwrap_or(&Value::Null), "type").unwrap_or("unknown"),
        "sourceFactId": value_str(existing_email.as_ref().unwrap_or(&Value::Null), "sourceFactId").unwrap_or(""),
        "sourcePredicate": value_str(existing_email.as_ref().unwrap_or(&Value::Null), "sourcePredicate").unwrap_or(""),
        "credentialConfigured": credential_configured,
        "credentialType": value_str(&request, "credentialType")
            .or_else(|| existing_email.as_ref().and_then(|item| value_str(item, "credentialType")))
            .unwrap_or("password"),
        "username": value_str(&request, "username").unwrap_or(&email),
        "imapHost": value_str(&request, "imapHost").unwrap_or(""),
        "imapPort": request.get("imapPort").and_then(Value::as_u64).unwrap_or(993),
        "imapSecure": request.get("imapSecure").and_then(Value::as_bool).unwrap_or(true),
        "smtpHost": value_str(&request, "smtpHost").unwrap_or(""),
        "smtpPort": request.get("smtpPort").and_then(Value::as_u64).unwrap_or(465),
        "smtpSecure": request.get("smtpSecure").and_then(Value::as_bool).unwrap_or(true)
    });
    let mut email_record = email_record.as_object().cloned().unwrap_or_default();
    if email_record
        .get("sourceFactId")
        .and_then(Value::as_str)
        .unwrap_or("")
        .is_empty()
    {
        email_record.remove("sourceFactId");
    }
    if email_record
        .get("sourcePredicate")
        .and_then(Value::as_str)
        .unwrap_or("")
        .is_empty()
    {
        email_record.remove("sourcePredicate");
    }
    let emails = profile
        .as_object_mut()
        .unwrap()
        .entry("emails")
        .or_insert_with(|| json!([]))
        .as_array_mut()
        .unwrap();
    emails.retain(|item| value_str(item, "address") != Some(email.as_str()));
    emails.push(Value::Object(email_record));
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
        for item in emails {
            if value_str(item, "address") == Some(email.as_str()) {
                if let Some(object) = item.as_object_mut() {
                    object.insert("credentialConfigured".into(), Value::Bool(false));
                }
            }
        }
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
        .filter_map(|email| {
            let address = email_profile_address(email)?;
            match email_has_credential_marker(&address) {
                Ok(true) => Some(email.clone()),
                _ => None,
            }
        })
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
async fn send_email(app: AppHandle, request: Value) -> CommandResult<Value> {
    let requested_account = value_str(&request, "accountAddress")
        .unwrap_or("")
        .trim()
        .to_lowercase();
    let account = if requested_account.is_empty() {
        load_memory(&app)
            .await?
            .get("emails")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(email_profile_address)
            .find(|address| email_has_credential_marker(address).unwrap_or(false))
            .ok_or_else(|| CommandError::Message("请先配置一个可发送邮件的邮箱凭据。".into()))?
    } else {
        requested_account
    };
    let credential = email_credential_value(&account)?.ok_or_else(|| {
        CommandError::Message(format!("邮箱 {} 未配置完整的 SMTP 凭据。", account))
    })?;
    let to = value_str(&request, "to").unwrap_or("").to_string();
    let subject = value_str(&request, "subject").unwrap_or("").to_string();
    let text = value_str(&request, "text").unwrap_or("").to_string();
    let message_id = tokio::task::spawn_blocking(move || -> Result<String, String> {
        use lettre::{
            message::Mailbox,
            transport::smtp::{
                authentication::Credentials,
                client::{Tls, TlsParameters},
            },
            Message, SmtpTransport, Transport,
        };
        let smtp_host = value_str(&credential, "smtpHost")
            .ok_or("缺少 SMTP Host")?
            .to_string();
        let smtp_port = credential
            .get("smtpPort")
            .and_then(Value::as_u64)
            .unwrap_or(465) as u16;
        let smtp_secure = credential
            .get("smtpSecure")
            .and_then(Value::as_bool)
            .unwrap_or(true);
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
        let tls_parameters =
            TlsParameters::new(smtp_host.clone()).map_err(|error| error.to_string())?;
        let mut mailer_builder = if smtp_secure {
            SmtpTransport::builder_dangerous(&smtp_host).tls(Tls::Wrapper(tls_parameters))
        } else {
            SmtpTransport::builder_dangerous(&smtp_host).tls(Tls::Required(tls_parameters))
        };
        mailer_builder = mailer_builder.port(smtp_port).credentials(credentials);
        let mailer = mailer_builder.build();
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
            reindex_workspace,
            save_knowledge_source,
            read_knowledge_source,
            index_knowledge_source,
            embed_texts,
            rerank_documents,
            transcribe_audio,
            synthesize_speech,
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
            secret_vault_status,
            unlock_secret_vault,
            lock_secret_vault,
            reset_secret_vault,
            list_provider_models,
            test_mcp_server
        ])
        .setup(|app| {
            let data_dir = app_data_directory(&app.handle())?;
            std::fs::create_dir_all(data_dir)?;
            let _ = SECRET_VAULT_RUNTIME.set(SecretVaultRuntime {
                path: app_data_directory(&app.handle())?.join(SECRET_VAULT_FILE),
                session: Mutex::new(None),
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Emphant Studio Tauri application");
}
