from pydantic_settings import BaseSettings

class Settings(BaseSettings):
    app_name: str = "recibox-backend"
    env: str = "dev"
    log_level: str = "INFO"

    # Optional legacy fallback; OAuth per tenant is the primary auth mode.
    google_application_credentials: str | None = None
    google_oauth_client_secrets: str | None = None
    google_oauth_redirect_uri: str | None = None
<<<<<<< HEAD
    google_oauth_scopes: str = (
        "https://www.googleapis.com/auth/drive.file "
        "https://www.googleapis.com/auth/drive.metadata.readonly"
    )
=======
    google_oauth_scopes: str = "https://www.googleapis.com/auth/drive.file"
>>>>>>> 74d9da0 (Set GOOGLE_OAUTH_SCOPES to drive.file)
    google_oauth_token_dir: str = "tmp/google_tokens"
    oauth_required_for_tenant: bool = False
    drive_input_folder_id: str | None = None
    drive_root_folder_id: str | None = None
    google_subject: str | None = None
    drive_supports_all_drives: bool = True
    drive_include_items_from_all_drives: bool = True
    drive_page_size: int = 1000

    poll_interval_seconds: int = 60

    ocr_enabled: bool = False
    ocr_min_text_len: int = 200
    ocr_lang: str = "spa+eng"

    local_download_dir: str = "tmp/downloads"
    results_log_path: str = "tmp/results.jsonl"

    redis_url: str = "redis://localhost:6379/0"
    rq_job_timeout_seconds: int = 900

    postgres_url: str | None = None
    firebase_project_id: str | None = None
    firebase_credentials_path: str | None = None

    class Config:
        env_file = ".env"

settings = Settings()
