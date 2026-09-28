# Hot-reload gateway config via /config/store (localhost + Bearer key), then verify.
# Body goes through curl.exe with @file — PS 5.1 Invoke-RestMethod mangles UTF-8
# bodies (Get-Content ANSI decode -> invalid JSON upstream).
$ErrorActionPreference = 'Stop'
$key = (Select-String -Path "$PSScriptRoot\..\.env" -Pattern '^GATEWAY_ACCESS_KEY=').Line.Substring('GATEWAY_ACCESS_KEY='.Length).Trim()
$cfgPath = "$PSScriptRoot\..\config.json"
& curl.exe -s -X POST 'http://127.0.0.1:3400/config/store' -H 'Content-Type: application/json' -H "Authorization: Bearer $key" --data "@$cfgPath"
''
$models = Invoke-RestMethod -Headers @{Authorization = "Bearer $key" } -Uri 'http://127.0.0.1:3400/v1/models?type=chat'
"chat models: $($models.data.Count)"
($models.data | Where-Object { $_.id -like 'nvidia*' } | ForEach-Object { "$($_.id) -> $($_.prettyName)" })
