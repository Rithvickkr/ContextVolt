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

# setuptools + wheel are needed to build any source-only packages (no wheel on PyPI)
& "$PythonDir\python.exe" -m pip install setuptools wheel `
    --no-warn-script-location --disable-pip-version-check --quiet
if ($LASTEXITCODE -ne 0) { Write-Host "  ERROR: setuptools install failed" -ForegroundColor Red; exit 1 }
Write-Host "         setuptools + wheel installed" -ForegroundColor DarkGray

# ─── Step 4: Pre-install ALL dependencies into embedded Python ───
Write-Host "  [4/6] Installing dependencies (this may take a minute)..." -ForegroundColor Yellow
$ReqFile = Join-Path $ProjectRoot "requirements.txt"

# --prefer-binary uses wheels when available, falls back to source if not.
# No 2>&1 redirect — PowerShell 5.1 wraps native stderr as NativeCommandError
# which can falsely mark a successful pip run as failed.
& "$PythonDir\python.exe" -m pip install -r $ReqFile `
    --prefer-binary `
    --no-warn-script-location `
    --disable-pip-version-check

if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "  ERROR: pip install failed (exit $LASTEXITCODE)." -ForegroundColor Red
    Write-Host "  To debug, run manually:" -ForegroundColor Yellow
    Write-Host "  $PythonDir\python.exe -m pip install -r $ReqFile --prefer-binary" -ForegroundColor Yellow
    exit 1
}

Write-Host "         All dependencies installed into embedded Python" -ForegroundColor DarkGray

# ─── Step 5: Copy project files ─────────────────────────────────
Write-Host "  [5/6] Copying project files..." -ForegroundColor Yellow
$AppDir = "$BuildDir\app"
New-Item -ItemType Directory -Path $AppDir | Out-Null

# Copy only the essential files/folders (no venv, .git, .ollama, __pycache__, test files)
$include = @("backend", "frontend", "extension",
             "installer.py", "run.py", "start.bat", "requirements.txt", "README.md",
             "icon.ico", "icon.png", "extension_install_guide.html")

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
title ContextVolt Debug
set "BASE=%~dp0"
set "PYTHON=%BASE%python\python.exe"
set "APP=%BASE%app\installer.py"
set "LOCKFILE=%BASE%app\.cv_lock"
set "PYTHONPATH=%BASE%app"

echo ============================================================
echo  ContextVolt Debug Launcher
echo ============================================================
echo  Base dir : %BASE%
echo  Python   : %PYTHON%
echo  App      : %APP%
echo ============================================================
echo.

if not exist "%PYTHON%" (
    echo ERROR: Python not found at %PYTHON%
    echo The installation may be incomplete.
    goto end
)

if not exist "%APP%" (
    echo ERROR: run.py not found at %APP%
    echo The installation may be incomplete.
    goto end
)

if exist "%LOCKFILE%" (
    echo NOTE: Lock file found — deleting stale lock before launch.
    del "%LOCKFILE%"
)

echo Starting ContextVolt...
echo.
cd /d "%BASE%python"
"%PYTHON%" "%APP%"
set "EXIT=%ERRORLEVEL%"
echo.
echo ============================================================
echo  ContextVolt exited with code: %EXIT%
if %EXIT% NEQ 0 (
    echo  Check cv_error.log in: %BASE%app\
)
echo ============================================================
:end
pause
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
app    = base & "\app\installer.py"
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
