#requires -Version 7.0
[CmdletBinding()]
param(
    [ValidateSet('Install', 'Status', 'Start')]
    [string]$Action = 'Status'
)

$ErrorActionPreference = 'Stop'
$runtime = Join-Path $PSScriptRoot '.appearance'
$dshHome = Join-Path $runtime 'dsh-home'
$profile = Join-Path $dshHome 'profiles/dsh-tui'
$hostName = '@deepseek-harness-tui/dsh-tui'
$backendName = 'dsh-tui-backend-antigravity'
$hostVersion = '0.20.2'
$backendVersion = '0.5.3-rc.1'
$dshVersion = '0.2.2-rc.1'
$hostPackage = Join-Path $profile "node_modules/$hostName"
$overlay = Join-Path $PSScriptRoot "host-$hostVersion.patch"
$backendArchive = Join-Path $PSScriptRoot "$backendName-$backendVersion.tgz"
$receipt = Join-Path $runtime 'installed.json'

function Invoke-Checked {
    param([string]$Command, [string[]]$Arguments)
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Command failed (exit $LASTEXITCODE)." }
}

function Read-Manifest([string]$Directory) {
    Get-Content -Raw -LiteralPath (Join-Path $Directory 'package.json') | ConvertFrom-Json
}

function Assert-Profile {
    $hostManifest = Read-Manifest $hostPackage
    $backendManifest = Read-Manifest (Join-Path $profile "node_modules/$backendName")
    if ($hostManifest.name -ne $hostName -or $hostManifest.version -ne $hostVersion -or
        $hostManifest.antigravityAppearancePreview -ne $backendVersion -or
        $backendManifest.name -ne $backendName -or $backendManifest.version -ne $backendVersion -or
        !(Test-Path -LiteralPath (Join-Path $hostPackage 'assets/gemini/img/typing/00.png') -PathType Leaf)) {
        throw 'The appearance profile no longer matches this bundle. Extract and install the bundle in a new folder.'
    }
}

function Assert-Installed {
    if (!(Test-Path -LiteralPath $receipt -PathType Leaf)) {
        throw 'Appearance preview is not installed. Run Install from a freshly extracted bundle.'
    }
    Assert-Profile
}

if (!$IsWindows) { throw 'This appearance preview is for Windows only.' }
if ($Action -eq 'Status') {
    Assert-Installed
    Write-Output "Ready: appearance preview $backendVersion; dsh-TUI $hostVersion; profile $profile"
    return
}

$savedEnv = @{}
foreach ($key in @(
    'DSH_HOME', 'DSH_TUI_PROFILE', 'DSH_TUI_APPEARANCE_PINNED', 'DSH_TUI_APPEARANCE_DATA_DIR',
    'DSH_TUI_SESSION_ROOT', 'DSH_TUI_UPDATE_ENGINE',
    'DSH_TUI_UPDATE_LAUNCHER', 'DSH_TUI_HOST_ENTRY_PATH', 'DSH_TUI_LAUNCHER_PATH',
    'DSH_TUI_LAUNCHER_VERSION', 'DSH_BOOTSTRAP_PATH', 'DSH_BUNDLED_SKILL_DIR',
    'npm_config_auto_install_peers', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_CEILING_DIRECTORIES'
)) {
    $savedEnv[$key] = [Environment]::GetEnvironmentVariable($key)
}

try {
    $node = Get-Command node.exe -CommandType Application | Select-Object -First 1
    $dsh = Get-Command dsh -CommandType Application,ExternalScript | Select-Object -First 1
    if (!$dsh) { throw 'Install DSH CLI first.' }
    $env:DSH_HOME = $dshHome
    $env:DSH_TUI_PROFILE = 'dsh-tui'
    $env:DSH_TUI_APPEARANCE_PINNED = '1'
    $env:DSH_TUI_APPEARANCE_DATA_DIR = Join-Path $runtime 'tui-data'
    $env:DSH_TUI_SESSION_ROOT = $null
    $env:DSH_TUI_UPDATE_ENGINE = '0'
    $env:DSH_TUI_UPDATE_LAUNCHER = '0'
    foreach ($key in @('DSH_TUI_HOST_ENTRY_PATH', 'DSH_TUI_LAUNCHER_PATH',
        'DSH_TUI_LAUNCHER_VERSION', 'DSH_BOOTSTRAP_PATH', 'DSH_BUNDLED_SKILL_DIR')) {
        [Environment]::SetEnvironmentVariable($key, $null)
    }
    $engineVersion = (Invoke-Checked $dsh.Source @('--version') | Out-String).Trim()
    if ($engineVersion -ne $dshVersion) { throw "This bundle was built for DSH $dshVersion. Found $engineVersion; DSH was not modified." }

    if ($Action -eq 'Start') {
        Assert-Installed
        Invoke-Checked $node.Source @((Join-Path $hostPackage 'bin/dsh-tui.js'), '--backend', 'antigravity')
        return
    }
    if (Test-Path -LiteralPath $receipt -PathType Leaf) {
        Assert-Installed
        Write-Output "Already installed: $profile"
        return
    }
    if (Test-Path -LiteralPath $runtime) { throw 'A previous install is incomplete. Extract the bundle into a new folder and retry.' }
    $git = Get-Command git.exe -CommandType Application | Select-Object -First 1
    $tar = Get-Command tar.exe -CommandType Application | Select-Object -First 1
    $null = Get-Command pnpm -CommandType Application,ExternalScript
    foreach ($file in @($overlay, $backendArchive, (Join-Path $PSScriptRoot 'assets/gemini/frames.json'))) {
        if (!(Test-Path -LiteralPath $file -PathType Leaf)) { throw "Bundle file missing: $file" }
    }
    $nodeVersion = [version]((Invoke-Checked $node.Source @('-p', 'process.versions.node') | Out-String).Trim())
    if (!(($nodeVersion.Major -eq 22 -and $nodeVersion.Minor -ge 19) -or $nodeVersion.Major -ge 24)) {
        throw "Node.js 22.19+ (22.x) or 24+ required. Found $nodeVersion."
    }

    $null = New-Item -ItemType Directory -Path $runtime
    $stage = Join-Path $runtime 'source'
    $null = New-Item -ItemType Directory -Path $stage
    $stockArchive = Join-Path $runtime "dsh-tui-$hostVersion.stock.tgz"
    $appearanceArchive = Join-Path $runtime "dsh-tui-$hostVersion.antigravity-appearance.tgz"
    $officialUrl = "https://registry.npmjs.org/@deepseek-harness-tui/dsh-tui/-/dsh-tui-$hostVersion.tgz"
    Write-Output "Downloading official dsh-TUI $hostVersion from npm..."
    Invoke-WebRequest -Uri $officialUrl -OutFile $stockArchive -TimeoutSec 120
    # npm dist.integrity for the exact upstream archive this patch targets.
    $hash = (Get-FileHash -Algorithm SHA512 -LiteralPath $stockArchive).Hash
    $distIntegrity = [Convert]::FromBase64String('IREY2vEdz5cdRriiSHjCysOf55u/eRcnrXEarQIn32t+P4fxDZRfixhIbxydij1tUDIZ03A/2Su59xFW3j6IDA==')
    $expectedHash = [BitConverter]::ToString($distIntegrity).Replace('-', '')
    if ($hash -cne $expectedHash) {
        throw 'The upstream dsh-TUI archive does not match npm dist.integrity.'
    }
    Invoke-Checked $tar.Source @('-xzf', $stockArchive, '-C', $stage)
    $stageHost = Join-Path $stage 'package'
    $stock = Read-Manifest $stageHost
    if ($stock.name -ne $hostName -or $stock.version -ne $hostVersion) { throw 'Unexpected upstream host package.' }

    # Treat the unpacked tree as a standalone work area even when the ZIP was
    # extracted inside another Git checkout. Never patch profile/store files.
    $env:GIT_CEILING_DIRECTORIES = $stage
    $env:GIT_DIR = $null
    $env:GIT_WORK_TREE = $null
    Invoke-Checked $git.Source @('-C', $stageHost, '-c', 'core.autocrlf=false', 'apply', '--whitespace=nowarn', $overlay)
    if (!(Test-Path -LiteralPath (Join-Path $stageHost 'lib/types/components/sidePanel/companion/geminiPolicy.js') -PathType Leaf)) {
        throw 'The appearance patch did not apply.'
    }
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'assets/gemini') -Destination (Join-Path $stageHost 'assets') -Recurse
    $stock | Add-Member -NotePropertyName antigravityAppearancePreview -NotePropertyValue $backendVersion
    $stock | ConvertTo-Json -Depth 100 | Set-Content -Encoding utf8 -LiteralPath (Join-Path $stageHost 'package.json')
    Invoke-Checked $tar.Source @('-czf', $appearanceArchive, '-C', $stage, 'package')

    $env:npm_config_auto_install_peers = 'false'
    Write-Output "Installing into the separate appearance profile: $profile"
    Invoke-Checked $dsh.Source @('plugin', '--profile', 'dsh-tui', 'add', $appearanceArchive)
    Invoke-Checked $dsh.Source @('plugin', '--profile', 'dsh-tui', 'add', $backendArchive)
    Assert-Profile
    @{host=$hostVersion; backend=$backendVersion} | ConvertTo-Json | Set-Content -Encoding utf8 -LiteralPath $receipt
    Write-Output "Ready: pwsh -NoProfile -File `"$PSCommandPath`" -Action Start"
}
finally {
    foreach ($key in $savedEnv.Keys) { [Environment]::SetEnvironmentVariable($key, $savedEnv[$key]) }
}
