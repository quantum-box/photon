//! Runnable Photon servers.
//!
//! Everything that answers a request lives in `photon-axum`. This crate only
//! resolves how a process should be configured — which mode, which database,
//! which port — and then serves the routers that crate already provides.

use std::net::SocketAddr;
use std::sync::Arc;

use axum::Router;
use photon_axum::{build_state, combined_router, engine_router, live_router, AppState};
use tracing::info;

#[derive(Debug, Clone, Copy)]
pub enum PhotonServerMode {
    Combined,
    Engine,
    Live,
}

impl PhotonServerMode {
    fn service_name(self) -> &'static str {
        match self {
            Self::Combined => "Photon server",
            Self::Engine => "Photon Engine server",
            Self::Live => "Photon Live server",
        }
    }

    fn default_port(self) -> u16 {
        match self {
            Self::Combined | Self::Engine => 3001,
            Self::Live => 3002,
        }
    }

    fn mode_port_env(self) -> Option<&'static str> {
        match self {
            Self::Combined => None,
            Self::Engine => Some("PHOTON_ENGINE_PORT"),
            Self::Live => Some("PHOTON_LIVE_PORT"),
        }
    }
}

fn init_tracing() {
    let _ = tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| {
                "photon_server=debug,photon_axum=debug,tower_http=debug".into()
            }),
        )
        .try_init();
}

fn resolve_app_database_url(mode: PhotonServerMode) -> String {
    resolve_app_database_url_from(mode, |key| std::env::var(key).ok())
}

fn resolve_app_database_url_from(
    mode: PhotonServerMode,
    mut lookup: impl FnMut(&str) -> Option<String>,
) -> String {
    match mode {
        PhotonServerMode::Live => lookup("PHOTON_LIVE_DATABASE_URL")
            .unwrap_or_else(|| "sqlite:photon-live.db?mode=rwc".into()),
        PhotonServerMode::Engine => lookup("PHOTON_ENGINE_APP_DATABASE_URL")
            .unwrap_or_else(|| "sqlite:photon.db?mode=rwc".into()),
        PhotonServerMode::Combined => {
            lookup("DATABASE_URL").unwrap_or_else(|| "sqlite:photon.db?mode=rwc".into())
        }
    }
}

fn resolve_engine_database_url(mode: PhotonServerMode) -> String {
    match mode {
        PhotonServerMode::Engine => std::env::var("PHOTON_ENGINE_DATABASE_URL")
            .or_else(|_| std::env::var("DATABASE_URL"))
            .unwrap_or_else(|_| "sqlite:photon.db?mode=rwc".into()),
        PhotonServerMode::Live => std::env::var("PHOTON_LIVE_ENGINE_DATABASE_URL")
            .or_else(|_| std::env::var("PHOTON_ENGINE_DATABASE_URL"))
            .or_else(|_| std::env::var("DATABASE_URL"))
            .unwrap_or_else(|_| "sqlite:photon.db?mode=rwc".into()),
        PhotonServerMode::Combined => std::env::var("PHOTON_ENGINE_DATABASE_URL")
            .or_else(|_| std::env::var("DATABASE_URL"))
            .unwrap_or_else(|_| "sqlite:photon.db?mode=rwc".into()),
    }
}

fn resolve_port(mode: PhotonServerMode) -> u16 {
    mode.mode_port_env()
        .and_then(|env| std::env::var(env).ok())
        .or_else(|| std::env::var("PORT").ok())
        .and_then(|port| port.parse::<u16>().ok())
        .unwrap_or_else(|| mode.default_port())
}

fn app_router_for_mode(mode: PhotonServerMode, state: Arc<AppState>) -> Router {
    match mode {
        PhotonServerMode::Combined => combined_router(state),
        PhotonServerMode::Engine => engine_router(state),
        PhotonServerMode::Live => live_router(state),
    }
}

pub async fn run_server(mode: PhotonServerMode) -> Result<(), Box<dyn std::error::Error>> {
    init_tracing();

    let database_url = resolve_app_database_url(mode);
    let engine_database_url = resolve_engine_database_url(mode);
    let state = build_state(&database_url, &engine_database_url).await?;
    let app = app_router_for_mode(mode, state);

    let port = resolve_port(mode);
    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    info!("{} listening on {addr}", mode.service_name());
    if matches!(mode, PhotonServerMode::Combined | PhotonServerMode::Engine) {
        info!("Swagger UI: http://{addr}/swagger-ui/");
    }

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;

    Ok(())
}

pub async fn run_combined_server() -> Result<(), Box<dyn std::error::Error>> {
    run_server(PhotonServerMode::Combined).await
}

pub async fn run_engine_server() -> Result<(), Box<dyn std::error::Error>> {
    run_server(PhotonServerMode::Engine).await
}

pub async fn run_live_server() -> Result<(), Box<dyn std::error::Error>> {
    run_server(PhotonServerMode::Live).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_mode_specific_app_database_url_resolution() {
        let engine_and_live = |key: &str| match key {
            "PHOTON_ENGINE_APP_DATABASE_URL" => Some("sqlite:engine-app.db?mode=rwc".to_string()),
            "PHOTON_LIVE_DATABASE_URL" => Some("sqlite:live-app.db?mode=rwc".to_string()),
            _ => None,
        };

        assert_eq!(
            resolve_app_database_url_from(PhotonServerMode::Engine, engine_and_live),
            "sqlite:engine-app.db?mode=rwc"
        );
        assert_eq!(
            resolve_app_database_url_from(PhotonServerMode::Live, engine_and_live),
            "sqlite:live-app.db?mode=rwc"
        );

        let shared_only = |key: &str| match key {
            "DATABASE_URL" => Some("sqlite:shared.db?mode=rwc".to_string()),
            _ => None,
        };

        assert_eq!(
            resolve_app_database_url_from(PhotonServerMode::Combined, shared_only),
            "sqlite:shared.db?mode=rwc"
        );
        assert_eq!(
            resolve_app_database_url_from(PhotonServerMode::Engine, shared_only),
            "sqlite:photon.db?mode=rwc"
        );
        assert_eq!(
            resolve_app_database_url_from(PhotonServerMode::Live, shared_only),
            "sqlite:photon-live.db?mode=rwc"
        );
    }
}
