# ─────────────────────────────────────────────
#  deploy.ps1  —  Katy Chavez Site
#  Lives in: C:\sites\katychavez-site
# ─────────────────────────────────────────────

param(
    [string]$CommitMessage = ""
)

$RepoPath = "C:\sites\katychavez-site"

# ── Prompt for commit message if not provided ──
if (-not $CommitMessage) {
    $CommitMessage = Read-Host "Commit message"
    if (-not $CommitMessage) {
        $CommitMessage = "Update site"
    }
}

# ── Move to repo ──
Set-Location $RepoPath

# ── Git status check ──
Write-Host "`nChecking for changes..." -ForegroundColor Cyan
$status = git status --porcelain
if (-not $status) {
    Write-Host "No changes detected. Nothing to deploy." -ForegroundColor Yellow
    exit 0
}

# ── Stage, commit, push ──
Write-Host "`nStaging files..." -ForegroundColor Cyan
git add .

Write-Host "Committing: $CommitMessage" -ForegroundColor Cyan
git commit -m $CommitMessage

Write-Host "Pushing to GitHub..." -ForegroundColor Cyan
git push

if ($LASTEXITCODE -eq 0) {
    Write-Host "`n✅ Deploy triggered! Check Netlify in ~30 seconds." -ForegroundColor Green
    Write-Host "   https://katy-chavez-law.netlify.app" -ForegroundColor DarkGray
} else {
    Write-Host "`n❌ Push failed. Check git output above." -ForegroundColor Red
}
