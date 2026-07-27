#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    photon_server::run_live_server().await
}
