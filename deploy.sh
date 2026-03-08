#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
#  SocialCall — Google Cloud Run One-Command Deploy Script
#
#  Usage:
#    chmod +x deploy.sh
#    ./deploy.sh
#
#  Prerequisites:
#    1. Install gcloud CLI: https://cloud.google.com/sdk/docs/install
#    2. Run: gcloud auth login
#    3. Have a Google Cloud project with billing enabled
#
#  What this script does:
#    ✅ Enables required GCP APIs
#    ✅ Creates Artifact Registry repository
#    ✅ Stores secrets in Secret Manager
#    ✅ Builds & pushes Docker image
#    ✅ Deploys to Cloud Run
#    ✅ Prints your live URL
# ═══════════════════════════════════════════════════════════════════════════

set -euo pipefail

# ── Colors ────────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; NC='\033[0m'
ok()   { echo -e "${GREEN}✅ $*${NC}"; }
info() { echo -e "${CYAN}ℹ️  $*${NC}"; }
warn() { echo -e "${YELLOW}⚠️  $*${NC}"; }
err()  { echo -e "${RED}❌ $*${NC}"; exit 1; }
step() { echo -e "\n${BLUE}━━━ $* ━━━${NC}"; }

# ── Banner ────────────────────────────────────────────────────────────────────
echo -e "${CYAN}"
echo "  ╔══════════════════════════════════════════╗"
echo "  ║   SocialCall → Google Cloud Run Deploy   ║"
echo "  ╚══════════════════════════════════════════╝"
echo -e "${NC}"

# ── Check gcloud is installed ─────────────────────────────────────────────────
command -v gcloud &>/dev/null || err "gcloud CLI not found. Install from: https://cloud.google.com/sdk/docs/install"

# ── Configuration ─────────────────────────────────────────────────────────────
step "Configuration"

# Get or prompt for project ID
PROJECT_ID="${GCP_PROJECT_ID:-$(gcloud config get-value project 2>/dev/null)}"
if [[ -z "$PROJECT_ID" ]]; then
  echo -e "${YELLOW}Enter your Google Cloud Project ID:${NC}"
  read -r PROJECT_ID
fi
[[ -z "$PROJECT_ID" ]] && err "Project ID is required"

REGION="${GCP_REGION:-asia-south1}"       # Mumbai — closest to India
SERVICE="${SERVICE_NAME:-socialcall-backend}"
REPO="socialcall"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO}/${SERVICE}"

info "Project   : $PROJECT_ID"
info "Region    : $REGION"
info "Service   : $SERVICE"
info "Image     : $IMAGE"

gcloud config set project "$PROJECT_ID" --quiet

# ── Enable APIs ───────────────────────────────────────────────────────────────
step "Enabling GCP APIs"
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com \
  --quiet
ok "APIs enabled"

# ── Artifact Registry ─────────────────────────────────────────────────────────
step "Setting up Artifact Registry"
if ! gcloud artifacts repositories describe "$REPO" --location="$REGION" &>/dev/null; then
  gcloud artifacts repositories create "$REPO" \
    --repository-format=docker \
    --location="$REGION" \
    --description="SocialCall Docker images" \
    --quiet
  ok "Repository created"
else
  ok "Repository already exists"
fi

gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet

# ── Collect secrets ────────────────────────────────────────────────────────────
step "Collecting configuration"
echo ""
echo -e "${YELLOW}You need these external services first:${NC}"
echo "  • Supabase PostgreSQL: https://supabase.com (free)"
echo "  • Upstash Redis:       https://upstash.com  (free)"
echo "  • Twilio OTP:          https://twilio.com   (free trial)"
echo "  • Razorpay payments:   https://razorpay.com (free test)"
echo ""

prompt_secret() {
  local name=$1 desc=$2 example=$3
  local current
  current=$(gcloud secrets versions access latest --secret="SOCIALCALL_${name}" 2>/dev/null || echo "")
  if [[ -n "$current" ]]; then
    warn "Secret SOCIALCALL_${name} already exists — press Enter to keep it"
    echo -e "${CYAN}$desc${NC} [current: ***hidden***]: "
    read -r val
    [[ -z "$val" ]] && return
  else
    echo -e "${CYAN}$desc${NC}"
    [[ -n "$example" ]] && echo -e "  Example: ${YELLOW}$example${NC}"
    read -r -s val
    echo ""
  fi
  [[ -z "$val" ]] && { warn "Skipping $name"; return; }
  echo -n "$val" | gcloud secrets create "SOCIALCALL_${name}" --data-file=- --quiet 2>/dev/null || \
  echo -n "$val" | gcloud secrets versions add "SOCIALCALL_${name}" --data-file=- --quiet
  ok "Secret $name saved"
}

prompt_secret "DATABASE_URL"    "PostgreSQL URL from Supabase:"      "postgresql://postgres:pass@db.xxx.supabase.co:5432/postgres"
prompt_secret "REDIS_URL"       "Redis URL from Upstash:"            "rediss://default:xxx@xxx.upstash.io:6379"
prompt_secret "JWT_SECRET"      "JWT Secret (any long random string):" "$(openssl rand -hex 32 2>/dev/null || echo 'generate_a_32_char_random_string')"
prompt_secret "JWT_REFRESH_SECRET" "JWT Refresh Secret:"             "$(openssl rand -hex 32 2>/dev/null || echo 'another_32_char_random_string')"
prompt_secret "TWILIO_SID"      "Twilio Account SID:"                "ACxxxxxxxxxx"
prompt_secret "TWILIO_TOKEN"    "Twilio Auth Token:"                 "your_auth_token"
prompt_secret "TWILIO_PHONE"    "Twilio Phone Number:"               "+12345678900"
prompt_secret "RAZORPAY_KEY_ID" "Razorpay Key ID:"                   "rzp_test_xxxxxxxxx"
prompt_secret "RAZORPAY_SECRET" "Razorpay Key Secret:"               "your_secret"

# ── Grant Cloud Run access to secrets ─────────────────────────────────────────
step "Granting Secret Manager access"
PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')
SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${SA}" \
  --role="roles/secretmanager.secretAccessor" \
  --quiet &>/dev/null
ok "Secret access granted to Cloud Run service account"

# ── Build Docker image ─────────────────────────────────────────────────────────
step "Building Docker image"
gcloud builds submit . \
  --tag="${IMAGE}:latest" \
  --quiet
ok "Image built and pushed: $IMAGE:latest"

# ── Deploy to Cloud Run ────────────────────────────────────────────────────────
step "Deploying to Cloud Run"
gcloud run deploy "$SERVICE" \
  --image="${IMAGE}:latest" \
  --region="$REGION" \
  --platform=managed \
  --allow-unauthenticated \
  --min-instances=0 \
  --max-instances=10 \
  --memory=512Mi \
  --cpu=1 \
  --timeout=60 \
  --concurrency=80 \
  --port=8080 \
  --set-env-vars="NODE_ENV=production,PLATFORM_COMMISSION_PERCENT=35,MIN_WALLET_BALANCE=10,OTP_EXPIRY_SECONDS=300" \
  --update-secrets="DATABASE_URL=SOCIALCALL_DATABASE_URL:latest" \
  --update-secrets="REDIS_URL=SOCIALCALL_REDIS_URL:latest" \
  --update-secrets="JWT_SECRET=SOCIALCALL_JWT_SECRET:latest" \
  --update-secrets="JWT_REFRESH_SECRET=SOCIALCALL_JWT_REFRESH_SECRET:latest" \
  --update-secrets="TWILIO_ACCOUNT_SID=SOCIALCALL_TWILIO_SID:latest" \
  --update-secrets="TWILIO_AUTH_TOKEN=SOCIALCALL_TWILIO_TOKEN:latest" \
  --update-secrets="TWILIO_PHONE_NUMBER=SOCIALCALL_TWILIO_PHONE:latest" \
  --update-secrets="RAZORPAY_KEY_ID=SOCIALCALL_RAZORPAY_KEY_ID:latest" \
  --update-secrets="RAZORPAY_KEY_SECRET=SOCIALCALL_RAZORPAY_SECRET:latest" \
  --quiet

# ── Get live URL ───────────────────────────────────────────────────────────────
SERVICE_URL=$(gcloud run services describe "$SERVICE" \
  --region="$REGION" \
  --format='value(status.url)')

ok "Deployed successfully!"

# ── Health check ───────────────────────────────────────────────────────────────
step "Health Check"
info "Testing $SERVICE_URL/api/health ..."
sleep 5
if curl -sf "${SERVICE_URL}/api/health" >/dev/null; then
  ok "Server is healthy!"
else
  warn "Health check failed — check Cloud Run logs"
fi

# ── Print summary ──────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║                   🚀 DEPLOY COMPLETE!                       ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "  ${CYAN}Live URL:${NC}    $SERVICE_URL"
echo -e "  ${CYAN}Health:${NC}      $SERVICE_URL/api/health"
echo -e "  ${CYAN}Logs:${NC}        gcloud run logs tail $SERVICE --region=$REGION"
echo ""
echo -e "${YELLOW}📱 Next step — update Flutter app:${NC}"
echo -e "  Open: ${CYAN}lib/core/api/api_endpoints.dart${NC}"
echo -e "  Set:  ${GREEN}static const String baseUrl = '$SERVICE_URL';${NC}"
echo ""
echo -e "${YELLOW}🗃️  Run database migrations:${NC}"
echo -e "  ${CYAN}DATABASE_URL='your-url' npm run migrate${NC}"
echo ""
