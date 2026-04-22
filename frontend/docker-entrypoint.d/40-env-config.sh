#!/bin/sh
set -eu

escape_js() {
  printf '%s' "${1:-}" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

cat > /usr/share/nginx/html/env-config.js <<EOF
window.__RECIBOX_CONFIG = {
  VITE_FIREBASE_AUTH_ENABLED: "$(escape_js "${VITE_FIREBASE_AUTH_ENABLED:-}")",
  VITE_FIREBASE_ANALYTICS_ENABLED: "$(escape_js "${VITE_FIREBASE_ANALYTICS_ENABLED:-}")",
  VITE_FIREBASE_API_KEY: "$(escape_js "${VITE_FIREBASE_API_KEY:-}")",
  VITE_FIREBASE_AUTH_DOMAIN: "$(escape_js "${VITE_FIREBASE_AUTH_DOMAIN:-}")",
  VITE_FIREBASE_PROJECT_ID: "$(escape_js "${VITE_FIREBASE_PROJECT_ID:-}")",
  VITE_FIREBASE_STORAGE_BUCKET: "$(escape_js "${VITE_FIREBASE_STORAGE_BUCKET:-}")",
  VITE_FIREBASE_MESSAGING_SENDER_ID: "$(escape_js "${VITE_FIREBASE_MESSAGING_SENDER_ID:-}")",
  VITE_FIREBASE_APP_ID: "$(escape_js "${VITE_FIREBASE_APP_ID:-}")",
  VITE_FIREBASE_MEASUREMENT_ID: "$(escape_js "${VITE_FIREBASE_MEASUREMENT_ID:-}")",
  VITE_TEMPLATE_LOCAL_UPLOAD_ENABLED: "$(escape_js "${VITE_TEMPLATE_LOCAL_UPLOAD_ENABLED:-}")"
};
EOF
