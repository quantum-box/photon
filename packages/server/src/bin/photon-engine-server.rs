#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    photon_server::run_engine_server().await
}
