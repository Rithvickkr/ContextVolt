@echo off
:: ═══════════════════════════════════════════════════════════════
:: ContextVolt — Bootstrap Launcher
:: Minimal console setup, then launches the professional GUI installer
:: ═══════════════════════════════════════════════════════════════

title ContextVolt
cd /d "%~dp0"

:: ─── Check Python ────────────────────────────────────────────────
python --version >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo  ContextVolt requires Python 3.10 or higher.
    echo.
    echo  Please install Python from: https://www.python.org/downloads/
    echo  Make sure to check "Add Python to PATH" during installation.
    echo.
    pause
    exit /b 1
)

:: ─── Bootstrap virtual environment with pywebview ───────────────
:: We need pywebview to show the GUI installer
set "VENV_PYTHON=%~dp0venv\Scripts\python.exe"
set "VENV_PIP=%~dp0venv\Scripts\pip.exe"

if not exist "%VENV_PYTHON%" (
    echo  Initializing ContextVolt...
    python -m venv venv >nul 2>&1
    if %ERRORLEVEL% NEQ 0 (
        echo  Failed to create virtual environment.
        pause
        exit /b 1
    )
)


:: ─── Launch the GUI installer ────────────────────────────────────

"%VENV_PYTHON%" -c "import webview" >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo  Preparing installer...
    "%VENV_PIP%" install pywebview --disable-pip-version-check
    if %ERRORLEVEL% NEQ 0 (
        echo.
        echo  Failed to install pywebview. Trying alternative...
        "%VENV_PYTHON%" -m pip install pywebview --disable-pip-version-check
        if %ERRORLEVEL% NEQ 0 (
            echo.
            echo  Could not install required components.
            echo  Try running manually: pip install pywebview
            pause
            exit /b 1
        )
    )
)

:: ─── Launch the GUI installer ────────────────────────────────────
:: Use pythonw.exe (windowless) so no console window appears
set "VENV_PYTHONW=%~dp0venv\Scripts\pythonw.exe"
if exist "%VENV_PYTHONW%" (
    "%VENV_PYTHONW%" installer.py
) else (
    "%VENV_PYTHON%" installer.py
)
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo  Installer encountered an error.
    echo.
    pause
)
exit
