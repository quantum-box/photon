use std::{
    collections::BTreeMap,
    net::{SocketAddr, TcpListener},
    path::PathBuf,
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};

use async_trait::async_trait;
use photon_engine::{
    ActorId, CollectionName, EngineError, HybridTimestamp, Operation, OperationKind,
    OperationStatus, PhotonEngine, PullRequest, PullResult, PushRequest, PushResult, Record,
    RecordKey, ScopeId, SqliteAdapter, StorageAdapter, SyncEndpoint,
};
use serde::{de::DeserializeOwned, Serialize};
use serde_json::{json, Value};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
    time::sleep,
};

const REMOTE_ID: &str = "mock-tachyon-api";

struct MockTachyonApi {
    addr: SocketAddr,
    child: Child,
    database_path: PathBuf,
}

impl MockTachyonApi {
    async fn spawn() -> Self {
        let addr = SocketAddr::from(([127, 0, 0, 1], free_port()));
        let database_path = std::env::temp_dir().join(format!(
            "mock-tachyon-api-integration-{}-{}.db",
            std::process::id(),
            photon_engine::OperationId::random().as_str()
        ));
        let database_url = format!("sqlite:{}?mode=rwc", database_path.display());
        let child = Command::new(env!("CARGO_BIN_EXE_mock-tachyon-api"))
            .env("MOCK_TACHYON_PORT", addr.port().to_string())
            .env("MOCK_TACHYON_DATABASE_URL", &database_url)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn mock Tachyon API");
        let mut server = Self {
            addr,
            child,
            database_path,
        };
        server.wait_until_ready().await;
        server
    }

    fn endpoint(&self) -> HttpSyncEndpoint {
        HttpSyncEndpoint { addr: self.addr }
    }

    async fn record(&self, key: &RecordKey) -> (u16, Option<Record>) {
        let path = format!(
            "/v1/records/{}/{}/{}",
            key.scope.as_str(),
            key.collection.as_str(),
            key.record_id.as_str()
        );
        request_json::<Option<Record>, ()>(self.addr, "GET", &path, None)
            .await
            .expect("read record from mock Tachyon API")
    }

    async fn reset(&self) -> u16 {
        request_empty(self.addr, "POST", "/__admin/reset")
            .await
            .expect("reset mock Tachyon API")
    }

    async fn wait_until_ready(&mut self) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if let Some(status) = self.child.try_wait().expect("poll mock Tachyon API") {
                panic!("mock Tachyon API exited before readiness: {status}");
            }
            if let Ok((status, body)) =
                request_json::<Value, ()>(self.addr, "GET", "/health", None).await
            {
                if status == 200 && body["remote"] == REMOTE_ID {
                    return;
                }
            }
            sleep(Duration::from_millis(50)).await;
        }
        panic!("mock Tachyon API did not become ready at {}", self.addr);
    }
}

impl Drop for MockTachyonApi {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_file(&self.database_path);
        let _ = std::fs::remove_file(self.database_path.with_extension("db-shm"));
        let _ = std::fs::remove_file(self.database_path.with_extension("db-wal"));
    }
}

#[derive(Clone)]
struct HttpSyncEndpoint {
    addr: SocketAddr,
}

#[async_trait]
impl SyncEndpoint for HttpSyncEndpoint {
    async fn push(&self, request: PushRequest) -> photon_engine::Result<PushResult> {
        self.post_json("/v1/sync/push", &request).await
    }

    async fn pull(&self, request: PullRequest) -> photon_engine::Result<PullResult> {
        self.post_json("/v1/sync/pull", &request).await
    }
}

impl HttpSyncEndpoint {
    async fn post_json<T, B>(&self, path: &str, body: &B) -> photon_engine::Result<T>
    where
        T: DeserializeOwned,
        B: Serialize,
    {
        let (status, body) = request_json(self.addr, "POST", path, Some(body))
            .await
            .map_err(EngineError::Storage)?;
        if status != 200 {
            return Err(EngineError::Storage(format!(
                "mock Tachyon API returned HTTP {status} for {path}"
            )));
        }
        Ok(body)
    }
}

#[tokio::test]
async fn sync_once_converges_arbitrary_collections_through_mock_tachyon_api() {
    let server = MockTachyonApi::spawn().await;
    let endpoint = server.endpoint();
    let client_a = sqlite_engine().await;
    let client_b = sqlite_engine().await;
    let issue_key = RecordKey::new("workspace:integration", "issues", "issue-1");
    let widget_key = RecordKey::new("workspace:integration", "widgets", "widget-1");
    let issue = patch(
        issue_key.clone(),
        "client-a",
        10,
        json!({ "title": "from mock Tachyon API", "status": "todo" }),
    )
    .with_id("op-integration-issue");
    let widget = upsert(
        widget_key.clone(),
        "client-a",
        11,
        json!({
            "name": "portable sync payload",
            "dimensions": { "width": 12, "height": 8 },
            "tags": ["custom", "non-issue"]
        }),
    )
    .with_id("op-integration-widget");

    client_a.apply_local_operation(issue.clone()).await.unwrap();
    client_a
        .apply_local_operation(widget.clone())
        .await
        .unwrap();

    let summary_a = client_a
        .sync_once("workspace:integration", REMOTE_ID, &endpoint)
        .await
        .unwrap();
    let summary_b = client_b
        .sync_once("workspace:integration", REMOTE_ID, &endpoint)
        .await
        .unwrap();

    assert_eq!(summary_a.pushed, 2);
    assert_eq!(summary_a.pulled, 0);
    assert_eq!(summary_b.pulled, 2);

    let issue_b = client_b.record(&issue_key).await.unwrap().unwrap();
    let widget_b = client_b.record(&widget_key).await.unwrap().unwrap();
    assert_eq!(issue_b.value["status"], "todo");
    assert_eq!(widget_b.value["dimensions"]["width"], 12);
    assert_eq!(widget_b.value["tags"], json!(["custom", "non-issue"]));

    let accepted_issue = client_a
        .storage()
        .get_operation(&issue.id)
        .await
        .unwrap()
        .unwrap();
    let accepted_widget = client_a
        .storage()
        .get_operation(&widget.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(accepted_issue.status, OperationStatus::Accepted);
    assert_eq!(accepted_widget.status, OperationStatus::Accepted);
    assert_eq!(accepted_issue.remote_sequence, Some(1));
    assert_eq!(accepted_widget.remote_sequence, Some(2));

    let (status, remote_widget) = server.record(&widget_key).await;
    assert_eq!(status, 200);
    assert_eq!(
        remote_widget.unwrap().value["name"],
        "portable sync payload"
    );

    assert_eq!(server.reset().await, 204);
    let (status, remote_widget) = server.record(&widget_key).await;
    assert_eq!(status, 404);
    assert!(remote_widget.is_none());
}

#[tokio::test]
async fn mock_tachyon_api_conflicts_are_recorded_by_sync_once() {
    let server = MockTachyonApi::spawn().await;
    let endpoint = server.endpoint();
    let storage = SqliteAdapter::connect("sqlite::memory:").await.unwrap();
    let client = PhotonEngine::new(storage.clone());
    let operation = patch(
        RecordKey::new("workspace:integration", "issues", "issue-conflict"),
        "client-a",
        10,
        json!({ "status": "done" }),
    )
    .with_id("op-integration-conflict")
    .with_metadata(json!({ "mock_conflict_reason": "integration conflict" }));

    client
        .apply_local_operation(operation.clone())
        .await
        .unwrap();
    let first_summary = client
        .sync_once("workspace:integration", REMOTE_ID, &endpoint)
        .await
        .unwrap();
    let second_summary = client
        .sync_once("workspace:integration", REMOTE_ID, &endpoint)
        .await
        .unwrap();
    let stored = storage.get_operation(&operation.id).await.unwrap().unwrap();
    let conflicts = storage
        .list_conflicts(
            &ScopeId::from("workspace:integration"),
            Some(&CollectionName::from("issues")),
            Some(&operation.key.record_id),
        )
        .await
        .unwrap();

    assert_eq!(first_summary.pushed, 1);
    assert_eq!(first_summary.conflicts, 1);
    assert_eq!(second_summary.pushed, 0);
    assert_eq!(stored.status, OperationStatus::Conflict);
    assert_eq!(conflicts.len(), 1);
    assert_eq!(conflicts[0].operation_id, operation.id);
    assert_eq!(conflicts[0].reason, "integration conflict");
}

async fn sqlite_engine() -> PhotonEngine<SqliteAdapter> {
    PhotonEngine::new(SqliteAdapter::connect("sqlite::memory:").await.unwrap())
}

fn patch(key: RecordKey, actor: &str, wall_time_ms: i64, fields: Value) -> Operation {
    let fields = fields
        .as_object()
        .unwrap()
        .iter()
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect::<BTreeMap<_, _>>();

    Operation::new(key, ActorId::from(actor), OperationKind::Patch { fields })
        .with_timestamp(HybridTimestamp::new(wall_time_ms, 0, actor))
}

fn upsert(key: RecordKey, actor: &str, wall_time_ms: i64, value: Value) -> Operation {
    Operation::new(key, ActorId::from(actor), OperationKind::Upsert { value })
        .with_timestamp(HybridTimestamp::new(wall_time_ms, 0, actor))
}

fn free_port() -> u16 {
    TcpListener::bind(("127.0.0.1", 0))
        .expect("bind temporary port")
        .local_addr()
        .expect("read temporary port")
        .port()
}

async fn request_empty(addr: SocketAddr, method: &str, path: &str) -> Result<u16, String> {
    let (status, ()) = request_json::<(), ()>(addr, method, path, None).await?;
    Ok(status)
}

async fn request_json<T, B>(
    addr: SocketAddr,
    method: &str,
    path: &str,
    body: Option<&B>,
) -> Result<(u16, T), String>
where
    T: DeserializeOwned,
    B: Serialize,
{
    let body = body
        .map(serde_json::to_vec)
        .transpose()
        .map_err(|error| error.to_string())?
        .unwrap_or_default();
    let mut stream = TcpStream::connect(addr)
        .await
        .map_err(|error| error.to_string())?;
    let request = format!(
        "{method} {path} HTTP/1.1\r\n\
         Host: {addr}\r\n\
         Accept: application/json\r\n\
         Content-Type: application/json\r\n\
         Content-Length: {}\r\n\
         Connection: close\r\n\
         \r\n",
        body.len()
    );
    stream
        .write_all(request.as_bytes())
        .await
        .map_err(|error| error.to_string())?;
    stream
        .write_all(&body)
        .await
        .map_err(|error| error.to_string())?;

    let mut response = Vec::new();
    stream
        .read_to_end(&mut response)
        .await
        .map_err(|error| error.to_string())?;
    parse_json_response(&response)
}

fn parse_json_response<T>(response: &[u8]) -> Result<(u16, T), String>
where
    T: DeserializeOwned,
{
    let split = response
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .ok_or_else(|| "missing HTTP header separator".to_owned())?;
    let headers = std::str::from_utf8(&response[..split]).map_err(|error| error.to_string())?;
    let status = headers
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .ok_or_else(|| "missing HTTP status".to_owned())?
        .parse::<u16>()
        .map_err(|error| error.to_string())?;
    let body = &response[split + 4..];

    if body.is_empty() {
        return serde_json::from_slice(b"null")
            .map(|body| (status, body))
            .map_err(|error| error.to_string());
    }

    serde_json::from_slice(body)
        .map(|body| (status, body))
        .map_err(|error| error.to_string())
}
