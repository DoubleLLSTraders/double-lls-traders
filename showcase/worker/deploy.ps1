<#
  Deploys the cloud bot worker as a Cloud Run worker pool: 1 vCPU, 512 MiB, one instance always on.
  Needs the Google Cloud CLI (https://cloud.google.com/sdk/docs/install), `gcloud auth login`,
  and the Blaze (pay-as-you-go) plan on the Firebase project.

  Run from the showcase folder:   ./worker/deploy.ps1 -Project naja-music
  Safe to run again to ship updates. The first run prints CLOUD_BOT_KEY and FIREBASE_SERVICE_ACCOUNT
  for the Netlify site's environment variables.
#>
param(
  [string]$Project = "naja-music",
  [string]$Region = "us-central1",
  [string]$DerivAppId = ""
)

if (-not $DerivAppId) {
  $mainEnv = Join-Path $PSScriptRoot "..\..\.env"
  if (Test-Path $mainEnv) {
    $line = Select-String -Path $mainEnv -Pattern '^\s*VITE_DERIV_APP_ID\s*=\s*(.+)$' | Select-Object -First 1
    if ($line) { $DerivAppId = $line.Matches[0].Groups[1].Value.Trim().Trim('"', "'") }
  }
}
if (-not $DerivAppId) { throw "Pass -DerivAppId (the app id from your Deriv developer dashboard)." }

$pool = "double-lls-bot"
$secret = "cloud-bot-key"
$siteAccount = "llsbot-site"

function Invoke-Gcloud {
  & gcloud @args
  if ($LASTEXITCODE -ne 0) { throw "gcloud $($args -join ' ') failed" }
}

function Test-Gcloud {
  & gcloud @args *> $null
  return $LASTEXITCODE -eq 0
}

Invoke-Gcloud config set project $Project
Invoke-Gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com firestore.googleapis.com secretmanager.googleapis.com

if (-not (Test-Gcloud firestore databases describe --database="(default)")) {
  Invoke-Gcloud firestore databases create --location=nam5
}

if (-not (Test-Gcloud secrets describe $secret)) {
  $bytes = New-Object byte[] 32
  [Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
  $tmp = New-TemporaryFile
  [IO.File]::WriteAllText($tmp, [Convert]::ToBase64String($bytes))
  try { Invoke-Gcloud secrets create $secret --data-file=$tmp } finally { Remove-Item $tmp }
}

$number = (& gcloud projects describe $Project --format="value(projectNumber)").Trim()
$runner = "$number-compute@developer.gserviceaccount.com"
Invoke-Gcloud projects add-iam-policy-binding $Project --member="serviceAccount:$runner" --role="roles/datastore.user" --condition=None --quiet | Out-Null
Invoke-Gcloud secrets add-iam-policy-binding $secret --member="serviceAccount:$runner" --role="roles/secretmanager.secretAccessor" --quiet | Out-Null

Invoke-Gcloud run worker-pools deploy $pool --source . --region $Region --cpu 1 --memory 512Mi --instances 1 `
  --set-secrets "CLOUD_BOT_KEY=${secret}:latest" --set-env-vars "DERIV_APP_ID=$DerivAppId,FIREBASE_PROJECT_ID=$Project"

$siteEmail = "$siteAccount@$Project.iam.gserviceaccount.com"
if (-not (Test-Gcloud iam service-accounts describe $siteEmail)) {
  Invoke-Gcloud iam service-accounts create $siteAccount --display-name "Double LLS website (cloud bot)"
  Invoke-Gcloud projects add-iam-policy-binding $Project --member="serviceAccount:$siteEmail" --role="roles/datastore.user" --condition=None --quiet | Out-Null
  $keyFile = Join-Path ([IO.Path]::GetTempPath()) "llsbot-site.json"
  try {
    Invoke-Gcloud iam service-accounts keys create $keyFile --iam-account $siteEmail
    $serviceAccount = [Convert]::ToBase64String([IO.File]::ReadAllBytes($keyFile))
  } finally { Remove-Item $keyFile -ErrorAction SilentlyContinue }
  Write-Host ""
  Write-Host "Add these to Netlify (Site configuration > Environment variables), then redeploy the site:" -ForegroundColor Yellow
  Write-Host "FIREBASE_SERVICE_ACCOUNT=$serviceAccount"
  Write-Host "CLOUD_BOT_KEY=$((& gcloud secrets versions access latest --secret $secret).Trim())"
}

Write-Host ""
Write-Host "Worker pool '$pool' is running in $Region. Logs: https://console.cloud.google.com/run/workerpools?project=$Project" -ForegroundColor Green
