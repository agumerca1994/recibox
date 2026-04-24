from pydantic_settings import BaseSettings

class Settings(BaseSettings):
    app_name: str = "recibox-backend"
    env: str = "dev"
    log_level: str = "INFO"
    app_secret_key: str = "dev-insecure-secret"
    api_auth_required: bool = False
    cors_allowed_origins: str = ""
    max_template_source_pdf_mb: int = 20
    oauth_state_ttl_seconds: int = 600
    rate_limit_window_seconds: int = 60
    rate_limit_public_requests: int = 120
    rate_limit_authenticated_requests: int = 600
    rate_limit_oauth_start_requests: int = 20
    rate_limit_upload_requests: int = 12
    rate_limit_job_run_requests: int = 30
    rate_limit_job_stop_requests: int = 30
    rate_limit_service_token_requests: int = 10

    # Optional legacy fallback; OAuth per tenant is the primary auth mode.
    google_application_credentials: str | None = None
    google_oauth_client_secrets: str | None = None
    google_oauth_redirect_uri: str | None = None
    google_oauth_scopes: str = "https://www.googleapis.com/auth/drive"
    google_oauth_token_dir: str = "tmp/google_tokens"
    oauth_required_for_tenant: bool = False
    drive_input_folder_id: str | None = None
    drive_root_folder_id: str | None = None
    google_subject: str | None = None
    drive_supports_all_drives: bool = True
    drive_include_items_from_all_drives: bool = True
    drive_page_size: int = 1000
    enable_legacy_processing_flow: bool = False

    poll_interval_seconds: int = 60

    ocr_enabled: bool = False
    ocr_min_text_len: int = 200
    ocr_lang: str = "spa+eng"

    local_download_dir: str = "tmp/downloads"
    results_log_path: str = "tmp/results.jsonl"
    report_artifacts_dir: str = "tmp/reports"
    report_processor_version: str = "v1"

    redis_url: str = "redis://localhost:6379/0"
    rq_job_timeout_seconds: int = 900

    postgres_url: str | None = None
    firebase_project_id: str | None = None
    firebase_credentials_path: str | None = None
    service_token_prefix: str = "rbx_sk_live_"

    class Config:
        env_file = ".env"

settings = Settings()
