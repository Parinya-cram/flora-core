# Flora Root: add device type codes to a tenant's license (called by add-device-types.bat).
# Root keeps, per tenant, the list of device type codes the license allows. PUT
# /api/v1/tenants/<tenant>/license replaces the whole license, so the current one is read first and
# every other field is kept (modules, limits, expiry to the day). Asks before issuing the new license.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File root-license-add-types.ps1 `
#       -Root https://172.22.19.81:8443 -Tenant kcmh -User admin -Codes "code1 code2" [-DryRun]
#
# Password from FLORA_ROOT_PASSWORD, else asked. Uses curl.exe (Windows 10/11) for HTTP. Root usually runs with a self-signed certificate: pass
# -CaCert <file> to verify it; without it the certificate is not checked (-k).
param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$Tenant,
    [Parameter(Mandatory = $true)][string]$User,
    [Parameter(Mandatory = $true)][string]$Codes,
    [string]$CaCert = "",
    [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
$Root = $Root.TrimEnd('/')
[string[]]$tls = if ($CaCert) { '--cacert', $CaCert } else { '-k' }   # always an array: splatting a plain string passes it char by char
$work = Join-Path $env:TEMP 'flora-root-license'
New-Item -ItemType Directory -Force -Path $work | Out-Null
$overviewFile = Join-Path $work 'overview.json'
$bodyFile = Join-Path $work 'license.json'
$resultFile = Join-Path $work 'result.txt'

Write-Host ''
Write-Host "---------------- Flora Root: license of tenant $Tenant ----------------"
# Password: FLORA_ROOT_PASSWORD when set (scripts), else asked without echo.
$pass = $env:FLORA_ROOT_PASSWORD
if (-not $pass) {
    $secure = Read-Host 'Root password' -AsSecureString
    $pass = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
}

$status = & curl.exe -sS @tls -o $overviewFile -w '%{http_code}' -u "${User}:${pass}" "$Root/api/v1/overview"
if ($status -ne '200') {
    Write-Host "Cannot read $Root/api/v1/overview (HTTP $status): check the Root URL, username and password."
    exit 1
}
$overview = Get-Content $overviewFile -Raw -Encoding UTF8 | ConvertFrom-Json
$t = $overview.tenants | Where-Object { $_.tenant_id -eq $Tenant } | Select-Object -First 1
if (-not $t) {
    Write-Host "tenant $Tenant not found at Root (known: $((@($overview.tenants) | ForEach-Object tenant_id) -join ', '))"
    exit 1
}
if (-not $t.bundle_id -or $t.revoked_at) {
    Write-Host "tenant $Tenant has no current license (missing or revoked): issue one at Root first"
    exit 1
}

$current = @($t.device_types | Where-Object { $_ })
$added = @($Codes -split '\s+' | Where-Object { $_ -and ($current -notcontains $_) } | Select-Object -Unique)
$nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$days = 365
if ($t.expires_at) { $days = [Math]::Max(1, [Math]::Min(3650, [Math]::Ceiling(($t.expires_at - $nowMs) / 86400000))) }
$modules = if ($t.modules) { @($t.modules) } else { @('leaf', 'canopy', 'gateway') }
$body = [ordered]@{
    modules             = $modules
    max_leaves          = $t.max_leaves
    max_gateways        = $t.max_gateways
    max_gateway_devices = $t.max_gateway_devices
    device_types        = @($current + $added)
    valid_days          = [int]$days
}
$fmt = { param($ms) if ($ms) { [DateTimeOffset]::FromUnixTimeMilliseconds([long]$ms).LocalDateTime.ToString('yyyy-MM-dd HH:mm') } else { '-' } }
Write-Host "tenant      $($t.tenant_id)  $($t.name)"
Write-Host "license     $($t.bundle_id)  (a new bundle id is issued)"
Write-Host "modules     $($modules -join ', ')   leaves $($t.max_leaves)  gateways $($t.max_gateways)  gateway devices $($t.max_gateway_devices)   (kept)"
Write-Host "expires     $(& $fmt $t.expires_at)  ->  $(& $fmt ($nowMs + $days * 86400000))  ($days days from now)"
Write-Host "types now   $($current.Count)"
if ($added.Count -eq 0) {
    Write-Host 'types add   0  (all picked codes are already licensed)'
    exit 0
}
Write-Host "types add   $($added.Count)"
$added | ForEach-Object { Write-Host "            + $_" }

# UTF-8 without BOM, so Root reads clean JSON.
[IO.File]::WriteAllText($bodyFile, ($body | ConvertTo-Json -Depth 5 -Compress), (New-Object Text.UTF8Encoding $false))
Write-Host "  curl -sS -k -u `"${User}:********`" -X PUT -H `"Content-Type: application/json`" --data-binary @$bodyFile $Root/api/v1/tenants/$Tenant/license"
if ($DryRun) {
    Get-Content $bodyFile -Raw | Write-Host
    Write-Host 'Dry run: the license was not changed.'
    exit 0
}
$answer = Read-Host "Issue the new license for ${Tenant}? [y/N]"
if ($answer -notmatch '^[yY]') {
    Write-Host 'Cancelled: the license was not changed.'
    exit 0
}
$status = & curl.exe -sS @tls -o $resultFile -w '%{http_code}' -u "${User}:${pass}" -X PUT `
    -H 'Content-Type: application/json' --data-binary "@$bodyFile" "$Root/api/v1/tenants/$Tenant/license"
if ($status -eq '200') {
    Write-Host "License issued: $(Get-Content $resultFile -Raw)"
    Write-Host "The tenant's Canopy (Haber) picks it up at its next Root sync; gateways at their next check-in."
    exit 0
}
Write-Host "FAILED (HTTP $status):"
Get-Content $resultFile -Raw | Write-Host
exit 1
