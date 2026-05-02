<# 
.SYNOPSIS
    ContextVolt Build Script — Prepares the project for Inno Setup compilation.
    Downloads embedded Python, pre-installs ALL dependencies, copies project files.

.USAGE
    Right-click → Run with PowerShell
    OR: powershell -ExecutionPolicy Bypass -File build.ps1
#>

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot   # e:\ContextVolt
$BuildDir = "$PSScriptRoot\build"
$PythonVersion = "3.12.3"
$PythonUrl = "https://www.python.org/ftp/python/$PythonVersion/python-$PythonVersion-embed-amd64.zip"
$GetPipUrl = "https://bootstrap.pypa.io/get-pip.py"

Write-Host ""
Write-Host "  ╔══════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "  ║     ContextVolt Installer Build Script         ║" -ForegroundColor Cyan
Write-Host "  ╚══════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""

# ─── Step 1: Clean / create build directory ──────────────────────
Write-Host "  [1/6] Preparing build directory..." -ForegroundColor Yellow
if (Test-Path $BuildDir) {
    Remove-Item -Recurse -Force $BuildDir
}
New-Item -ItemType Directory -Path $BuildDir | Out-Null

# ─── Step 2: Download embedded Python ────────────────────────────
$PythonDir = "$BuildDir\python"
$PythonZip = "$BuildDir\python-embed.zip"

Write-Host "  [2/6] Downloading Python $PythonVersion (embedded)..." -ForegroundColor Yellow
Invoke-WebRequest -Uri $PythonUrl -OutFile $PythonZip -UseBasicParsing
Expand-Archive -Path $PythonZip -DestinationPath $PythonDir -Force
Remove-Item $PythonZip

# Enable site-packages in embedded Python by uncommenting import site in ._pth file
$PthFile = Get-ChildItem "$PythonDir\python*._pth" | Select-Object -First 1
if ($PthFile) {
    $content = Get-Content $PthFile.FullName
    $content = $content -replace "^#import site", "import site"
    Set-Content -Path $PthFile.FullName -Value $content
    Write-Host "         Enabled site-packages in embedded Python" -ForegroundColor DarkGray
}

# ─── Step 3: Install pip ─────────────────────────────────────────
Write-Host "  [3/6] Installing pip..." -ForegroundColor Yellow
$GetPipFile = "$BuildDir\get-pip.py"
Invoke-WebRequest -Uri $GetPipUrl -OutFile $GetPipFile -UseBasicParsing
& "$PythonDir\python.exe" $GetPipFile --no-warn-script-location 2>&1 | Out-Null
Remove-Item $GetPipFile
Write-Host "         pip installed" -ForegroundColor DarkGray

# ─── Step 4: Pre-install ALL dependencies into embedded Python ───
Write-Host "  [4/6] Installing dependencies (this may take a minute)..." -ForegroundColor Yellow
$ReqFile = Join-Path $ProjectRoot "requirements.txt"

# Use python -m pip (more reliable than pip.exe with embedded Python)
# --only-binary=:all: avoids C extension compilation issues
$pipOutput = & "$PythonDir\python.exe" -m pip install -r $ReqFile --no-warn-script-location --disable-pip-version-check --only-binary=:all: 2>&1
$pipExitCode = $LASTEXITCODE

if ($pipExitCode -ne 0) {
    Write-Host "         Note: binary-only install had issues, trying with compilation..." -ForegroundColor DarkYellow
    $pipOutput = & "$PythonDir\python.exe" -m pip install -r $ReqFile --no-warn-script-location --disable-pip-version-check 2>&1
    $pipExitCode = $LASTEXITCODE
}

if ($pipExitCode -ne 0) {
    Write-Host "         ERROR: pip install failed:" -ForegroundColor Red
    $pipOutput | ForEach-Object { Write-Host "         $_" -ForegroundColor Red }
    Write-Host ""
    Write-Host "  Try running manually:" -ForegroundColor Yellow
    Write-Host "  $PythonDir\python.exe -m pip install -r $ReqFile" -ForegroundColor Yellow
    exit 1
}

$pipOutput | ForEach-Object {
    if ($_ -match "Successfully installed") {
        Write-Host "         $_" -ForegroundColor DarkGray
    }
}
Write-Host "         All dependencies installed into embedded Python" -ForegroundColor DarkGray

# ─── Step 5: Copy project files ─────────────────────────────────
Write-Host "  [5/6] Copying project files..." -ForegroundColor Yellow
$AppDir = "$BuildDir\app"
New-Item -ItemType Directory -Path $AppDir | Out-Null

# Copy only the essential files/folders (no venv, .git, .ollama, __pycache__, test files)
$include = @("backend", "frontend", "extension", "vscode-extension",
             "installer.py", "run.py", "start.bat", "requirements.txt", "README.md",
             "icon.ico", "icon.png")

foreach ($item in $include) {
    $src = Join-Path $ProjectRoot $item
    $dst = Join-Path $AppDir $item
    if (Test-Path $src) {
        if ((Get-Item $src).PSIsContainer) {
            Copy-Item -Path $src -Destination $dst -Recurse
        } else {
            Copy-Item -Path $src -Destination $dst
        }
        Write-Host "         Copied: $item" -ForegroundColor DarkGray
    }
}

# ─── Step 6: Create launchers ────────────────────────────────────
Write-Host "  [6/6] Creating launcher..." -ForegroundColor Yellow

# Debug batch launcher — shows a console window with any errors (for troubleshooting)
$debugBatContent = @'
@echo off
title ContextVolt
set "BASE=%~dp0"
set "PYTHON=%BASE%python\python.exe"
set "APP=%BASE%app\run.py"
set "PYTHONPATH=%BASE%app"
cd /d "%BASE%python"
echo Starting ContextVolt...
"%PYTHON%" "%APP%"
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo ContextVolt exited with an error. See cv_error.log in the app folder.
    pause
)
'@
Set-Content -Path "$BuildDir\ContextVolt-debug.bat" -Value $debugBatContent -Encoding ASCII

# Silent production launcher — no console window, runs via embedded Python
# Working directory is set to python\ so embedded DLLs are found correctly
$vbsContent = @'
'' ContextVolt Launcher
Dim shell, fso, base, python, app
Set shell = CreateObject("WScript.Shell")
Set fso   = CreateObject("Scripting.FileSystemObject")
base   = fso.GetParentFolderName(WScript.ScriptFullName)
python = base & "\python\pythonw.exe"
app    = base & "\app\run.py"
shell.Environment("Process")("PYTHONPATH") = base & "\app"
shell.CurrentDirectory = base & "\python"
shell.Run """" & python & """ """ & app & """", 0, False
'@
Set-Content -Path "$BuildDir\ContextVolt.vbs" -Value $vbsContent -Encoding ASCII
Write-Host "         Created: ContextVolt.vbs + ContextVolt-debug.bat" -ForegroundColor DarkGray

Write-Host ""
Write-Host "  ═══════════════════════════════════════════" -ForegroundColor Green
Write-Host "  ✅ Build complete!" -ForegroundColor Green
Write-Host "  Build directory: $BuildDir" -ForegroundColor Green
Write-Host ""
Write-Host "  Next steps:" -ForegroundColor Cyan
Write-Host "  1. Open setup.iss in Inno Setup" -ForegroundColor Cyan
Write-Host "  2. Press Ctrl+F9 to compile" -ForegroundColor Cyan
Write-Host "  3. Output: installer\output\ContextVolt-Setup.exe" -ForegroundColor Cyan
Write-Host "  ═══════════════════════════════════════════" -ForegroundColor Green
Write-Host ""
