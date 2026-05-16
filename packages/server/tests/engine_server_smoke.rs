use std::{
    net::{SocketAddr, TcpListener},
    path::PathBuf,
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};

use photon_engine::{
    ActorId, HybridTimestamp, Operation, OperationKind, PullRequest, PullResult, PushDecision,
    PushRequest, PushResult, RecordKey, ScopeId,
};
use serde::{de::DeserializeOwned, Serialize};
use serde_json::{json, Value};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
    time::sleep,
};

struct EngineServer {
    addr: SocketAddr,
    child: Child,
    app_database_path: PathBuf,
    database_path: PathBuf,
}

impl EngineServer {
    async fn spawn() -> Self {
        let addr = SocketAddr::from(([127, 0, 0, 1], free_port()));
        let app_database_path = std::env::temp_dir().join(format!(
            "photon-engine-server-app-smoke-{}-{}.db",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let database_path = std::env::temp_dir().join(format!(
            "photon-engine-server-smoke-{}-{}.db",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let app_database_url = format!("sqlite:{}?mode=rwc", app_database_path.display());
        let database_url = format!("sqlite:{}?mode=rwc", database_path.display());
        let child = Command::new(env!("CARGO_BIN_EXE_photon-engine-server"))
            .env("PHOTON_ENGINE_PORT", addr.port().to_string())
            .env("PHOTON_ENGINE_APP_DATABASE_URL", &app_database_url)
            .env("PHOTON_ENGINE_DATABASE_URL", &database_url)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn Photon Engine server");
        let mut server = Self {
            addr,
            child,
            app_database_path,
            database_path,
        };
        server.wait_until_ready().await;
        server
    }

    async fn wait_until_ready(&mut self) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            if let Some(status) = self.child.try_wait().expect("poll Photon Engine server") {
                panic!("Photon Engine server exited before readiness: {status}");
            }
            if let Ok((status, body)) =
                request_json::<Value, ()>(self.addr, "GET", "/api/health", None).await
            {
                if status == 200 && body["status"] == "ok" {
                    return;
                }
            }
            sleep(Duration::from_millis(50)).await;
        }
        panic!("Photon Engine server did not become ready at {}", self.addr);
    }
}

impl Drop for EngineServer {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        remove_sqlite_files(&self.app_database_path);
        remove_sqlite_files(&self.database_path);
    }
}

fn remove_sqlite_files(path: &PathBuf) {
    let _ = std::fs::remove_file(path);
    let _ = std::fs::remove_file(path.with_extension("db-shm"));
    let _ = std::fs::remove_file(path.with_extension("db-wal"));
}

#[tokio::test]
async fn photon_engine_server_accepts_push_and_returns_pull() {
    let server = EngineServer::spawn().await;
    let scope = ScopeId::from("workspace:server-smoke");
    let operation = Operation::new(
        RecordKey::new(scope.as_str(), "smoke_records", "record-1"),
        ActorId::from("engine-smoke-client"),
        OperationKind::Upsert {
            value: json!({
                "id": "record-1",
                "title": "Engine server smoke",
                "source": "packages/server/tests/engine_server_smoke.rs"
            }),
        },
    )
    .with_id(format!("op-server-smoke-{}", uuid::Uuid::new_v4()))
    .with_timestamp(HybridTimestamp::new(1, 0, "engine-smoke-client"));

    let (push_status, push) = request_json::<PushResult, _>(
        server.addr,
        "POST",
        "/api/engine/push",
        Some(&PushRequest {
            scope: scope.clone(),
            operations: vec![operation.clone()],
            cursor: None,
        }),
    )
    .await
    .expect("push to Photon Engine server");
    assert_eq!(push_status, 200);
    assert_eq!(push.decisions.len(), 1);
    let remote_sequence = match &push.decisions[0] {
        PushDecision::Accepted {
            operation_id,
            remote_sequence,
        } if operation_id == &operation.id => *remote_sequence,
        decision => panic!(
            "expected accepted decision for {}, got {decision:?}",
            operation.id
        ),
    };
    assert!(remote_sequence > 0);

    let (pull_status, pull) = request_json::<PullResult, _>(
        server.addr,
        "POST",
        "/api/engine/pull",
        Some(&PullRequest {
            scope,
            cursor: None,
        }),
    )
    .await
    .expect("pull from Photon Engine server");
    assert_eq!(pull_status, 200);
    let pulled = pull
        .operations
        .iter()
        .find(|pulled| pulled.operation.id == operation.id)
        .expect("pull should include smoke operation");
    assert_eq!(pulled.remote_sequence, remote_sequence);
}

async fn request_json<T, B>(
    addr: SocketAddr,
    method: &str,
    path: &str,
    body: Option<&B>,
) -> Result<(u16, T), Box<dyn std::error::Error + Send + Sync>>
where
    T: DeserializeOwned,
    B: Serialize,
{
    let body = body
        .map(serde_json::to_string)
        .transpose()?
        .unwrap_or_default();
    let mut stream = TcpStream::connect(addr).await?;
    let request = format!(
        "{method} {path} HTTP/1.1\r\n\
         Host: {addr}\r\n\
         Content-Type: application/json\r\n\
         Content-Length: {}\r\n\
         Connection: close\r\n\
         \r\n\
         {body}",
        body.len()
    );
    stream.write_all(request.as_bytes()).await?;

    let mut response = Vec::new();
    stream.read_to_end(&mut response).await?;
    let text = String::from_utf8(response)?;
    let (head, body) = text
        .split_once("\r\n\r\n")
        .ok_or("HTTP response missing header/body separator")?;
    let status = head
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .ok_or("HTTP response missing status")?
        .parse::<u16>()?;
    Ok((status, serde_json::from_str(body)?))
}

fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .expect("bind free local port")
        .local_addr()
        .expect("read local addr")
        .port()
}
