# ─────────────────────────────────────────────
#  deploy.ps1  —  Katy Chavez Site
#  Lives in: C:\sites\katychavez-site
# ─────────────────────────────────────────────

param(
    [string]$SourceFile = "index.html",
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

# ── Resolve source file (absolute or relative to repo) ──
if (-not [System.IO.Path]::IsPathRooted($SourceFile)) {
    $SourceFile = Join-Path $RepoPath $SourceFile
}

# ── Verify source file exists ──
if (-not (Test-Path $SourceFile)) {
    Write-Host "`n❌ Source file not found: $SourceFile" -ForegroundColor Red
    exit 1
}

# ── Copy source file to index.html ──
Write-Host "`nCopying $SourceFile -> index.html..." -ForegroundColor Cyan
Get-Content $SourceFile -Encoding UTF8 | Set-Content index.html -Encoding UTF8

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
