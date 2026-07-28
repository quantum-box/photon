//! The Rust client and the TypeScript client (through the WASM kernel) must
//! turn the same intent into the same bytes. The TypeScript half of this
//! contract lives in
//! `examples/playground/src/lib/photonEngine/operationParity.test.ts` and
//! asserts against the same fixture.

use photon_client::{OperationKind, PhotonClient};
use serde::Deserialize;

#[derive(Deserialize)]
struct Fixture {
    actor_id: String,
    now_ms: i64,
    intent: Intent,
    expected_operation_json: String,
}

#[derive(Deserialize)]
struct Intent {
    key: IntentKey,
    kind: serde_json::Value,
    operation_id: String,
    metadata: serde_json::Value,
}

#[derive(Deserialize)]
struct IntentKey {
    scope: String,
    collection: String,
    record_id: String,
}

const FIXTURE: &str = include_str!("fixtures/operation_parity.json");

fn fixture_clock() -> i64 {
    // Must match now_ms in the fixture. include_str! is compile-time, so the
    // clock cannot read the parsed value; the test asserts they agree.
    1_700_000_000_500
}

#[test]
fn rust_client_builds_the_fixture_operation_byte_for_byte() {
    let fixture: Fixture = serde_json::from_str(FIXTURE).expect("fixture parses");
    assert_eq!(
        fixture.now_ms,
        fixture_clock(),
        "fixture_clock() must return the fixture's now_ms"
    );

    let client = PhotonClient::builder()
        .actor_id(fixture.actor_id.as_str())
        .scope(fixture.intent.key.scope.as_str())
        .clock(fixture_clock)
        .build()
        .expect("client builds");

    let kind: OperationKind =
        serde_json::from_value(fixture.intent.kind).expect("fixture kind parses");
    let operation = client
        .build_operation(
            fixture.intent.key.collection.as_str(),
            fixture.intent.key.record_id.as_str(),
            kind,
        )
        .with_id(fixture.intent.operation_id.as_str())
        .with_metadata(fixture.intent.metadata);

    let serialized = serde_json::to_string(&operation).expect("operation serializes");
    assert_eq!(serialized, fixture.expected_operation_json);
}
