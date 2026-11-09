param(
    [Parameter(Mandatory=$true)][string]$Path,
    [int]$Depth = 2,
    [string[]]$Exclude = @('node_modules', 'dist', 'target', '.venv', 'vendor', '.cache', 'build', '.next', '.git')
)

if (-not (Test-Path -LiteralPath $Path)) { exit 0 }
$resolvedRoot = (Get-Item -LiteralPath $Path).FullName.TrimEnd('\', '/')

$excludeSet = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
foreach ($item in $Exclude) {
    if (-not [string]::IsNullOrWhiteSpace($item)) {
        # Handle comma-separated lists if passed as a single string
        foreach ($sub in $item.Split(',')) {
            $trimmed = $sub.Trim()
            if ($trimmed) { [void]$excludeSet.Add($trimmed) }
        }
    }
}

function Find-GitRepos([string]$dir, [int]$currentDepth, [int]$maxDepth) {
    if ($currentDepth -gt $maxDepth) { return }

    try {
        $subdirs = [System.IO.Directory]::GetDirectories($dir)
    } catch {
        return
    }

    foreach ($subdir in $subdirs) {
        $name = [System.IO.Path]::GetFileName($subdir)
        if ($excludeSet.Contains($name) -or $name.StartsWith('.')) {
            continue
        }

        # Check if this directory is a git repo (.git folder or file for worktrees/submodules)
        $gitDir = [System.IO.Path]::Combine($subdir, '.git')
        if ([System.IO.Directory]::Exists($gitDir) -or [System.IO.File]::Exists($gitDir)) {
            Write-Output $subdir
            # Stop recursing into an already discovered git repository
        } elseif ($currentDepth -lt $maxDepth) {
            Find-GitRepos -dir $subdir -currentDepth ($currentDepth + 1) -maxDepth $maxDepth
        }
    }
}

Find-GitRepos -dir $resolvedRoot -currentDepth 1 -maxDepth $Depth
