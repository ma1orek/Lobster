terraform {
  required_version = ">= 1.5"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

# Enable required APIs
resource "google_project_service" "apis" {
  for_each = toset([
    "run.googleapis.com",
    "firestore.googleapis.com",
    "storage.googleapis.com",
    "artifactregistry.googleapis.com",
    "cloudbuild.googleapis.com",
    "aiplatform.googleapis.com",
  ])
  service            = each.value
  disable_on_destroy = false
}

# Artifact Registry for container images
resource "google_artifact_registry_repository" "lobster" {
  location      = var.region
  repository_id = "lobster-browser"
  format        = "DOCKER"
  description   = "Lobster Browser container images"

  depends_on = [google_project_service.apis]
}

# Firestore database for session memory
resource "google_firestore_database" "lobster" {
  name        = "(default)"
  location_id = var.region
  type        = "FIRESTORE_NATIVE"

  depends_on = [google_project_service.apis]
}

# Cloud Storage bucket for screenshots
resource "google_storage_bucket" "screenshots" {
  name          = "${var.project_id}-lobster-screenshots"
  location      = var.region
  force_destroy = true

  uniform_bucket_level_access = true

  lifecycle_rule {
    condition {
      age = 7 # Auto-delete screenshots after 7 days
    }
    action {
      type = "Delete"
    }
  }

  depends_on = [google_project_service.apis]
}

# Service account for Cloud Run
resource "google_service_account" "lobster_backend" {
  account_id   = "lobster-backend"
  display_name = "Lobster Browser Backend"
}

# IAM: Allow backend to access Firestore
resource "google_project_iam_member" "firestore_user" {
  project = var.project_id
  role    = "roles/datastore.user"
  member  = "serviceAccount:${google_service_account.lobster_backend.email}"
}

# IAM: Allow backend to access Cloud Storage
resource "google_project_iam_member" "storage_user" {
  project = var.project_id
  role    = "roles/storage.objectAdmin"
  member  = "serviceAccount:${google_service_account.lobster_backend.email}"
}

# IAM: Allow backend to use Vertex AI
resource "google_project_iam_member" "vertex_user" {
  project = var.project_id
  role    = "roles/aiplatform.user"
  member  = "serviceAccount:${google_service_account.lobster_backend.email}"
}

# Cloud Run service
resource "google_cloud_run_v2_service" "lobster_backend" {
  name     = var.service_name
  location = var.region

  template {
    scaling {
      min_instance_count = 1
      max_instance_count = 3
    }

    session_affinity = true
    timeout          = "3600s"

    containers {
      image = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.lobster.repository_id}/lobster-backend:latest"

      ports {
        container_port = 8080
      }

      resources {
        limits = {
          memory = "1Gi"
          cpu    = "1"
        }
      }

      env {
        name  = "GOOGLE_CLOUD_PROJECT"
        value = var.project_id
      }
      env {
        name  = "GOOGLE_CLOUD_LOCATION"
        value = var.region
      }
      env {
        name  = "GOOGLE_GENAI_USE_VERTEXAI"
        value = "true"
      }
    }

    service_account = google_service_account.lobster_backend.email
  }

  depends_on = [
    google_project_service.apis,
    google_artifact_registry_repository.lobster,
  ]
}

# Allow unauthenticated access to Cloud Run (for demo)
resource "google_cloud_run_v2_service_iam_member" "public" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.lobster_backend.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}
