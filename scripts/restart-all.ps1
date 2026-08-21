$ErrorActionPreference = 'Stop'

$root = Resolve-Path (Join-Path $PSScriptRoot '..')
Write-Host "Project root: $root"

function Stop-PortProcess {
    param([int]$Port)
    $lines = netstat -ano | Select-String ":$Port"
    foreach ($line in $lines) {
        $parts = ($line -replace '\s+', ' ').Trim().Split(' ')
        if ($parts.Length -ge 5) {
            $procId = $parts[-1]
            if ($procId -match '^\d+$' -and $procId -ne '0') {
                try {
                    Stop-Process -Id $procId -Force -ErrorAction Stop
                    Write-Host "Stopped PID $procId on port $Port"
                } catch {
                    Write-Host "Skip PID $procId on port ${Port}: $($_.Exception.Message)"
                }
            }
        }
    }
}

Push-Location $root
try {
    Write-Host 'Stopping compose services...'
    docker compose down

    Write-Host 'Starting compose services...'
    docker compose up -d

    Write-Host 'Killing existing app ports 4000 and 4300 if occupied...'
    Stop-PortProcess -Port 4000
    Stop-PortProcess -Port 4300

    $apiCmd = "cd '$root\\apps\\api'; if (!(Test-Path .env)) { Copy-Item .env.example .env }; npm run prisma:generate; npm run start:dev"
    $workerCmd = "cd '$root\\apps\\worker'; if (!(Test-Path .env)) { Copy-Item .env.example .env }; npm run start:dev"

    Write-Host 'Starting API terminal...'
    Start-Process powershell -ArgumentList '-NoExit', '-Command', $apiCmd

    Write-Host 'Starting Worker terminal...'
    Start-Process powershell -ArgumentList '-NoExit', '-Command', $workerCmd

    Write-Host 'Done. Wait 10-20 seconds then test:'
    Write-Host 'API: http://localhost:4000/api/v1/health'
    Write-Host 'Worker: http://localhost:4300/internal/health'
    Write-Host 'Viewer: http://localhost:4000/viewer.html'
}
finally {
    Pop-Location
}
