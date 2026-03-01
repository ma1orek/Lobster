output "backend_url" {
  description = "Cloud Run service URL"
  value       = google_cloud_run_v2_service.lobster_backend.uri
}

output "websocket_url" {
  description = "WebSocket endpoint URL"
  value       = "${replace(google_cloud_run_v2_service.lobster_backend.uri, "https://", "wss://")}/ws"
}

output "firestore_database" {
  description = "Firestore database name"
  value       = google_firestore_database.lobster.name
}

output "screenshots_bucket" {
  description = "Cloud Storage bucket for screenshots"
  value       = google_storage_bucket.screenshots.name
}

output "service_account" {
  description = "Backend service account email"
  value       = google_service_account.lobster_backend.email
}
