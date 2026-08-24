$ErrorActionPreference = 'Stop'

$root = Resolve-Path (Join-Path $PSScriptRoot '..')
Write-Host "Project root: $root"

function Stop-PortProcess {
    param([int]$Port)

    $lines = netstat -ano | Select-String ":$Port"
    foreach ($line in $lines) {
        $parts = ($line -replace '\s+', ' ').Trim().Split(' ')
        if ($parts.Length -lt 5) {
            continue
        }

        $procId = $parts[-1]
        if ($procId -notmatch '^\d+$' -or $procId -eq '0') {
            continue
        }

        try {
            Stop-Process -Id $procId -Force -ErrorAction Stop
            Write-Host "Stopped PID $procId on port $Port"
        } catch {
            Write-Host "Skip PID $procId on port ${Port}: $($_.Exception.Message)"
        }
    }
}

function Wait-HttpReady {
    param(
        [string]$Url,
        [int]$TimeoutSec = 45
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        try {
            Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 5 | Out-Null
            return $true
        } catch {
            Start-Sleep -Milliseconds 700
        }
    }

    return $false
}

Push-Location $root
try {
    Write-Host 'Checking Docker...'
    docker compose version | Out-Null

    Write-Host 'Starting compose services (Postgres + Redis)...'
    docker compose up -d postgres redis

    Write-Host 'Killing existing app ports 4000 and 4300 if occupied...'
    Stop-PortProcess -Port 4000
    Stop-PortProcess -Port 4300

    Write-Host 'Preparing API env and database...'
    Set-Location "$root\apps\api"
    if (!(Test-Path .env)) {
        Copy-Item .env.example .env
        Write-Host 'Created apps/api/.env from .env.example'
    }
    npm run prisma:generate
    npx prisma migrate deploy
    npm run build

    Write-Host 'Preparing Worker env...'
    Set-Location "$root\apps\worker"
    if (!(Test-Path .env)) {
        Copy-Item .env.example .env
        Write-Host 'Created apps/worker/.env from .env.example'
    }
    npm run build

    $apiCmd = "Set-Location '$root\apps\api'; npm run start"
    $workerCmd = "Set-Location '$root\apps\worker'; npm run start"

    Write-Host 'Starting API terminal...'
    Start-Process powershell -ArgumentList '-NoExit', '-Command', $apiCmd

    Write-Host 'Starting Worker terminal...'
    Start-Process powershell -ArgumentList '-NoExit', '-Command', $workerCmd

    Set-Location $root
    Write-Host 'Waiting for API and Worker health endpoints...'
    $apiReady = Wait-HttpReady -Url 'http://localhost:4000/api/v1/health' -TimeoutSec 60
    $workerReady = Wait-HttpReady -Url 'http://localhost:4300/internal/health' -TimeoutSec 60

    if ($apiReady -and $workerReady) {
        Write-Host 'All services are ready.'
        Write-Host 'Play:   http://localhost:4000/play.html'
        Write-Host 'Health: http://localhost:4000/api/v1/health'
        Write-Host 'Worker: http://localhost:4300/internal/health'
    } else {
        Write-Host 'Service startup timed out. Check opened API/Worker terminals for errors.'
    }
}
finally {
    Pop-Location
}
