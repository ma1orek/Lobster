#!/bin/bash
set -euo pipefail

# Lobster Browser - One-click Cloud Run deployment
# Usage: ./deploy/deploy.sh

PROJECT_ID="${GOOGLE_CLOUD_PROJECT:-$(gcloud config get-value project 2>/dev/null)}"
REGION="${GOOGLE_CLOUD_REGION:-us-central1}"
SERVICE_NAME="lobster-backend"

if [ -z "$PROJECT_ID" ]; then
  echo "Error: No project ID found. Set GOOGLE_CLOUD_PROJECT or run 'gcloud config set project YOUR_PROJECT_ID'"
  exit 1
fi

echo "========================================"
echo "  Lobster Browser - Cloud Run Deployment"
echo "========================================"
echo "Project:  $PROJECT_ID"
echo "Region:   $REGION"
echo "Service:  $SERVICE_NAME"
echo "========================================"

# Enable required APIs
echo "[1/5] Enabling Google Cloud APIs..."
gcloud services enable \
  run.googleapis.com \
  firestore.googleapis.com \
  storage.googleapis.com \
  artifactregistry.googleapis.com \
  cloudbuild.googleapis.com \
  aiplatform.googleapis.com \
  --project="$PROJECT_ID" --quiet

# Create Firestore database (ignore if already exists)
echo "[2/5] Setting up Firestore..."
gcloud firestore databases create \
  --location="$REGION" \
  --project="$PROJECT_ID" 2>/dev/null || echo "Firestore already exists."

# Create Cloud Storage bucket (ignore if already exists)
echo "[3/5] Setting up Cloud Storage..."
gcloud storage buckets create "gs://${PROJECT_ID}-lobster-screenshots" \
  --location="$REGION" \
  --uniform-bucket-level-access 2>/dev/null || echo "Storage bucket already exists."

# Deploy to Cloud Run
echo "[4/5] Deploying to Cloud Run..."
gcloud run deploy "$SERVICE_NAME" \
  --source ./backend \
  --region="$REGION" \
  --project="$PROJECT_ID" \
  --allow-unauthenticated \
  --session-affinity \
  --min-instances=1 \
  --max-instances=3 \
  --memory=1Gi \
  --timeout=3600 \
  --set-env-vars="GOOGLE_CLOUD_PROJECT=$PROJECT_ID,GOOGLE_CLOUD_LOCATION=$REGION,GOOGLE_GENAI_USE_VERTEXAI=true" \
  --quiet

# Get service URL
echo "[5/5] Deployment complete!"
SERVICE_URL=$(gcloud run services describe "$SERVICE_NAME" \
  --region="$REGION" \
  --project="$PROJECT_ID" \
  --format='value(status.url)')

echo ""
echo "========================================"
echo "  Deployment Successful!"
echo "========================================"
echo "Backend URL:    $SERVICE_URL"
echo "WebSocket URL:  ${SERVICE_URL/https/wss}/ws"
echo "Health check:   $SERVICE_URL/health"
echo ""
echo "Update your Electron app's WS URL to:"
echo "  ${SERVICE_URL/https/wss}/ws/user1/session1"
echo "========================================"
