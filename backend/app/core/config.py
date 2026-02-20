from pydantic_settings import BaseSettings

class Settings(BaseSettings):
    app_name: str = "recibox-backend"
    env: str = "dev"
    log_level: str = "INFO"

    google_application_credentials: str
    google_oauth_client_secrets: str | None = None
    google_oauth_redirect_uri: str | None = None
    google_oauth_scopes: str = "https://www.googleapis.com/auth/drive"
    google_oauth_token_dir: str = "tmp/google_tokens"
    oauth_required_for_tenant: bool = False
    drive_input_folder_id: str
    drive_root_folder_id: str
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

    class Config:
        env_file = ".env"

settings = Settings()
