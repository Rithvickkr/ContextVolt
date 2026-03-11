; ═══════════════════════════════════════════════════════════════════
; ContextVolt — Inno Setup Installer Script
; 
; Prerequisites:
;   1. Run build.ps1 first (downloads Python, prepares build folder)
;   2. Install Inno Setup from https://jrsoftware.org/isinfo.php
;   3. Open this file in Inno Setup → click Compile
;
; Output: ContextVolt-Setup.exe in the installer\output\ folder
; ═══════════════════════════════════════════════════════════════════

#define MyAppName "ContextVolt"
#define MyAppVersion "1.1"
#define MyAppPublisher "ContextVolt"
#define MyAppURL "https://github.com/Rithvickkr/ContextVolt"
#define MyAppExeName "ContextVolt.bat"

[Setup]
AppId={{A3B8D1B6-0B3B-4B1A-9C1A-CONTEXTVOLT-2026}}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}
AppUpdatesURL={#MyAppURL}
DefaultDirName={userappdata}\{#MyAppName}
DisableProgramGroupPage=yes
LicenseFile=
OutputDir=output
OutputBaseFilename=ContextVolt-Setup
Compression=lzma2/ultra64
SolidCompression=yes
SetupIconFile=..\icon.ico
WizardStyle=modern
WizardSizePercent=110,110
DefaultGroupName={#MyAppName}
PrivilegesRequired=lowest
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayIcon={app}\app\icon.ico
DisableWelcomePage=no
WizardImageFile=
WizardSmallImageFile=

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[CustomMessages]
english.WelcomeLabel1=Welcome to ContextVolt Setup
english.WelcomeLabel2=This will install ContextVolt — your local AI-powered context vault for AI conversations.%n%nContextVolt includes:%n  • Backend & dashboard%n  • Embedded Python runtime%n  • Browser extension files%n  • VS Code extension files%n%nAfter installation, ContextVolt will set up Ollama and download the AI model automatically.
english.FinishedLabel=ContextVolt has been installed! Launch it from the Desktop shortcut or Start Menu.

[Files]
; Embedded Python
Source: "build\python\*"; DestDir: "{app}\python"; Flags: ignoreversion recursesubdirs createallsubdirs

; Project files
Source: "build\app\*"; DestDir: "{app}\app"; Flags: ignoreversion recursesubdirs createallsubdirs

; Launcher
Source: "build\ContextVolt.bat"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
; Start Menu
Name: "{group}\ContextVolt"; Filename: "{app}\ContextVolt.bat"; WorkingDir: "{app}"; IconFilename: "{app}\app\icon.ico"; Comment: "Launch ContextVolt"
Name: "{group}\Uninstall ContextVolt"; Filename: "{uninstallexe}"

; Desktop (always created)
Name: "{userdesktop}\ContextVolt"; Filename: "{app}\ContextVolt.bat"; WorkingDir: "{app}"; IconFilename: "{app}\app\icon.ico"; Comment: "Launch ContextVolt"

[Tasks]
Name: "desktopicon"; Description: "Create a Desktop shortcut"; GroupDescription: "Additional shortcuts:"

[Run]
; No auto-launch — user launches from Desktop shortcut after install

[UninstallDelete]
; Clean up generated files on uninstall
Type: filesandordirs; Name: "{app}\app\venv"
Type: filesandordirs; Name: "{app}\app\__pycache__"
Type: filesandordirs; Name: "{app}\app\context_volt.db"
Type: filesandordirs; Name: "{app}\app\.ollama"

[Code]
procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssInstall then
    WizardForm.StatusLabel.Caption := 'Extracting ContextVolt files...';
end;
