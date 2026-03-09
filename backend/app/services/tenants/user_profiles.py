from __future__ import annotations

from dataclasses import dataclass

from app.db.postgres import get_postgres_conn


@dataclass
class UserProfile:
    uid: str
    tenant_id: str
    email: str | None
    company_name: str
    tax_id: str
    billing_address: str


def init_user_profiles_schema() -> None:
    with get_postgres_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS auth_user_profiles (
                  uid TEXT PRIMARY KEY,
                  tenant_id TEXT NOT NULL UNIQUE,
                  email TEXT NULL,
                  company_name TEXT NOT NULL,
                  tax_id TEXT NOT NULL,
                  billing_address TEXT NOT NULL,
                  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )
                """
            )
        conn.commit()


def upsert_user_profile(
    *,
    uid: str,
    tenant_id: str,
    email: str | None,
    company_name: str,
    tax_id: str,
    billing_address: str,
) -> UserProfile:
    normalized_uid = uid.strip()
    if not normalized_uid:
        raise ValueError("uid is required")
    normalized_tenant = tenant_id.strip()
    if not normalized_tenant:
        raise ValueError("tenant_id is required")
    normalized_email = (email or "").strip() or None
    normalized_company = company_name.strip()
    normalized_tax_id = tax_id.strip()
    normalized_address = billing_address.strip()
    if not normalized_company:
        raise ValueError("company_name is required")
    if not normalized_tax_id:
        raise ValueError("tax_id is required")
    if not normalized_address:
        raise ValueError("billing_address is required")

    with get_postgres_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO auth_user_profiles (uid, tenant_id, email, company_name, tax_id, billing_address)
                VALUES (%s, %s, %s, %s, %s, %s)
                ON CONFLICT (uid) DO UPDATE SET
                  tenant_id = EXCLUDED.tenant_id,
                  email = EXCLUDED.email,
                  company_name = EXCLUDED.company_name,
                  tax_id = EXCLUDED.tax_id,
                  billing_address = EXCLUDED.billing_address,
                  updated_at = NOW()
                RETURNING uid, tenant_id, email, company_name, tax_id, billing_address
                """,
                (
                    normalized_uid,
                    normalized_tenant,
                    normalized_email,
                    normalized_company,
                    normalized_tax_id,
                    normalized_address,
                ),
            )
            row = cur.fetchone()
        conn.commit()

    return UserProfile(
        uid=row[0],
        tenant_id=row[1],
        email=row[2],
        company_name=row[3],
        tax_id=row[4],
        billing_address=row[5],
    )
