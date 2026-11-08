param(
    [Parameter(Mandatory=$true)][string]$Path,
    [int]$Depth = 2,
    [string[]]$Exclude = @('node_modules', 'dist', 'target', '.venv', 'vendor', '.cache', 'build', '.next')
)

if (-not (Test-Path -LiteralPath $Path)) { exit 0 }

$resolvedRoot = (Get-Item -LiteralPath $Path).FullName.TrimEnd('\', '/')

$excludePattern = [string]::Join('|', ($Exclude | ForEach-Object { [regex]::Escape($_) }))

Get-ChildItem -LiteralPath $resolvedRoot -Depth $Depth -Filter ".git" -Force -ErrorAction SilentlyContinue | ForEach-Object {
    $parent = if ($_.PSIsContainer) { $_.Parent.FullName } else { $_.Directory.FullName }
    if ($parent -and $parent -ne $resolvedRoot) {
        if (-not ($excludePattern -and ($parent -match "[\\/]($excludePattern)[\\/]"))) {
            Write-Output $parent
        }
    }
}
