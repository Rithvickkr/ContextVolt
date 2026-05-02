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
#define MyAppExeName "ContextVolt.vbs"

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
LicenseFile=LICENSE.txt
OutputDir=output
OutputBaseFilename=ContextVolt-Setup
Compression=lzma2/ultra64
SolidCompression=yes
SetupIconFile=..\icon.ico
WizardStyle=modern
WizardSizePercent=120,120
DefaultGroupName={#MyAppName}
PrivilegesRequired=lowest
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayIcon={app}\app\icon.ico
DisableDirPage=no
DisableWelcomePage=no
WizardImageFile=..\main icon\banner.bmp
WizardSmallImageFile=..\main icon\small_logo.bmp

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[CustomMessages]
english.WelcomeLabel1=Welcome to ContextVolt Setup
english.WelcomeLabel2=ContextVolt is your local AI-powered assistant that keeps all your context private — no cloud, no subscriptions.%n%nWhat gets installed:%n%n    Runtime     Embedded Python (no system Python needed)%n    Backend     FastAPI server & local database%n    Dashboard   Browser-based UI%n    Extensions  Browser & VS Code extensions%n%nOllama and the AI model are downloaded automatically on first launch.%n%nClick Next to review the license agreement.
english.FinishedLabel=ContextVolt {#MyAppVersion} has been successfully installed.%n%nYou can launch it any time from the Desktop shortcut or the Start Menu.

[Tasks]

[Files]
; Embedded Python
Source: "build\python\*"; DestDir: "{app}\python"; Flags: ignoreversion recursesubdirs createallsubdirs

; Project files
Source: "build\app\*"; DestDir: "{app}\app"; Flags: ignoreversion recursesubdirs createallsubdirs

; Launcher
Source: "build\ContextVolt.bat"; DestDir: "{app}"; Flags: ignoreversion
Source: "build\ContextVolt.vbs"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
; Start Menu
Name: "{group}\ContextVolt"; Filename: "{app}\ContextVolt.vbs"; WorkingDir: "{app}"; IconFilename: "{app}\app\icon.ico"; Comment: "Launch ContextVolt"
Name: "{group}\Uninstall ContextVolt"; Filename: "{uninstallexe}"

; Desktop — always created
Name: "{userdesktop}\ContextVolt"; Filename: "{app}\ContextVolt.vbs"; WorkingDir: "{app}"; IconFilename: "{app}\app\icon.ico"; Comment: "Launch ContextVolt"

[Run]
; "Launch ContextVolt now" checkbox on finish screen
Filename: "{app}\ContextVolt.vbs"; Description: "Launch ContextVolt now"; Flags: postinstall shellexec skipifsilent unchecked

; "Open GitHub page" link on finish screen
Filename: "{#MyAppURL}"; Description: "Open the GitHub page"; Flags: postinstall shellexec skipifsilent unchecked

[UninstallDelete]
Type: filesandordirs; Name: "{app}\app\venv"
Type: filesandordirs; Name: "{app}\app\__pycache__"
Type: filesandordirs; Name: "{app}\app\context_volt.db"
Type: filesandordirs; Name: "{app}\app\.ollama"

[Code]
procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssInstall then
    WizardForm.StatusLabel.Caption := 'Installing ContextVolt — this may take a moment...';
end;
