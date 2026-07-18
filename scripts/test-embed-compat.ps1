# Embedding compatibility probe: OpenRouter vs FATTEN local (both Qwen3-Embedding-4B F16)
# Embeds the same texts through both endpoints, computes cosine similarity.
#
# Usage: Set env vars before running:
#   $env:OPENROUTER_API_KEY = 'sk-or-v1-...'

$ErrorActionPreference = 'Stop'

$orKey = $env:OPENROUTER_API_KEY
if (-not $orKey) { throw 'Set $env:OPENROUTER_API_KEY before running this script' }
$orUrl   = 'https://openrouter.ai/api/v1/embeddings'
$orModel = 'qwen/qwen3-embedding-4b'

$localUrl   = 'http://192.168.0.145:4080/v1/embeddings'
$localModel = 'Qwen/Qwen3-Embedding-4B-GGUF'

$probes = @(
    'The quick brown fox jumps over the lazy dog.'
    'Embedding models map text to dense vectors for semantic similarity search.'
    'Qwen3-Embedding-4B is a multilingual text embedding model with 2560 dimensions.'
)

function Get-Embedding($url, $model, $text, $headers) {
    $bodyObj = @{ model = $model; input = $text }
    $bodyJson = $bodyObj | ConvertTo-Json -Compress
    $r = Invoke-WebRequest -Uri $url -Method Post -Headers $headers `
         -Body $bodyJson -UseBasicParsing -TimeoutSec 30 `
         -ContentType 'application/json'
    ($r.Content | ConvertFrom-Json).data[0].embedding
}

function Cos-Sim($a, $b) {
    $dot = 0.0; $na = 0.0; $nb = 0.0
    for ($i = 0; $i -lt $a.Count; $i++) {
        $dot += $a[$i] * $b[$i]
        $na  += $a[$i] * $a[$i]
        $nb  += $b[$i] * $b[$i]
    }
    return $dot / ([math]::Sqrt($na) * [math]::Sqrt($nb))
}

$orHeaders     = @{ 'Authorization' = "Bearer $orKey" }
$localHeaders  = @{}

Write-Host "Embedding $($probes.Count) probes through each endpoint..." 
Write-Host ''

$orVecs     = @()
$localVecs  = @()

foreach ($t in $probes) {
    Write-Host "  OR    : $t"
    $orVecs += , (Get-Embedding $orUrl $orModel $t $orHeaders)
}
foreach ($t in $probes) {
    Write-Host "  LOCAL : $t"
    $localVecs += , (Get-Embedding $localUrl $localModel $t $localHeaders)
}

Write-Host ''
Write-Host '=== Same-text cosine similarity (OR vs Local) — expect ~1.0 ==='
for ($i = 0; $i -lt $probes.Count; $i++) {
    $sim = Cos-Sim $orVecs[$i] $localVecs[$i]
    '{0,6:F6}  |  {1}' -f $sim, $probes[$i]
}

Write-Host ''
Write-Host '=== Cross-text sanity (different texts, same endpoint) — expect < same-text ==='
$crossLocal = Cos-Sim $localVecs[0] $localVecs[1]
$crossOR    = Cos-Sim $orVecs[0]    $orVecs[1]
'  Local fox vs embedding-desc : {0,6:F6}' -f $crossLocal
'  OR    fox vs embedding-desc : {0,6:F6}' -f $crossOR

Write-Host ''
Write-Host '=== Cross-endpoint cross-text (OR fox vs Local embedding-desc) — sanity ==='
$crossMix = Cos-Sim $orVecs[0] $localVecs[1]
'  OR fox vs Local embedding-desc: {0,6:F6}' -f $crossMix
