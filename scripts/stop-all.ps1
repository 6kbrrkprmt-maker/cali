$ErrorActionPreference = 'Continue'

$root = Resolve-Path (Join-Path $PSScriptRoot '..')
Write-Host "Project root: $root"

Push-Location $root
try {
    docker compose down
} finally {
    Pop-Location
}

foreach ($port in 4000, 4300) {
    $lines = netstat -ano | Select-String ":$port"
    foreach ($line in $lines) {
        $parts = ($line -replace '\s+', ' ').Trim().Split(' ')
        if ($parts.Length -ge 5) {
            $procId = $parts[-1]
            if ($procId -match '^\d+$' -and $procId -ne '0') {
                try {
                    Stop-Process -Id $procId -Force -ErrorAction Stop
                    Write-Host "Stopped PID $procId on port $port"
                } catch {
                    Write-Host "Skip PID $procId on port ${port}: $($_.Exception.Message)"
                }
            }
        }
    }
}

Write-Host 'Stopped compose and local API/Worker ports.'
